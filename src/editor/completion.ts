import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { pythonLanguage } from "@codemirror/lang-python";
import { SYMBOLS } from "./symbols";

const OPTIONS = Object.entries(SYMBOLS).map(([name, char]) => ({
  label: `\\${name}`,
  detail: char,
  type: "variable",
}));

/** Typing `\rh` suggests `\rho  ρ`. */
function symbolCompletion(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\\[A-Za-z]*/);
  if (!word) return null;
  return { from: word.from, options: OPTIONS, validFor: /^\\[A-Za-z]*$/ };
}

export const symbolCompletions = pythonLanguage.data.of({ autocomplete: symbolCompletion });
