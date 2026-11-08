import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const editorState = {
  selected: undefined as string | undefined,
  trusted: true,
  messages: [] as string[],
  shown: 0,
  commands: new Map<string, () => Promise<unknown> | void>(),
  changes: new Set<(event: { affectsConfiguration: (key: string) => boolean }) => void>(),
};
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
export const workspace = {
  get isTrusted() {
    return editorState.trusted;
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
  registerCommand(id: string, action: () => Promise<unknown> | void) {
    editorState.commands.set(id, action);
    return {
      dispose: () => {
        editorState.commands.delete(id);
      },
    };
  },
};
export const window = {
  createOutputChannel: () => ({
    info: (text: string) => editorState.messages.push(text),
    error: (text: string) => editorState.messages.push(text),
    show: () => {
      editorState.shown++;
    },
    dispose: () => {},
  }),
};
