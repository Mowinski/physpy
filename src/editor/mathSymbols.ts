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
import { SYMBOLS, SYMBOL_RE, toLatex } from "./symbols";

/**
 * Matches exponentiation after a base character (alphanumeric, `_`, `)`):
 * `^2`, `^-2`, `^n`, `^\alpha`, `^(n+1)`, or `**2`, `**(n+1)`.
 */
const POWER_RE = /(?<=[\w)])(\*\*|\^)(\([^()\n]+\)|-?[A-Za-z0-9_]+|\\[A-Za-z]+)/g;

function expToLatex(exp: string): string {
  // Strip outer parens for simple expressions like `(n+1)` -> `n+1`, keep if needed
  const inner = exp.startsWith("(") && exp.endsWith(")") ? exp.slice(1, -1) : exp;
  return `{}^{${inner.replace(/_/g, "\\_")}}`;
}

class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly raw: string,
    readonly cls: string = "cm-math-symbol",
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.latex === this.latex && other.cls === this.cls;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.title = this.raw;
    try {
      katex.render(this.latex, span, { throwOnError: true, output: "html" });
    } catch {
      span.textContent = this.raw;
    }
    return span;
  }

  // Let clicks through so CodeMirror places the cursor (which reveals the source).
  ignoreEvent(): boolean {
    return false;
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

  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);

    for (const m of text.matchAll(SYMBOL_RE)) {
      const start = from + m.index!;
      const end = start + m[0].length;
      const [raw, name, tail] = m;
      if (!(name in SYMBOLS)) continue;
      if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
      items.push({
        from: start,
        to: end,
        deco: Decoration.replace({ widget: new MathWidget(toLatex(name, tail), raw) }),
      });
    }

    for (const m of text.matchAll(POWER_RE)) {
      const start = from + m.index!;
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
  { decorations: (v) => v.decorations },
);
