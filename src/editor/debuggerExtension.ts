import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/**
 * StateEffect to set or clear the currently paused line in the editor.
 * Line is 1-based. Pass null to clear.
 */
export const setDebugLine = StateEffect.define<number | null>();

const debugLineDeco = Decoration.line({
  class: "cm-debug-active-line",
  attributes: { "data-debug-current": "true" },
});

export const debugLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const e of tr.effects) {
      if (e.is(setDebugLine)) {
        if (e.value === null || e.value <= 0) {
          return Decoration.none;
        }
        const lineNo = Math.min(e.value, tr.state.doc.lines);
        const line = tr.state.doc.line(lineNo);
        return Decoration.set([debugLineDeco.range(line.from)]);
      }
    }
    if (tr.docChanged) {
      return decorations.map(tr.changes);
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});
