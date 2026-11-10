import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { abortable } from '../providers/async.js';
import { CompletionService } from './completion.js';
import { EditorService } from './editor.js';
import { BuiltinValidationService } from '../host/builtin-validation.js';
import { capabilityAuthorityDigest } from '../capabilities/bindings.js';
import type { LspConfig } from './config.js';
import type { FilesystemSource } from './filesystem.js';
import { CatalogRefresh } from './catalog-refresh.js';
import { SessionOperations } from './request-context.js';

export interface SessionRegistration {
  dispose(): void | Promise<void>;
}

export interface LspServerResources {
  readonly config: LspConfig;
  readonly catalog?: { readonly provider: CatalogProvider; readonly access: CatalogAccessContext };
  readonly filesystem?: FilesystemSource;
  /** The host owns provider/filesystem cleanup through this aggregate finalizer. */
  readonly dispose?: () => Promise<void>;
}
async function bounded<T>(work: Promise<T>, remaining: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Session cleanup deadline exceeded.')),
          Math.max(0, remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** A complete resource generation. Provider cleanup remains with its supplied host owner. */
export class SessionGeneration {
  readonly operations = new SessionOperations();
  readonly completion: CompletionService;
  readonly editor: EditorService;
  readonly validation: BuiltinValidationService;
  readonly refresh: CatalogRefresh | undefined;
  private readonly registrations = new Set<SessionRegistration>();
  private disposal: Promise<void> | undefined;
  private retired = false;
  private registrationFailed = false;
  constructor(
    readonly generation: number,
    private readonly resources: LspServerResources,
    private readonly closeMs = 5000,
    private readonly cleanupFailed: () => void = () => {},
    dependencyChanged: () => void = () => {},
  ) {
    if (!!resources.config.filesystem !== !!resources.filesystem)
      throw new Error('Invalid host resources.');
    this.refresh = resources.catalog
      ? new CatalogRefresh(resources.catalog, dependencyChanged)
      : undefined;
    this.completion = new CompletionService(resources.config, this.catalog, undefined, {
      dependencyGeneration: () => this.refresh?.generation ?? 0,
      sessionGeneration: generation,
    });
    const authorityContextDigest = capabilityAuthorityDigest(
      resources.config.identity,
      this.catalog,
    );
    this.editor = new EditorService(resources.config, undefined, {
      sessionGeneration: generation,
      authorityContextDigest,
      dependencyGeneration: () => this.refresh?.generation ?? 0,
    });
    this.validation = new BuiltinValidationService(resources.config, generation);
  }
  get config() {
    return this.resources.config;
  }
  get catalog() {
    return this.refresh?.catalog ?? this.resources.catalog;
  }
  get filesystem() {
    return this.resources.filesystem;
  }
  get closed() {
    return this.retired;
  }
  get status() {
    return Object.freeze({
      closed: this.retired,
      operations: this.operations.size,
      registrations: this.registrations.size,
      registrationFailed: this.registrationFailed,
    });
  }
  own(registration: SessionRegistration | Promise<SessionRegistration> | void): void {
    if (!registration) return;
    void Promise.resolve(registration).then(
      (resource) => {
        if (this.retired) {
          void Promise.resolve()
            .then(() => resource.dispose())
            .catch(() => {
              this.registrationFailed = true;
              this.cleanupFailed();
            });
        } else this.registrations.add(resource);
      },
      () => {
        /* No registration was created. The adapter reports watcher availability. */
      },
    );
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.retired = true;
    this.operations.cancel();
    this.editor.invalidate();
    this.completion.invalidate();
    this.disposal = (async () => {
      const deadline = performance.now() + this.closeMs;
      const draining = await bounded(
        Promise.allSettled([
          this.operations.drain(),
          this.refresh?.close(),
          this.completion.close(),
          this.editor.close(),
          this.validation.close(),
        ]),
        deadline - performance.now(),
      ).then(
        (outcomes) => outcomes.every((outcome) => outcome.status === 'fulfilled'),
        () => false,
      );
      const cleanup: Promise<unknown>[] = [...this.registrations].map((resource) =>
        Promise.resolve().then(() => resource.dispose()),
      );
      this.registrations.clear();
      cleanup.push(Promise.resolve().then(() => this.resources.dispose?.()));
      const outcomes = await Promise.all(
        cleanup.map((work) =>
          bounded(work, deadline - performance.now()).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (!draining || outcomes.some((success) => !success) || this.registrationFailed)
        throw new Error('Session cleanup failed.');
    })();
    return this.disposal;
  }
}
export interface SessionPorts {
  readonly invalidate: () => void;
  readonly dependencyChanged?: () => void;
  readonly pause: () => Promise<void>;
  readonly commit: (session: SessionGeneration) => void;
  readonly activated: (session: SessionGeneration) => Promise<void> | void;
  readonly resume: () => void;
  readonly ready: () => void;
}
/** Serialized fail-closed replacement with one synchronous activation commit point. */
export class SessionResources {
  private sequence = 0;
  private active: SessionGeneration;
  private usable = true;
  private terminal = false;
  private failed = false;
  private prepared: SessionGeneration | undefined;
  private readonly shutdown = new AbortController();
  private reloading: Promise<{ reloaded: boolean }> | undefined;
  private again = false;
  private disposal: Promise<void> | undefined;
  constructor(
    initial: LspServerResources,
    private readonly ports: SessionPorts,
    private readonly load?: () => Promise<LspServerResources>,
    private readonly closeMs = 5000,
  ) {
    this.active = this.createGeneration(initial);
  }
  private createGeneration(resources: LspServerResources): SessionGeneration {
    return new SessionGeneration(
      this.sequence,
      resources,
      this.closeMs,
      () => {
        this.failed = true;
        this.usable = false;
        this.active.operations.cancel();
        if (!this.terminal) {
          try {
            this.ports.invalidate();
          } catch {
            // The session already requires reconnection; no adapter error escapes cleanup.
          }
        }
      },
      () => this.ports.dependencyChanged?.(),
    );
  }
  get current() {
    return this.active;
  }
  get available() {
    return this.usable && !this.terminal && !this.failed;
  }
  get stopped() {
    return this.terminal;
  }
  get cleanupFailed() {
    return this.failed;
  }
  reload(): Promise<{ reloaded: boolean }> {
    if (this.terminal || !this.load || this.failed) return Promise.resolve({ reloaded: false });
    if (this.reloading) {
      this.again = true;
      return this.reloading;
    }
    this.usable = false;
    this.ports.invalidate();
    this.active.operations.cancel();
    const pausing = this.ports.pause();
    this.reloading = (async () => {
      let replacement: LspServerResources | undefined;
      let candidate: SessionGeneration | undefined;
      let activated = false;
      try {
        replacement = await abortable<LspServerResources>(
          Promise.resolve().then(() => this.load!()),
          this.shutdown.signal,
          (late) => {
            void this.disposeAbandoned(late);
          },
        );
        const previous = this.active;
        const config = replacement.config;
        if (
          config.source.rootUri !== previous.config.source.rootUri ||
          !!config.filesystem !== !!previous.config.filesystem ||
          (!config.filesystem &&
            JSON.stringify(config.source.files.map((file) => file.uri).sort()) !==
              JSON.stringify(previous.config.source.files.map((file) => file.uri).sort()))
        )
          throw new Error('The client must reconnect after a source scope change.');
        this.sequence++;
        candidate = this.createGeneration(replacement);
        this.prepared = candidate;
        replacement = undefined;
        await bounded(pausing, this.closeMs);
        await previous.close().catch(() => {
          this.failed = true;
          throw new Error('Retired resource cleanup failed.');
        });
        if (this.terminal || this.failed) return { reloaded: false };
        // No asynchronous work can observe half of this activation while requests are unavailable.
        this.active = candidate;
        this.prepared = undefined;
        this.ports.commit(candidate);
        await this.ports.activated(candidate);
        if (this.terminal || this.failed) return { reloaded: false };
        this.usable = true;
        this.ports.resume();
        this.ports.ready();
        candidate = undefined;
        activated = true;
        return { reloaded: true };
      } catch {
        this.usable = false;
        return { reloaded: false };
      } finally {
        if (this.prepared === candidate) this.prepared = undefined;
        if (candidate)
          await candidate.close().catch(() => {
            this.failed = true;
          });
        if (replacement) await this.disposeAbandoned(replacement);
        this.reloading = undefined;
        if (!this.terminal) {
          if (!activated) {
            try {
              this.ports.invalidate();
              this.ports.resume();
            } catch {
              this.failed = true;
            }
          }
          if (this.again) {
            this.again = false;
            queueMicrotask(() => {
              void this.reload();
            });
          }
        }
      }
    })();
    return this.reloading;
  }
  private async disposeAbandoned(resources: LspServerResources): Promise<void> {
    await bounded(
      Promise.resolve().then(() => resources.dispose?.()),
      this.closeMs,
    ).catch(() => {
      this.failed = true;
    });
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.terminal = true;
    this.usable = false;
    this.shutdown.abort();
    this.active.operations.cancel();
    this.active.editor.invalidate();
    this.active.completion.invalidate();
    this.disposal = (async () => {
      const outcomes = await bounded(
        Promise.allSettled([Promise.resolve().then(() => this.ports.pause()), this.reloading]),
        this.closeMs,
      ).catch(() => [
        { status: 'rejected' as const, reason: new Error('Session close deadline exceeded.') },
      ]);
      const owners = new Set([this.active, ...(this.prepared ? [this.prepared] : [])]);
      const closed = (
        await Promise.all(
          [...owners].map((owner) =>
            owner.close().then(
              () => true,
              () => false,
            ),
          ),
        )
      ).every(Boolean);
      if (!closed || this.failed || outcomes.some((outcome) => outcome.status === 'rejected'))
        throw new Error('Session cleanup failed.');
    })();
    return this.disposal;
  }
}
