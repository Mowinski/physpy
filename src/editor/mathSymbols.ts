/**
 * "Conceal" extension:
 * - renders `\rho_0` as ρ₀ (via KaTeX),
 * - renders `^2`, `^-1`, `^n`, `^(n+1)` or `**2` as superscripts (² ⁻¹ ⁿ ⁽ⁿ⁺¹⁾),
 * while the document text stays plain ASCII. When the cursor/selection touches
 * a decorated range, the raw source is shown so it can be edited.
 */
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Tree } from "@lezer/common";
import katex from "katex";
import {
  ACCENTS,
  CONST_CALL_RE,
  PHYSICAL_CONSTANTS,
  SYMBOL_RE,
  SYMBOL_TAIL_SOURCE,
  accentToLatex,
  isValidAccentSymbol,
  isValidSymbol,
  toLatex,
} from "./symbols";

const ACCENT_ALT = Object.keys(ACCENTS).join("|");
const EXPR_SYMBOL_SOURCE = `\\\\(?:(${ACCENT_ALT})\\{((?:\\\\[A-Za-z]+\\w*|[A-Za-z_]\\w*))\\}|([A-Za-z]+))(${SYMBOL_TAIL_SOURCE})|([A-Za-z_]\\w*)`;

/**
 * Matches exponentiation after a base character (alphanumeric, `_`, `)`, `}`):
 * `^2`, `^-2`, `^n`, `^\alpha`, `^(n+1)`, or `**2`, `**(n+1)`.
 */
const POWER_RE = /(?<=[\w)}])(\*\*|\^)(\([^()\n]+\)|-?[A-Za-z0-9_]+|\\[A-Za-z]+)/g;
const SQRT_PREFIX_RE = /(?<![A-Za-z0-9_])(?:(?:np|numpy|math|sp|sympy|jnp|cp)\.)?sqrt\(/g;
const UNIT_ARROW_RE = /->(?=\s*\[[^[\]\n]+\])/g;

function expToLatex(exp: string): string {
  // Strip outer parens for simple expressions like `(n+1)` -> `n+1`, keep if needed
  const inner = exp.startsWith("(") && exp.endsWith(")") ? exp.slice(1, -1) : exp;
  return `{}^{${inner.replace(/_/g, "\\_")}}`;
}

function findSqrtCalls(text: string): Array<{ start: number; end: number; inner: string; raw: string }> {
  const results: Array<{ start: number; end: number; inner: string; raw: string }> = [];
  const re = new RegExp(SQRT_PREFIX_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const openParen = start + m[0].length - 1;
    let depth = 1;
    let hasTopComma = false;
    let i = openParen + 1;
    let quote: string | null = null;

    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1) {
        hasTopComma = true;
      }
      i++;
    }

    if (depth === 0 && !hasTopComma) {
      const inner = text.slice(openParen + 1, i);
      if (inner.trim().length > 0) {
        results.push({ start, end: i + 1, inner, raw: text.slice(start, i + 1) });
      }
    }
  }
  return results;
}

function exprToLatex(expr: string): string {
  let out = expr.trim();

  // 1. Recursively convert nested sqrt(...) calls and protect them with placeholders
  const sqrtPlaceholders: string[] = [];
  const nested = findSqrtCalls(out);
  if (nested.length > 0) {
    let rebuilt = "";
    let cursor = 0;
    for (const call of nested) {
      if (call.start < cursor) continue;
      rebuilt += out.slice(cursor, call.start);
      const token = `\u0000SQRT${sqrtPlaceholders.length}\u0000`;
      sqrtPlaceholders.push(`\\sqrt{${exprToLatex(call.inner)}}`);
      rebuilt += token;
      cursor = call.end;
    }
    rebuilt += out.slice(cursor);
    out = rebuilt;
  }

  // 2. Convert ** and ^ powers BEFORE symbol/text substitution so `}` doesn't block lookbehind
  //    and `**` is never turned into `\cdot \cdot`.
  out = out.replace(new RegExp(POWER_RE.source, "g"), (_full, _op: string, exp: string) => {
    const inner = exp.startsWith("(") && exp.endsWith(")") ? exp.slice(1, -1) : exp;
    return `^{${inner}}`;
  });

  // 3. Convert built-in physical constants \const{name}, PhysPy \symbols, and plain identifiers
  out = out.replace(new RegExp(CONST_CALL_RE.source, "g"), (full, cname: string) => {
    const entry = PHYSICAL_CONSTANTS[cname];
    return entry ? entry.latex : full;
  });

  out = out.replace(
    new RegExp(EXPR_SYMBOL_SOURCE, "g"),
    (
      full,
      accent?: string,
      inner?: string,
      symName?: string,
      symTail?: string,
      plainIdent?: string,
    ) => {
      if (accent !== undefined && inner !== undefined) {
        if (isValidAccentSymbol(accent, inner)) {
          return accentToLatex(accent, inner, symTail ?? "");
        }
        return full;
      }
      if (symName !== undefined) {
        if (isValidSymbol(symName, symTail ?? "")) {
          return toLatex(symName, symTail ?? "");
        }
        return full;
      }
      if (plainIdent !== undefined) {
        if (plainIdent.includes("_") || plainIdent.length > 1) {
          return `\\text{${plainIdent.replace(/_/g, "\\_")}}`;
        }
        return plainIdent;
      }
      return full;
    },
  );

  // 4. Format remaining multiplication `*` cleanly (never touching `**`)
  out = out.replace(/\s*(?<!\*)\*(?!\*)\s*/g, " \\cdot ");

  // 5. Restore nested sqrt placeholders
  for (let idx = 0; idx < sqrtPlaceholders.length; idx++) {
    out = out.replace(`\u0000SQRT${idx}\u0000`, sqrtPlaceholders[idx]);
  }
  return out;
}

class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly raw: string,
    readonly cls: string = "cm-math-symbol",
    readonly titleText: string = raw,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      other.latex === this.latex &&
      other.cls === this.cls &&
      other.raw === this.raw &&
      other.titleText === this.titleText
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.title = this.titleText;
    try {
      katex.render(this.latex, span, { throwOnError: true, output: "html" });
    } catch {
      span.textContent = this.raw;
    }

    // When the user clicks the widget, position the cursor cleanly at the end of the
    // raw LaTeX token in CodeMirror and reveal the raw source for immediate editing.
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      try {
        const pos = view.posAtDOM(span);
        if (pos != null && pos >= 0) {
          const targetPos = Math.min(view.state.doc.length, pos + this.raw.length);
          view.dispatch({
            selection: { anchor: targetPos, head: targetPos },
            scrollIntoView: false,
          });
          view.focus();
        }
      } catch {
        view.focus();
      }
    });

    return span;
  }

  updateDOM(): boolean {
    // Always recreate the widget DOM when `eq()` is false so CodeMirror re-measures
    // the updated KaTeX box cleanly and `mousedown` uses the current `this.raw`.
    return false;
  }

  // Prevent CodeMirror from treating internal KaTeX DOM nodes as editable document content,
  // which stops DOMObserver from observing KaTeX mutations and producing ghost text or corrupt offsets.
  ignoreEvent(): boolean {
    return true;
  }
}

function inStringOrComment(state: EditorView["state"], tree: Tree, pos: number): boolean {
  for (let node: any = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (/Comment/.test(node.name)) return true;
    if (/String/.test(node.name)) {
      const strText = state.doc.sliceString(node.from, node.to);
      if (/^[bBuU]*[fF]/.test(strText)) {
        const offset = pos - node.from;
        const before = strText.slice(0, offset);
        const after = strText.slice(offset);
        const openIdx = before.lastIndexOf("{");
        const closeBefore = before.lastIndexOf("}");
        if (openIdx > closeBefore && after.includes("}")) {
          return false;
        }
      }
      return true;
    }
  }
  return false;
}

interface Item {
  from: number;
  to: number;
  deco: Decoration;
}

function buildDecorations(view: EditorView): DecorationSet {
  const items: Item[] = [];
  const { state } = view;
  const tree = syntaxTree(state);
  const cursorTouches = (start: number, end: number) =>
    state.selection.ranges.some((r) => r.from <= end && r.to >= start);

  const symbolRe = new RegExp(SYMBOL_RE.source, "g");
  const powerRe = new RegExp(POWER_RE.source, "g");
  const scannedLines = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    const lineStart = state.doc.lineAt(from).number;
    const lineEnd = state.doc.lineAt(to).number;

    for (let l = lineStart; l <= lineEnd; l++) {
      if (scannedLines.has(l)) continue;
      scannedLines.add(l);

      const line = state.doc.line(l);
      const text = line.text;
      const lineFrom = line.from;

      for (const call of findSqrtCalls(text)) {
        const start = lineFrom + call.start;
        const end = lineFrom + call.end;
        if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
        items.push({
          from: start,
          to: end,
          deco: Decoration.replace({
            widget: new MathWidget(`\\sqrt{${exprToLatex(call.inner)}}`, call.raw, "cm-math-sqrt"),
          }),
        });
      }

      for (const m of text.matchAll(new RegExp(CONST_CALL_RE.source, "g"))) {
        const start = lineFrom + m.index!;
        const end = start + m[0].length;
        const [raw, cname] = m;
        const entry = PHYSICAL_CONSTANTS[cname];
        if (!entry) continue;
        if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
        items.push({
          from: start,
          to: end,
          deco: Decoration.replace({
            widget: new MathWidget(
              entry.latex,
              raw,
              "cm-math-symbol cm-math-const",
              `${raw} = ${entry.value} ${entry.unit} (${entry.label})`,
            ),
          }),
        });
      }

      for (const m of text.matchAll(symbolRe)) {
        const start = lineFrom + m.index!;
        const end = start + m[0].length;
        const [raw, accent, inner, name, tail] = m;
        let latex: string | null = null;
        if (accent !== undefined && inner !== undefined) {
          if (isValidAccentSymbol(accent, inner)) {
            latex = accentToLatex(accent, inner, tail ?? "");
          }
        } else if (name !== undefined && isValidSymbol(name, tail ?? "")) {
          latex = toLatex(name, tail ?? "");
        }
        if (latex === null) continue;
        if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
        items.push({
          from: start,
          to: end,
          deco: Decoration.replace({ widget: new MathWidget(latex, raw) }),
        });
      }

      for (const m of text.matchAll(powerRe)) {
        const start = lineFrom + m.index!;
        const end = start + m[0].length;
        const [raw, , exp] = m;
        if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
        items.push({
          from: start,
          to: end,
          deco: Decoration.replace({
            widget: new MathWidget(expToLatex(exp), raw, "cm-math-power"),
          }),
        });
      }

      for (const m of text.matchAll(UNIT_ARROW_RE)) {
        const start = lineFrom + m.index!;
        const end = start + m[0].length;
        if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
        items.push({
          from: start,
          to: end,
          deco: Decoration.replace({
            widget: new MathWidget("\\to", "->", "cm-math-arrow"),
          }),
        });
      }
    }
  }

  items.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastEnd = -1;
  for (const it of items) {
    if (it.from < lastEnd) continue; // skip overlapping
    builder.add(it.from, it.to, it.deco);
    lastEnd = it.to;
  }
  return builder.finish();
}

export const mathSymbols = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        return view.plugin(plugin)?.decorations || Decoration.none;
      }),
  },
);
