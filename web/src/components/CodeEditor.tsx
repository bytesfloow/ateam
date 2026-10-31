import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { EditorView } from '@codemirror/view';

export type CodeLanguage = 'markdown' | 'javascript' | 'python' | 'json' | 'text';

export interface CodeEditorHandle {
  insertAtCursor: (text: string) => void;
  focus: () => void;
}

interface CodeEditorProps {
  value: string;
  language: CodeLanguage;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  height?: string;
}

const editorTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    backgroundColor: '#fbfcfe',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    padding: '10px 0',
    caretColor: 'var(--accent, #4c6fef)',
  },
  '.cm-gutters': {
    backgroundColor: '#f6f8fc',
    borderRight: '1px solid rgba(28, 39, 76, 0.08)',
    color: '#9aa4b8',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(76, 111, 239, 0.055)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(76, 111, 239, 0.08)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
  },
});

function languageExtensions(language: CodeLanguage) {
  switch (language) {
    case 'markdown':
      return [markdown()];
    case 'javascript':
      return [javascript({ jsx: true, typescript: true })];
    case 'python':
      return [python()];
    case 'json':
      return [json()];
    default:
      return [];
  }
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { value, language, onChange, readOnly, placeholder, height = '460px' },
  ref,
) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor(text: string) {
        const view = editorRef.current?.view;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        view.focus();
      },
      focus() {
        editorRef.current?.view?.focus();
      },
    }),
    [],
  );

  const extensions = useMemo(() => [...languageExtensions(language), editorTheme, EditorView.lineWrapping], [language]);

  return (
    <div className="code-editor">
      <CodeMirror
        ref={editorRef}
        value={value}
        height={height}
        theme="light"
        readOnly={readOnly}
        placeholder={placeholder}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
        }}
        onChange={onChange}
      />
    </div>
  );
});