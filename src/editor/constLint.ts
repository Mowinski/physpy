/**
 * Live syntax highlighting & error underlining for `const` and `export`:
 * - Styles leading `const` and `export` keywords,
 * - Immediately underlines in red any reassignment/mutation of a `const` variable
 *   (whether declared in the same cell via `const x = ...` or in another cell via
 *   `export const x = ...`) and shows an inline error message at the end of the line.
 */
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { replaceSymbolsInIdent } from "./symbols";

export interface ConstLocation {
  cellIndex: number;
  line: number;
}

/** Shared map of `export const` variable names across all cells in the active tab. */
let notebookExportedConsts = new Map<string, ConstLocation[]>();

export const refreshConstLintEffect = StateEffect.define<null>();

export function setNotebookExportedConsts(
  map: Map<string, ConstLocation[]>,
  views: EditorView[],
) {
  notebookExportedConsts = map;
  for (const v of views) {
    v.dispatch({ effects: refreshConstLintEffect.of(null) });
  }
}

function normalizeIdent(raw: string): string {
  return replaceSymbolsInIdent(raw.trim());
}

class InlineErrorWidget extends WidgetType {
  constructor(readonly message: string) {
    super();
  }

  eq(other: InlineErrorWidget): boolean {
    return other.message === this.message;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-const-error-msg";
    span.textContent = `  ⚠ ${this.message}`;
    return span;
  }
}

interface DecoEntry {
  from: number;
  to: number;
  deco: Decoration;
}

const KW_RE = /^(\s*)((?:export\s+const|const\s+export|export|const))\b/;
const IDENT_PATTERN = `(?:\\\\[A-Za-z]+\\w*|[A-Za-z_]\\w*)`;
const ASSIGN_LINE_RE = new RegExp(
  `^(\\s*)(?:(export\\s+const|const\\s+export|export|const)\\s+)?(${IDENT_PATTERN}(?:\\s*,\\s*${IDENT_PATTERN})*)\\s*(\\+=|-=|\\*=|\\/=|%=|\\*\\*=|//=|=(?!=))`,
);
const BARE_CONST_RE = /^\s*(?:export\s+const|const\s+export|const)\b([^=]*)$/;
const DEL_OR_FOR_RE = new RegExp(`^\\s*(?:del|for)\\s+(${IDENT_PATTERN})\\b`);
const UNIT_LITERAL_RE = /(?<=\d)\s*(\[[^[\]\n]+\])/g;

function buildConstDecorations(view: EditorView): DecorationSet {
  const entries: DecoEntry[] = [];
  const doc = view.state.doc;
  // Local constants declared so far in this cell: normalized name -> line number
  const localConsts = new Map<string, number>();

  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const raw = line.text;
    const codeOnly = raw.replace(/#.*$/, "");
    if (!codeOnly.trim()) continue;

    // 1. Highlight leading `const` / `export` keywords
    const kwMatch = codeOnly.match(KW_RE);
    if (kwMatch) {
      const kwStart = line.from + kwMatch[1].length;
      const kwEnd = kwStart + kwMatch[2].length;
      entries.push({
        from: kwStart,
        to: kwEnd,
        deco: Decoration.mark({ class: "cm-physpy-keyword" }),
      });
    }

    // 1b. Highlight physical unit literals `NUMBER [unit]`
    for (const um of codeOnly.matchAll(UNIT_LITERAL_RE)) {
      const bracketText = um[1];
      const bracketOffset = um.index! + (um[0].length - bracketText.length);
      const uStart = line.from + bracketOffset;
      const uEnd = uStart + bracketText.length;
      entries.push({
        from: uStart,
        to: uEnd,
        deco: Decoration.mark({ class: "cm-unit-literal" }),
      });
    }

    // 2. Check for `const x` without `= value`
    if (BARE_CONST_RE.test(codeOnly)) {
      const trimStart = raw.length - raw.trimStart().length;
      const errFrom = line.from + trimStart;
      const errTo = line.from + codeOnly.trimEnd().length;
      const msg = "const declaration requires '= value'";
      entries.push({
        from: errFrom,
        to: Math.max(errFrom + 1, errTo),
        deco: Decoration.mark({ class: "cm-const-error", attributes: { title: msg } }),
      });
      entries.push({
        from: line.to,
        to: line.to,
        deco: Decoration.widget({ widget: new InlineErrorWidget(msg), side: 1 }),
      });
      continue;
    }

    // 3. Check assignments & `const` declarations
    const assignMatch = codeOnly.match(ASSIGN_LINE_RE);
    if (assignMatch) {
      const [, leadingWs, kwPrefix, lhsRaw] = assignMatch;
      const isConstDecl = Boolean(kwPrefix && /\bconst\b/.test(kwPrefix));
      const isExportConstDecl = Boolean(
        kwPrefix && /\bconst\b/.test(kwPrefix) && /\bexport\b/.test(kwPrefix),
      );

      const names = lhsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      let lineError: string | null = null;
      for (const rawName of names) {
        const norm = normalizeIdent(rawName);
        const alreadyLocal = localConsts.has(norm);
        const globalLocs = notebookExportedConsts.get(norm) ?? [];
        // If this line itself is the sole `export const` declaration of `norm`, it's not a conflict;
        // if there are >=2 `export const` declarations or this line is a normal assignment to an
        // `export const`, it IS a conflict!
        const globalConflict = isExportConstDecl
          ? globalLocs.length > 1 || alreadyLocal
          : globalLocs.length > 0;

        if (alreadyLocal || globalConflict) {
          lineError = `cannot reassign constant '${norm}'`;
          break;
        }
      }

      if (lineError) {
        const errFrom = line.from + leadingWs.length;
        const errTo = line.from + codeOnly.trimEnd().length;
        entries.push({
          from: errFrom,
          to: Math.max(errFrom + 1, errTo),
          deco: Decoration.mark({ class: "cm-const-error", attributes: { title: lineError } }),
        });
        entries.push({
          from: line.to,
          to: line.to,
          deco: Decoration.widget({ widget: new InlineErrorWidget(lineError), side: 1 }),
        });
      }

      if (isConstDecl) {
        for (const rawName of names) {
          const norm = normalizeIdent(rawName);
          if (!localConsts.has(norm)) {
            localConsts.set(norm, lineNo);
          }
        }
      }
      continue;
    }

    // 4. Check `del x` or `for x in ...` targeting a constant
    const delForMatch = codeOnly.match(DEL_OR_FOR_RE);
    if (delForMatch) {
      const norm = normalizeIdent(delForMatch[1]);
      if (localConsts.has(norm) || notebookExportedConsts.has(norm)) {
        const msg = `cannot reassign constant '${norm}'`;
        const trimStart = raw.length - raw.trimStart().length;
        const errFrom = line.from + trimStart;
        const errTo = line.from + codeOnly.trimEnd().length;
        entries.push({
          from: errFrom,
          to: Math.max(errFrom + 1, errTo),
          deco: Decoration.mark({ class: "cm-const-error", attributes: { title: msg } }),
        });
        entries.push({
          from: line.to,
          to: line.to,
          deco: Decoration.widget({ widget: new InlineErrorWidget(msg), side: 1 }),
        });
      }
    }
  }

  entries.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const e of entries) {
    builder.add(e.from, e.to, e.deco);
  }
  return builder.finish();
}

export const constLinter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildConstDecorations(view);
    }

    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.transactions.some((tr) => tr.effects.some((ef) => ef.is(refreshConstLintEffect)))
      ) {
        this.decorations = buildConstDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
