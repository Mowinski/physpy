import { EditorState, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import katex from "katex";

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda",
  "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega", "hbar", "infty",
  "partial", "nabla"
]);

class MatrixWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly raw: string,
    readonly start: number,
    readonly end: number,
  ) {
    super();
  }

  eq(other: MatrixWidget): boolean {
    return other.latex === this.latex && other.raw === this.raw;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-math-matrix";
    span.title = "Kliknij, aby edytować macierz";

    try {
      katex.render(this.latex, span, { displayMode: false, throwOnError: false });
    } catch {
      span.textContent = this.raw;
    }

    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      try {
        const pos = view.posAtDOM(span);
        const target = pos >= 0 ? pos + 1 : this.start + 1;
        view.dispatch({
          selection: { anchor: target, head: target },
          scrollIntoView: false,
        });
        view.focus();
      } catch {
        view.focus();
      }
    });

    return span;
  }

  updateDOM(dom: HTMLElement): boolean {
    if (dom.className !== "cm-math-matrix") return false;
    dom.title = "Kliknij, aby edytować macierz";
    try {
      katex.render(this.latex, dom, { displayMode: false, throwOnError: false });
      return true;
    } catch {
      dom.textContent = this.raw;
      return true;
    }
  }

  ignoreEvent(e: Event): boolean {
    return e.type !== "mousedown";
  }
}

function splitByDelimiter(str: string, delim: string): string[] {
  const parts: string[] = [];
  let depthP = 0;
  let depthB = 0;
  let cur = "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "(" || c === "{") depthP++;
    else if (c === ")" || c === "}") depthP = Math.max(0, depthP - 1);
    else if (c === "[") depthB++;
    else if (c === "]") depthB = Math.max(0, depthB - 1);

    if (c === delim && depthP === 0 && depthB === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function stripOuterParens(str: string): string {
  let s = str.trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let matchedAll = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      if (depth === 0) {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return s;
}

function findTopLevelDiv(str: string): number {
  let depthP = 0;
  let depthB = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    const c = str[i];
    if (c === ")" || c === "}") depthP++;
    else if (c === "(" || c === "{") depthP = Math.max(0, depthP - 1);
    else if (c === "]") depthB++;
    else if (c === "[") depthB = Math.max(0, depthB - 1);
    else if (c === "/" && depthP === 0 && depthB === 0) {
      return i;
    }
  }
  return -1;
}

function exprToLatex(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  s = s.replace(/#.*$/, "").trim();

  // Common math/numpy functions
  s = s.replace(/\bnp\.exp\((.+?)\)/g, "e^{$1}");
  s = s.replace(/\bnp\.sqrt\((.+?)\)/g, "\\sqrt{$1}");
  s = s.replace(/\bnp\.sin\((.+?)\)/g, "\\sin($1)");
  s = s.replace(/\bnp\.cos\((.+?)\)/g, "\\cos($1)");

  // Division via top-level '/'
  const divIdx = findTopLevelDiv(s);
  if (divIdx >= 0) {
    const num = stripOuterParens(s.slice(0, divIdx));
    const den = stripOuterParens(s.slice(divIdx + 1));
    return `\\frac{${exprToLatex(num)}}{${exprToLatex(den)}}`;
  }

  // Imaginary unit: \i -> i
  s = s.replace(/\\i\b/g, "i");

  // Identifiers with backslash: \hbar vs \k_2 vs \k
  s = s.replace(/\\([A-Za-z]+)(?:_([A-Za-z0-9]+))?/g, (_, name, sub) => {
    const isGreek = GREEK.has(name);
    const prefix = isGreek ? `\\${name}` : name;
    return sub ? `${prefix}_{${sub}}` : prefix;
  });

  // Plain subscripts: k_2 -> k_{2}, V_0 -> V_{0}
  s = s.replace(/\b([A-Za-z]+)_([A-Za-z0-9]+)\b/g, "$1_{$2}");

  // Powers: ** or ^
  s = s.replace(/(\*\*|\^)(\w+|\([^)]+\))/g, (_, _op, exp: string) => {
    const cleanExp = exp.startsWith("(") && exp.endsWith(")") ? exp.slice(1, -1) : exp;
    return `^{${cleanExp}}`;
  });

  // Multiplication: * -> \cdot
  s = s.replace(/\s*\*\s*/g, " \\cdot ");

  // Complex unit: 1j -> i, j -> i
  s = s.replace(/\b(\d*)j\b/g, (_, d) => (d ? `${d}i` : "i"));

  return s;
}

function matrixRawToLatex(raw: string): string {
  const inner = raw.slice(1, -1).trim();
  const rowStrs = splitByDelimiter(inner, ";");
  const latexRows: string[] = [];
  let hasFractions = false;

  for (const r of rowStrs) {
    if (!r.trim()) continue;
    const items = splitByDelimiter(r, ",");
    const latexItems = items.map((it) => {
      const lx = exprToLatex(it);
      if (lx.includes("\\frac")) hasFractions = true;
      return lx.includes("\\frac") ? `\\displaystyle ${lx}` : lx;
    });
    latexRows.push(latexItems.join(" & "));
  }

  // Generous spacing between rows so fractions and symbols never collide
  const rowSep = hasFractions ? " \\\\[0.95em]\n" : " \\\\[0.45em]\n";
  return `\\begin{pmatrix}\n${latexRows.join(rowSep)}\n\\end{pmatrix}`;
}

export function findMatrixLiterals(src: string): Array<{ start: number; end: number; raw: string }> {
  const results: Array<{ start: number; end: number; raw: string }> = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    if (ch === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const q = ch;
      const isTriple = src.slice(i, i + 3) === q + q + q;
      i += isTriple ? 3 : 1;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (isTriple && src.slice(i, i + 3) === q + q + q) { i += 3; break; }
        if (!isTriple && src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "[") {
      const start = i;
      let depthB = 1;
      let depthP = 0;
      let j = i + 1;
      const semicolons: number[] = [];

      while (j < n && depthB > 0) {
        const c = src[j];
        if (c === "#") {
          while (j < n && src[j] !== "\n") j++;
          continue;
        }
        if (c === "\"" || c === "'") {
          const q = c;
          const isTriple = src.slice(j, j + 3) === q + q + q;
          j += isTriple ? 3 : 1;
          while (j < n) {
            if (src[j] === "\\") { j += 2; continue; }
            if (isTriple && src.slice(j, j + 3) === q + q + q) { j += 3; break; }
            if (!isTriple && src[j] === q) { j++; break; }
            j++;
          }
          continue;
        }
        if (c === "(" || c === "{") {
          depthP++;
        } else if (c === ")" || c === "}") {
          depthP = Math.max(0, depthP - 1);
        } else if (c === "[") {
          depthB++;
        } else if (c === "]") {
          depthB--;
          if (depthB === 0) break;
        } else if (c === ";" && depthB === 1 && depthP === 0) {
          semicolons.push(j);
        }
        j++;
      }

      if (depthB === 0 && semicolons.length > 0) {
        results.push({ start, end: j + 1, raw: src.slice(start, j + 1) });
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  return results;
}

function buildMatrixDecorations(state: EditorState): DecorationSet {
  const docText = state.doc.toString();
  const matrices = findMatrixLiterals(docText);
  const cursorTouches = (start: number, end: number) =>
    state.selection.ranges.some((r) => r.from <= end && r.to >= start);

  const builder = new RangeSetBuilder<Decoration>();
  for (const mat of matrices) {
    if (cursorTouches(mat.start, mat.end)) continue;
    try {
      const latex = matrixRawToLatex(mat.raw);
      builder.add(
        mat.start,
        mat.end,
        Decoration.replace({
          widget: new MatrixWidget(latex, mat.raw, mat.start, mat.end),
        }),
      );
    } catch {
      // ignore
    }
  }

  return builder.finish();
}

export const matrixConcealField = StateField.define<DecorationSet>({
  create(state) {
    return buildMatrixDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection) {
      return buildMatrixDecorations(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
