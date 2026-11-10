import symbolTable from "../../transpiler/src/physpy/symbols.json";

/** LaTeX-like name -> display character. Single source of truth shared with the Python transpiler. */
export const SYMBOLS: Record<string, string> = symbolTable;

/** Matches `\rho`, `\rho_0`, `\omega_max`, `\m_0`, `\i` ... (same regex as transpiler/src/physpy/symbols.py). */
export const SYMBOL_RE = /\\([A-Za-z]+)(\w*)/g;

/** Check whether a symbol match should be rendered / handled by PhysPy. */
export function isValidSymbol(name: string, tail: string): boolean {
  if (name in SYMBOLS) return true;
  if (name === "i" && !tail) return true;
  if (tail.startsWith("_") && tail.length > 1) return true;
  return false;
}

/** `\rho` + `_0` -> `\rho_{0}`; `\m` + `_0` -> `m_{0}`; `\i` -> `i`. */
export function toLatex(name: string, tail: string): string {
  if (name === "i" && !tail) {
    return "i";
  }
  const base = name in SYMBOLS ? `\\${name}` : name;
  let latex = base;
  if (tail.startsWith("_") && tail.length > 1) {
    const sub = tail.slice(1);
    const isPureNumber = /^\d+$/.test(sub);
    if (sub.length === 1 || isPureNumber) {
      latex += `_{${sub}}`;
    } else {
      latex += `_{\\mathrm{${sub.replace(/_/g, "\\_")}}}`;
    }
  } else if (tail) {
    latex += `{\\mathrm{${tail.replace(/_/g, "\\_")}}}`;
  }
  return latex;
}

/**
 * Resolves a symbol token to its Python identifier / representation:
 * - `\i` -> `1j`
 * - `\rho_0` -> `ρ_0`
 * - `\m_0` -> `m_0`
 * - `\v_max` -> `v_max`
 */
export function resolveSymbolIdent(name: string, tail: string): string | null {
  if (name === "i" && !tail) {
    return "1j";
  }
  if (name in SYMBOLS) {
    return SYMBOLS[name].normalize("NFKC") + tail;
  }
  if (tail.startsWith("_")) {
    return `${name}${tail}`;
  }
  return null;
}

export function replaceSymbolsInIdent(raw: string): string {
  return raw.replace(new RegExp(SYMBOL_RE.source, "g"), (full, name: string, tail: string) => {
    const resolved = resolveSymbolIdent(name, tail);
    return resolved !== null ? resolved : full;
  });
}
