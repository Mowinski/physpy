import { basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { mathSymbols } from "./mathSymbols";
import { symbolCompletions } from "./completion";

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange?: (doc: string) => void;
  keys?: { key: string; run: () => boolean }[];
}

export function createEditor({ parent, doc, onChange, keys = [] }: EditorOptions): EditorView {
  const extensions: Extension[] = [
    keymap.of(keys.map((k) => ({ key: k.key, run: k.run, preventDefault: true }))),
    basicSetup,
    python(),
    symbolCompletions,
    mathSymbols,
    oneDark,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.(u.state.doc.toString());
    }),
  ];
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/** Read-only viewer for the generated Python. */
export function createViewer(parent: HTMLElement): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [basicSetup, python(), oneDark, EditorState.readOnly.of(true), EditorView.editable.of(false)],
    }),
  });
}

export function setDoc(view: EditorView, doc: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
}
