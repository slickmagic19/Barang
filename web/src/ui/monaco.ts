// Lazy Monaco loader with Vite-friendly web workers. Importing this module
// costs nothing until load() is called (dynamic import => separate chunk).
export async function load(): Promise<typeof import('monaco-editor')> {
  const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    import('monaco-editor/esm/vs/language/json/json.worker?worker'),
    import('monaco-editor/esm/vs/language/css/css.worker?worker'),
    import('monaco-editor/esm/vs/language/html/html.worker?worker'),
    import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
  ]);
  (self as unknown as Record<string, unknown>).MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === 'json') return new jsonWorker.default();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker.default();
      if (label === 'html') return new htmlWorker.default();
      if (label === 'typescript' || label === 'javascript') return new tsWorker.default();
      return new editorWorker.default();
    },
  };
  return monaco;
}
