import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import katex from "katex";
import { findVariableAtOffset, findVariableOccurrences } from "../refactor";
import { varNameToLatex } from "./symbols";

export interface VariableHoverInfo {
  name: string;
  value?: string;
  description?: string;
  isExported: boolean;
  isConst: boolean;
}

export interface CodeIntelligenceProvider {
  getHoverInfo: (varName: string) => VariableHoverInfo | null;
  onGoToDefinition: (varName: string, view: EditorView) => boolean;
  onEditDescription?: (varName: string, currentDesc?: string) => void;
}

const varHighlightMark = Decoration.mark({ class: "cm-var-highlight" });

function buildHighlightDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection.main;
  if (!sel.empty && sel.to - sel.from > 64) {
    return builder.finish();
  }
  const src = view.state.doc.toString();
  const varName = findVariableAtOffset(src, sel.head);
  if (!varName) return builder.finish();

  const ranges = findVariableOccurrences(src, varName);
  if (ranges.length < 2) return builder.finish();

  for (const r of ranges) {
    builder.add(r.from, r.to, varHighlightMark);
  }
  return builder.finish();
}

const variableHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHighlightDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildHighlightDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export function createCodeIntelligenceExtension(
  provider?: CodeIntelligenceProvider,
): Extension[] {
  const extensions: Extension[] = [variableHighlightPlugin];

  if (provider) {
    extensions.push(
      hoverTooltip(
        (view, pos) => {
          const src = view.state.doc.toString();
          const varName = findVariableAtOffset(src, pos);
          if (!varName) return null;

          const occs = findVariableOccurrences(src, varName);
          const hit = occs.find((r) => pos >= r.from && pos <= r.to);
          if (!hit) return null;

          const info = provider.getHoverInfo(varName);
          if (!info) return null;

          return {
            pos: hit.from,
            end: hit.to,
            above: true,
            create() {
              const dom = document.createElement("div");
              dom.className = "cm-hover-inspector";

              const header = document.createElement("div");
              header.className = "cm-hover-inspector-header";
              const latex = varNameToLatex(info.name);
              if (latex) {
                const mathEl = document.createElement("span");
                mathEl.className = "cm-hover-inspector-math";
                mathEl.title = info.name;
                katex.render(latex, mathEl, { throwOnError: false, output: "html" });
                header.append(mathEl);
              } else {
                const nameEl = document.createElement("code");
                nameEl.textContent = info.name;
                header.append(nameEl);
              }

              if (info.isExported) {
                const badge = document.createElement("span");
                badge.className = "cm-hover-badge export";
                badge.textContent = "export";
                header.append(badge);
              }
              if (info.isConst) {
                const badge = document.createElement("span");
                badge.className = "cm-hover-badge const";
                badge.textContent = "const";
                header.append(badge);
              }
              if (provider.onEditDescription) {
                const editBtn = document.createElement("button");
                editBtn.type = "button";
                editBtn.className = "cm-hover-edit-desc-btn";
                editBtn.textContent = info.description ? "✎" : "+ Opis";
                editBtn.title = info.description ? "Edytuj opis zmiennej" : "Dodaj opis zmiennej";
                editBtn.addEventListener("click", (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  provider.onEditDescription?.(info.name, info.description);
                });
                header.append(editBtn);
              }
              dom.append(header);

              if (info.description) {
                const descEl = document.createElement("div");
                descEl.className = "cm-hover-inspector-desc";
                descEl.textContent = info.description;
                dom.append(descEl);
              }

              if (info.value !== undefined) {
                const valEl = document.createElement("div");
                valEl.className = "cm-hover-inspector-val";
                valEl.textContent = info.value;
                dom.append(valEl);
              } else {
                const hintEl = document.createElement("div");
                hintEl.className = "cm-hover-inspector-hint";
                hintEl.textContent = "Zmienna lokalna (uruchom komórkę, aby zobaczyć wartość po eksporcie)";
                dom.append(hintEl);
              }

              return { dom };
            },
          };
        },
        { hoverTime: 350 },
      ),
      keymap.of([
        {
          key: "F12",
          run: (view) => {
            const src = view.state.doc.toString();
            const varName = findVariableAtOffset(src, view.state.selection.main.head);
            if (!varName) return false;
            return provider.onGoToDefinition(varName, view);
          },
        },
      ]),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          const src = view.state.doc.toString();
          const varName = findVariableAtOffset(src, pos);
          if (!varName) return false;
          const handled = provider.onGoToDefinition(varName, view);
          if (handled) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      }),
    );
  }

  return extensions;
}
