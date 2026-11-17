import symbolTable from "../../transpiler/src/physpy/symbols.json";
import physicalConstantsTable from "../../transpiler/src/physpy/physical_constants.json";

export interface PhysicalConstantDef {
  value: number;
  unit: string;
  latex: string;
  label: string;
}

/** Built-in physical constants with Pint units. Single source of truth shared with the Python transpiler. */
export const PHYSICAL_CONSTANTS: Record<string, PhysicalConstantDef> = physicalConstantsTable;

export const CONST_CALL_RE = /\\const\{([A-Za-z0-9_]+)\}/g;

/** LaTeX-like name -> display character. Single source of truth shared with the Python transpiler. */
export const SYMBOLS: Record<string, string> = symbolTable;

/** Accent commands -> Unicode combining marks (same as transpiler/src/physpy/symbols.py). */
export const ACCENTS: Record<string, string> = {
  bar: "\u0304",
  overline: "\u0304",
  hat: "\u0302",
  vec: "\u20d7",
  dot: "\u0307",
  ddot: "\u0308",
  tilde: "\u0303",
  prime: "\u02b9",
  dprime: "\u02ba",
};

export const ACCENT_ALT = Object.keys(ACCENTS).join("|");
const ACCENT_CALL_SOURCE = `\\\\(${ACCENT_ALT})\\{((?:\\\\[A-Za-z]+\\w*|[A-Za-z_]\\w*))\\}`;
const ACCENT_CALL_NONCAP = `\\\\(?:${ACCENT_ALT})\\{(?:\\\\[A-Za-z]+\\w*|[A-Za-z_]\\w*)\\}`;
const ACCENT_CALL_RE = new RegExp(`^${ACCENT_CALL_SOURCE}$`);
const ACCENT_CALL_GLOBAL_RE = new RegExp(ACCENT_CALL_SOURCE, "g");
const PLAIN_SYMBOL_RE = /^\\([A-Za-z]+)(\w*)$/;
export const SYMBOL_TAIL_SOURCE = `(?:_${ACCENT_CALL_NONCAP}|[A-Za-z0-9]|_(?!\\\\))*`;

/** Matches `\rho_0`, `\bar{u}`, `\bar{u}_a`, `\u_\bar{t}`, ... (same regex as transpiler/src/physpy/symbols.py). */
export const SYMBOL_RE = new RegExp(
  `\\\\(?:(${ACCENT_ALT})\\{((?:\\\\[A-Za-z]+\\w*|[A-Za-z_]\\w*))\\}|([A-Za-z]+))(${SYMBOL_TAIL_SOURCE})`,
  "g",
);

function formatSubscriptTail(tail: string): string {
  if (tail.startsWith("_") && tail.length > 1) {
    const sub = tail.slice(1);
    const accentMatch = ACCENT_CALL_RE.exec(sub);
    if (accentMatch) {
      return `_{${accentToLatex(accentMatch[1], accentMatch[2], "")}}`;
    }
    if (sub.includes("\\")) {
      const formatted = sub.replace(
        new RegExp(`${ACCENT_CALL_SOURCE}|_`, "g"),
        (full, acc?: string, inn?: string) => {
          if (acc !== undefined && inn !== undefined) {
            return accentToLatex(acc, inn, "");
          }
          return full === "_" ? "\\_" : full;
        },
      );
      return `_{${formatted}}`;
    }
    const isPureNumber = /^\d+$/.test(sub);
    if (sub.length === 1 || isPureNumber) {
      return `_{${sub}}`;
    }
    return `_{\\mathrm{${sub.replace(/_/g, "\\_")}}}`;
  }
  if (tail) {
    return `{\\mathrm{${tail.replace(/_/g, "\\_")}}}`;
  }
  return "";
}

/** Check whether a plain symbol match should be rendered / handled by PhysPy. */
export function isValidSymbol(name: string, tail: string): boolean {
  if (name in SYMBOLS) return true;
  if (name === "i" && !tail) return true;
  if (tail.startsWith("_") && tail.length > 1) return true;
  return false;
}

/** Check whether an accented symbol `\accent{inner}tail` is valid. */
export function isValidAccentSymbol(accent: string, inner: string): boolean {
  if (!(accent in ACCENTS)) return false;
  if (inner.startsWith("\\")) {
    const m = PLAIN_SYMBOL_RE.exec(inner);
    if (!m) return false;
    const [, innerName, innerTail] = m;
    if (innerName === "i" && !innerTail) return false;
    return isValidSymbol(innerName, innerTail);
  }
  return /^[A-Za-z_]\w*$/.test(inner);
}

/** `\rho` + `_0` -> `\rho_{0}`; `\m` + `_0` -> `m_{0}`; `\i` -> `i`. */
export function toLatex(name: string, tail: string): string {
  if (name === "i" && !tail) {
    return "i";
  }
  const base = name in SYMBOLS ? `\\${name}` : name;
  return base + formatSubscriptTail(tail);
}

/** `\bar` + `u` + `_a` -> `\bar{u}_{a}`; `\overline` + `czas` + `` -> `\overline{\text{czas}}`. */
export function accentToLatex(accent: string, inner: string, tail: string): string {
  let innerLatex: string;
  if (inner.startsWith("\\")) {
    const m = PLAIN_SYMBOL_RE.exec(inner);
    innerLatex = m ? toLatex(m[1], m[2]) : inner;
  } else if (inner.includes("_")) {
    const idx = inner.indexOf("_");
    const base = inner.slice(0, idx);
    const sub = inner.slice(idx);
    const baseLatex = base.length > 1 ? `\\text{${base}}` : base || "\\_";
    innerLatex = baseLatex + formatSubscriptTail(sub);
  } else if (inner.length > 1) {
    innerLatex = `\\text{${inner}}`;
  } else {
    innerLatex = inner;
  }
  if (accent === "prime") {
    return `{${innerLatex}}'${formatSubscriptTail(tail)}`;
  }
  if (accent === "dprime") {
    return `{${innerLatex}}''${formatSubscriptTail(tail)}`;
  }
  return `\\${accent}{${innerLatex}}${formatSubscriptTail(tail)}`;
}

function resolveTail(tail: string): string {
  if (!tail.includes("\\")) return tail;
  return tail.replace(ACCENT_CALL_GLOBAL_RE, (full, acc: string, inn: string) => {
    const resolved = resolveAccentSymbolIdent(acc, inn, "");
    return resolved !== null ? resolved : full;
  });
}

/**
 * Resolves a symbol token to its Python identifier / representation:
 * - `\i` -> `1j`
 * - `\rho_0` -> `ρ_0`
 * - `\m_0` -> `m_0`
 * - `\v_max` -> `v_max`
 * - `\u_\bar{t}` -> `u_t̄`
 */
export function resolveSymbolIdent(name: string, tail: string): string | null {
  if (name === "i" && !tail) {
    return "1j";
  }
  const resolvedTail = resolveTail(tail);
  if (name in SYMBOLS) {
    return (SYMBOLS[name] + resolvedTail).normalize("NFKC");
  }
  if (tail.startsWith("_")) {
    return `${name}${resolvedTail}`.normalize("NFKC");
  }
  return null;
}

export function resolveAccentSymbolIdent(accent: string, inner: string, tail: string): string | null {
  if (!(accent in ACCENTS)) return null;
  let base: string;
  if (inner.startsWith("\\")) {
    const m = PLAIN_SYMBOL_RE.exec(inner);
    if (!m) return null;
    const [, innerName, innerTail] = m;
    if (innerName === "i" && !innerTail) return null;
    const resolved = resolveSymbolIdent(innerName, innerTail);
    if (resolved === null) return null;
    base = resolved;
  } else {
    base = inner;
  }
  const resolvedTail = resolveTail(tail);
  return (base + ACCENTS[accent] + resolvedTail).normalize("NFKC");
}

export function replaceSymbolsInIdent(raw: string): string {
  return raw.replace(
    new RegExp(SYMBOL_RE.source, "g"),
    (full, accent?: string, inner?: string, name?: string, tail?: string) => {
      if (accent !== undefined && inner !== undefined) {
        const resolved = resolveAccentSymbolIdent(accent, inner, tail ?? "");
        return resolved !== null ? resolved : full;
      }
      if (name !== undefined) {
        const resolved = resolveSymbolIdent(name, tail ?? "");
        return resolved !== null ? resolved : full;
      }
      return full;
    },
  );
}
