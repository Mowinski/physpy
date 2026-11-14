import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { mathSymbols } from "./mathSymbols";
import { matrixConcealField } from "./matrixConceal";
import { symbolCompletions } from "./completion";
import { constLinter } from "./constLint";
import { createPythonAssistExtension, type PythonAssistProvider } from "./pythonAssist";
import { debugLineField, setDebugLine } from "./debuggerExtension";

export { setDebugLine };

const indentConfigCompartment = new Compartment();
let defaultUseTabs = false;
let defaultTabSize = 4;

function buildIndentExtensions(useTabs: boolean, tabSize: number): Extension[] {
  const safeSize = Math.max(1, Math.min(16, Math.round(tabSize || 4)));
  const unit = useTabs ? "\t" : " ".repeat(safeSize);
  return [indentUnit.of(unit), EditorState.tabSize.of(safeSize)];
}

export function setGlobalIndentConfig(useTabs: boolean, tabSize: number): void {
  defaultUseTabs = useTabs;
  defaultTabSize = Math.max(1, Math.min(16, Math.round(tabSize || 4)));
}

export function reconfigureEditorIndent(view: EditorView, useTabs: boolean, tabSize: number): void {
  view.dispatch({
    effects: indentConfigCompartment.reconfigure(buildIndentExtensions(useTabs, tabSize)),
  });
}

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange?: (doc: string) => void;
  onBlur?: () => void;
  keys?: { key: string; run: () => boolean }[];
  pythonAssist?: PythonAssistProvider;
}

export function createEditor({
  parent,
  doc,
  onChange,
  onBlur,
  keys = [],
  pythonAssist,
}: EditorOptions): EditorView {
  const extensions: Extension[] = [
    keymap.of(keys.map((k) => ({ key: k.key, run: k.run, preventDefault: true }))),
    basicSetup,
    keymap.of([indentWithTab]),
    indentConfigCompartment.of(buildIndentExtensions(defaultUseTabs, defaultTabSize)),
    python(),
    symbolCompletions,
    ...(pythonAssist ? createPythonAssistExtension(pythonAssist) : []),
    mathSymbols,
    matrixConcealField,
    constLinter,
    debugLineField,
    oneDark,
    EditorView.domEventHandlers({
      blur: () => {
        onBlur?.();
        return false;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.(u.state.doc.toString());
    }),
  ];
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/** Editable plain-text editor (e.g. for raw CSV/text view). */
export function createPlainTextEditor({ parent, doc, onChange, onBlur, keys = [] }: EditorOptions): EditorView {
  const extensions: Extension[] = [
    keymap.of(keys.map((k) => ({ key: k.key, run: k.run, preventDefault: true }))),
    basicSetup,
    keymap.of([indentWithTab]),
    indentConfigCompartment.of(buildIndentExtensions(defaultUseTabs, defaultTabSize)),
    oneDark,
    EditorView.domEventHandlers({
      blur: () => {
        onBlur?.();
        return false;
      },
    }),
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
