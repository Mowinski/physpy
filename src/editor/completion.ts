import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { pythonLanguage } from "@codemirror/lang-python";
import { ACCENTS, PHYSICAL_CONSTANTS, SYMBOLS } from "./symbols";

const ACCENT_PREVIEW: Record<string, string> = {
  bar: "x̄ (kreska nad)",
  overline: "x̄ (długa kreska nad)",
  hat: "x̂ (daszek)",
  vec: "x⃗ (wektor)",
  dot: "ẋ (kropka)",
  ddot: "ẍ (dwie kropki)",
  tilde: "x̃ (tylda)",
  prime: "x' (prim)",
  dprime: "x'' (bis / podwójny prim)",
};

const OPTIONS: Completion[] = [
  ...Object.entries(SYMBOLS).map(([name, char]) => ({
    label: `\\${name}`,
    detail: char,
    type: "variable",
  })),
  ...Object.keys(ACCENTS).map((name) => ({
    label: `\\${name}{}`,
    detail: ACCENT_PREVIEW[name] ?? name,
    type: "variable",
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      const text = `\\${name}{}`;
      const cursor = from + text.length - 1;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: cursor },
      });
    },
  })),
  ...Object.entries(PHYSICAL_CONSTANTS).map(([name, info]) => ({
    label: `\\const{${name}}`,
    detail: `${info.value} ${info.unit} — ${info.label}`,
    type: "constant",
  })),
  {
    label: "\\i",
    detail: "i (imaginary unit 1j)",
    type: "constant",
  },
];

/** Typing `\rh` suggests `\rho  ρ`. */
function symbolCompletion(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\\[A-Za-z]*/);
  if (!word) return null;
  return { from: word.from, options: OPTIONS, validFor: /^\\[A-Za-z]*$/ };
}

export const symbolCompletions = pythonLanguage.data.of({ autocomplete: symbolCompletion });
