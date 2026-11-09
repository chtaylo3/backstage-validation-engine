import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const editorState = {
  selected: undefined as string | undefined,
  trusted: true,
  messages: [] as string[],
  shown: 0,
  commands: new Map<string, (...args: unknown[]) => Promise<unknown> | void>(),
  changes: new Set<(event: { affectsConfiguration: (key: string) => boolean }) => void>(),
  activeEditor: undefined as Editor | undefined,
  documents: [] as EditorDocument[],
  pickers: [] as QuickPick[],
  cancellations: [] as CancellationTokenSource[],
  clipboard: [] as string[],
  clipboardError: undefined as Error | undefined,
  information: [] as string[],
};
export class MemoryState {
  readonly values = new Map<string, unknown>();
  keys() {
    return [...this.values.keys()];
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  update(key: string, value: unknown) {
    this.values.set(key, value);
    return Promise.resolve();
  }
}
export class Uri {
  private constructor(private readonly value: URL) {}
  static file(value: string) {
    return new Uri(pathToFileURL(path.resolve(value)));
  }
  static parse(value: string) {
    return new Uri(new URL(value));
  }
  get scheme() {
    return this.value.protocol.slice(0, -1);
  }
  get fsPath() {
    return fileURLToPath(this.value);
  }
  toString() {
    return this.value.href;
  }
}
export class EditorDocument {
  version = 1;
  isClosed = false;
  languageId = 'yaml';
  constructor(
    readonly uri: Uri,
    private readonly text = 'kind: Component',
  ) {}
  getText() {
    return this.text;
  }
}
export class Editor {
  readonly selection = { start: 0, end: 0 };
  readonly replacements: { selection: unknown; value: string }[] = [];
  editResult = true;
  editError: Error | undefined;
  constructor(readonly document: EditorDocument) {}
  edit(action: (builder: { replace(selection: unknown, value: string): void }) => void) {
    if (this.editError) return Promise.reject(this.editError);
    action({
      replace: (selection, value) => this.replacements.push({ selection, value }),
    });
    return Promise.resolve(this.editResult);
  }
}
type PickerItem = { label: string; description?: string; reference?: string };
export class QuickPick {
  title = '';
  placeholder = '';
  matchOnDescription = false;
  items: PickerItem[] = [];
  selectedItems: PickerItem[] = [];
  busy = false;
  shown = false;
  disposed = false;
  readonly changes = new Set<(value: string) => void>();
  readonly accepts = new Set<() => void>();
  readonly hides = new Set<() => void>();
  onDidChangeValue(listener: (value: string) => void) {
    this.changes.add(listener);
    return { dispose: () => this.changes.delete(listener) };
  }
  onDidAccept(listener: () => void) {
    this.accepts.add(listener);
    return { dispose: () => this.accepts.delete(listener) };
  }
  onDidHide(listener: () => void) {
    this.hides.add(listener);
    return { dispose: () => this.hides.delete(listener) };
  }
  change(value: string) {
    for (const listener of this.changes) listener(value);
  }
  accept(item = this.items[0]) {
    this.selectedItems = item ? [item] : [];
    for (const listener of this.accepts) listener();
  }
  hide() {
    this.shown = false;
    for (const listener of this.hides) listener();
  }
  show() {
    this.shown = true;
  }
  dispose() {
    this.disposed = true;
  }
}
export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false };
  disposed = false;
  constructor() {
    editorState.cancellations.push(this);
  }
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {
    this.disposed = true;
  }
}
export const workspace = {
  get isTrusted() {
    return editorState.trusted;
  },
  get textDocuments() {
    return editorState.documents;
  },
  getConfiguration: () => ({ inspect: () => ({ globalValue: editorState.selected }) }),
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration: (key: string) => boolean }) => void,
  ) {
    editorState.changes.add(listener);
    return {
      dispose: () => {
        editorState.changes.delete(listener);
      },
    };
  },
};
export const commands = {
  registerCommand(id: string, action: (...args: unknown[]) => Promise<unknown> | void) {
    editorState.commands.set(id, action);
    return {
      dispose: () => {
        editorState.commands.delete(id);
      },
    };
  },
};
export const window = {
  get activeTextEditor() {
    return editorState.activeEditor;
  },
  createQuickPick: () => {
    const picker = new QuickPick();
    editorState.pickers.push(picker);
    return picker;
  },
  showInformationMessage: (text: string) => {
    editorState.information.push(text);
    return Promise.resolve(undefined);
  },
  createOutputChannel: () => ({
    info: (text: string) => editorState.messages.push(text),
    error: (text: string) => editorState.messages.push(text),
    show: () => {
      editorState.shown++;
    },
    dispose: () => {},
  }),
};
export const env = {
  clipboard: {
    writeText: (text: string) => {
      if (editorState.clipboardError) return Promise.reject(editorState.clipboardError);
      editorState.clipboard.push(text);
      return Promise.resolve();
    },
  },
};
