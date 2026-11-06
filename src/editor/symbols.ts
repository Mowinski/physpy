import symbolTable from "../../transpiler/src/physpy/symbols.json";

/** LaTeX-like name -> display character. Single source of truth shared with the Python transpiler. */
export const SYMBOLS: Record<string, string> = symbolTable;

/** Matches `\rho`, `\rho_0`, `\omega_max` ... (same regex as transpiler/src/physpy/symbols.py). */
export const SYMBOL_RE = /\\([A-Za-z]+)(\w*)/g;

/** `\rho` + `_0` -> `\rho_{0}`; `\omega` + `_max` -> `\omega_{\mathrm{max}}`. */
export function toLatex(name: string, tail: string): string {
  let latex = `\\${name}`;
  if (tail.startsWith("_") && tail.length > 1) {
    const sub = tail.slice(1);
    latex += sub.length > 1 ? `_{\\mathrm{${sub.replace(/_/g, "\\_")}}}` : `_{${sub}}`;
  } else if (tail) {
    latex += `{\\mathrm{${tail.replace(/_/g, "\\_")}}}`;
  }
  return latex;
}
