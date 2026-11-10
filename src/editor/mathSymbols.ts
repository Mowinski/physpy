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
import { SYMBOL_RE, isValidSymbol, toLatex } from "./symbols";

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
    return (
      other.latex === this.latex &&
      other.cls === this.cls &&
      other.raw === this.raw
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.title = this.raw;
    try {
      katex.render(this.latex, span, { throwOnError: true, output: "html" });
    } catch {
      span.textContent = this.raw;
    }

    // When the user clicks the widget, position the cursor cleanly in CodeMirror
    // and reveal the raw source without letting browser selection enter KaTeX DOM.
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      try {
        const pos = view.posAtDOM(span);
        if (pos != null && pos >= 0) {
          const rect = span.getBoundingClientRect();
          const isRight = e.clientX > rect.left + rect.width / 2;
          const targetPos = isRight
            ? Math.min(view.state.doc.length, pos + this.raw.length)
            : pos;
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

  updateDOM(dom: HTMLElement): boolean {
    if (dom.className !== this.cls) return false;
    dom.title = this.raw;
    try {
      katex.render(this.latex, dom, { throwOnError: true, output: "html" });
      return true;
    } catch {
      dom.textContent = this.raw;
      return true;
    }
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

      for (const m of text.matchAll(symbolRe)) {
        const start = lineFrom + m.index!;
        const end = start + m[0].length;
        const [raw, name, tail] = m;
        if (!isValidSymbol(name, tail)) continue;
        if (inStringOrComment(state, tree, start) || cursorTouches(start, end)) continue;
        items.push({
          from: start,
          to: end,
          deco: Decoration.replace({ widget: new MathWidget(toLatex(name, tail), raw) }),
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
