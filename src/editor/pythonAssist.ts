import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type Tooltip,
  keymap,
  showTooltip,
} from "@codemirror/view";
import type { PythonCompletionItem, SignatureHelpInfo } from "../backend";

export interface PythonAssistProvider {
  isEnabled?: () => boolean;
  getDocSource: () => string;
  complete: (params: {
    prefix: string;
    attrTarget: string | null;
    cellSource: string;
    docSource: string;
  }) => Promise<PythonCompletionItem[]>;
  signature: (params: {
    expr: string;
    cellSource: string;
    docSource: string;
  }) => Promise<SignatureHelpInfo | null>;
}

interface ActiveCallSite {
  expr: string;
  parenPos: number;
  argIndex: number;
  kwargName: string | null;
}

interface SigTooltipData {
  call: ActiveCallSite;
  info: SignatureHelpInfo;
}

const SKIP_CALLABLE_KEYWORDS = new Set([
  "if",
  "elif",
  "while",
  "for",
  "return",
  "with",
  "assert",
  "yield",
  "and",
  "or",
  "not",
  "in",
  "is",
  "lambda",
  "def",
  "class",
  "del",
  "raise",
  "except",
]);

function extractCallableBeforeParen(text: string, parenIdx: number): string | null {
  let end = parenIdx;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) {
    end--;
  }
  const slice = text.slice(0, end);
  const m = slice.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/);
  if (!m) return null;
  const expr = m[1];
  if (!expr.includes(".") && SKIP_CALLABLE_KEYWORDS.has(expr)) {
    return null;
  }
  return expr;
}

export function findActiveCallAt(text: string, pos: number): ActiveCallSite | null {
  interface Frame {
    kind: "(" | "[" | "{";
    pos: number;
    commaCount: number;
    lastArgStart: number;
    expr: string | null;
  }
  const stack: Frame[] = [];
  const limit = Math.min(pos, text.length);
  let i = 0;

  while (i < limit) {
    const ch = text[i];

    // Comments to end of line
    if (ch === "#") {
      while (i < limit && text[i] !== "\n") i++;
      continue;
    }

    // String literals ('...', "...", '''...''', """...""")
    if (ch === "'" || ch === '"') {
      const triple = text[i + 1] === ch && text[i + 2] === ch;
      const quoteLen = triple ? 3 : 1;
      i += quoteLen;
      while (i < limit) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (triple) {
          if (text[i] === ch && text[i + 1] === ch && text[i + 2] === ch) {
            i += 3;
            break;
          }
          i++;
        } else {
          if (text[i] === ch || text[i] === "\n") {
            i++;
            break;
          }
          i++;
        }
      }
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      const expr = ch === "(" ? extractCallableBeforeParen(text, i) : null;
      stack.push({
        kind: ch,
        pos: i,
        commaCount: 0,
        lastArgStart: i + 1,
        expr,
      });
    } else if (ch === ")" || ch === "]" || ch === "}") {
      const expected = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].kind === expected) {
          stack.length = k;
          break;
        }
      }
    } else if (ch === "," && stack.length > 0) {
      const top = stack[stack.length - 1];
      top.commaCount++;
      top.lastArgStart = i + 1;
    }

    i++;
  }

  for (let k = stack.length - 1; k >= 0; k--) {
    const frame = stack[k];
    if (frame.kind === "(" && frame.expr) {
      const currentArgSlice = text.slice(frame.lastArgStart, limit).trimStart();
      const kwMatch = currentArgSlice.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/);
      return {
        expr: frame.expr,
        parenPos: frame.pos,
        argIndex: frame.commaCount,
        kwargName: kwMatch ? kwMatch[1] : null,
      };
    }
  }

  return null;
}

const setSignatureHelpEffect = StateEffect.define<SigTooltipData | null>();
const dismissSignatureEffect = StateEffect.define<number | null>();

const signatureHelpField = StateField.define<{
  data: SigTooltipData | null;
  dismissedParenPos: number | null;
}>({
  create() {
    return { data: null, dismissedParenPos: null };
  },
  update(value, tr) {
    let { data, dismissedParenPos } = value;
    for (const eff of tr.effects) {
      if (eff.is(setSignatureHelpEffect)) {
        data = eff.value;
      } else if (eff.is(dismissSignatureEffect)) {
        dismissedParenPos = eff.value;
        if (eff.value !== null) {
          data = null;
        }
      }
    }
    if (data && (tr.docChanged || tr.selection)) {
      const call = findActiveCallAt(tr.state.doc.toString(), tr.state.selection.main.head);
      if (!call || call.expr !== data.call.expr || call.parenPos !== data.call.parenPos) {
        data = null;
        if (!call || call.parenPos !== dismissedParenPos) {
          dismissedParenPos = null;
        }
      } else {
        data = { call, info: data.info };
      }
    } else if (!data && (tr.docChanged || tr.selection) && dismissedParenPos !== null) {
      const call = findActiveCallAt(tr.state.doc.toString(), tr.state.selection.main.head);
      if (!call || call.parenPos !== dismissedParenPos) {
        dismissedParenPos = null;
      }
    }
    return { data, dismissedParenPos };
  },
  provide(field) {
    return showTooltip.from(field, (val): Tooltip | null => {
      if (!val.data) return null;
      if (val.dismissedParenPos === val.data.call.parenPos) return null;
      const { call, info } = val.data;
      return {
        pos: call.parenPos + 1,
        above: true,
        strictSide: false,
        create() {
          const dom = renderSignatureTooltip(info, call);
          return { dom };
        },
      };
    });
  },
});

function resolveActiveParamIndex(info: SignatureHelpInfo, call: ActiveCallSite): number {
  const params = info.params;
  if (params.length === 0) return -1;

  if (call.kwargName) {
    const exactIdx = params.findIndex((p) => p.name === call.kwargName);
    if (exactIdx >= 0) return exactIdx;
    const kwIdx = params.findIndex((p) => p.name.startsWith("**"));
    return kwIdx;
  }

  let positionalLimit = params.length;
  const varPosIdx = params.findIndex((p) => p.name.startsWith("*") && !p.name.startsWith("**"));
  if (varPosIdx >= 0) {
    positionalLimit = varPosIdx;
  }

  if (call.argIndex < positionalLimit) {
    return call.argIndex;
  }
  if (varPosIdx >= 0) {
    return varPosIdx;
  }
  return -1;
}

function renderSignatureTooltip(info: SignatureHelpInfo, call: ActiveCallSite): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-signature-tooltip";

  const sigRow = document.createElement("div");
  sigRow.className = "cm-sig-header";

  const nameSpan = document.createElement("span");
  nameSpan.className = "cm-sig-name";
  nameSpan.textContent = info.name;
  sigRow.append(nameSpan, document.createTextNode("("));

  if (info.params.length > 0) {
    const activeIdx = resolveActiveParamIndex(info, call);
    info.params.forEach((p, idx) => {
      if (idx > 0) {
        sigRow.append(document.createTextNode(", "));
      }
      const pSpan = document.createElement("span");
      pSpan.className = idx === activeIdx ? "cm-sig-param cm-sig-param-active" : "cm-sig-param";
      pSpan.textContent = p.label;
      sigRow.append(pSpan);
    });
  } else {
    const inner = info.signature.replace(/^\(|\)$/g, "");
    if (inner) {
      const rawSpan = document.createElement("span");
      rawSpan.className = "cm-sig-param";
      rawSpan.textContent = inner;
      sigRow.append(rawSpan);
    }
  }
  sigRow.append(document.createTextNode(")"));
  wrap.append(sigRow);

  if (info.doc) {
    const docDiv = document.createElement("div");
    docDiv.className = "cm-sig-doc";
    docDiv.textContent = info.doc;
    wrap.append(docDiv);
  }

  return wrap;
}

export function createPythonAssistExtension(provider: PythonAssistProvider): Extension[] {
  const sigCache = new Map<string, SignatureHelpInfo | null>();

  const fetchSignatureForView = async (view: EditorView, force = false) => {
    if (provider.isEnabled && !provider.isEnabled()) {
      return;
    }
    const head = view.state.selection.main.head;
    const cellSource = view.state.doc.toString();
    const call = findActiveCallAt(cellSource, head);
    if (!call) {
      if (view.state.field(signatureHelpField).data) {
        view.dispatch({ effects: setSignatureHelpEffect.of(null) });
      }
      return;
    }

    const fieldState = view.state.field(signatureHelpField);
    if (!force && fieldState.dismissedParenPos === call.parenPos) {
      return;
    }

    const docSource = provider.getDocSource();
    const cacheKey = `${call.expr}::${docSource.length}::${cellSource.slice(0, call.parenPos).length}`;

    let info: SignatureHelpInfo | null | undefined = force ? undefined : sigCache.get(cacheKey);
    if (info === undefined) {
      try {
        info = await provider.signature({
          expr: call.expr,
          cellSource,
          docSource,
        });
      } catch {
        info = null;
      }
      if (sigCache.size > 120) sigCache.clear();
      sigCache.set(cacheKey, info);
    }

    // Re-check cursor position after async gap
    const latestHead = view.state.selection.main.head;
    const latestCall = findActiveCallAt(view.state.doc.toString(), latestHead);
    if (!latestCall || latestCall.expr !== call.expr || latestCall.parenPos !== call.parenPos) {
      return;
    }
    if (!info) {
      view.dispatch({ effects: setSignatureHelpEffect.of(null) });
      return;
    }
    view.dispatch({
      effects: [
        ...(force ? [dismissSignatureEffect.of(null)] : []),
        setSignatureHelpEffect.of({ call: latestCall, info }),
      ],
    });
  };

  const signatureWatcher = ViewPlugin.fromClass(
    class {
      private timer: number | undefined;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate) {
        if (provider.isEnabled && !provider.isEnabled()) {
          clearTimeout(this.timer);
          return;
        }
        if (!update.docChanged && !update.selectionSet) return;
        const call = findActiveCallAt(update.state.doc.toString(), update.state.selection.main.head);
        if (!call) {
          clearTimeout(this.timer);
          return;
        }
        const curData = update.state.field(signatureHelpField).data;
        if (curData && curData.call.expr === call.expr && curData.call.parenPos === call.parenPos) {
          return;
        }
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          void fetchSignatureForView(this.view, false);
        }, 45);
      }

      destroy() {
        clearTimeout(this.timer);
      }
    },
  );

  const signatureKeymap = keymap.of([
    {
      key: "Mod-Shift-Space",
      run(view) {
        void fetchSignatureForView(view, true);
        return true;
      },
    },
    {
      key: "Escape",
      run(view) {
        if (completionStatus(view.state) === "active") {
          return false;
        }
        const fieldState = view.state.field(signatureHelpField);
        if (!fieldState.data) return false;
        view.dispatch({
          effects: dismissSignatureEffect.of(fieldState.data.call.parenPos),
        });
        return true;
      },
    },
  ]);

  const COMPLETION_LIMIT = 80;

  const pythonCompletionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (provider.isEnabled && !provider.isEnabled()) {
      return null;
    }
    // Let `symbolCompletions` handle `\rho`, `\sigma`, `\i`, etc.
    if (ctx.matchBefore(/\\[A-Za-z0-9_]*$/)) {
      return null;
    }

    const nodeName = syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name;
    if (/Comment|String/i.test(nodeName)) {
      return null;
    }

    const line = ctx.state.doc.lineAt(ctx.pos);
    const lineBefore = line.text.slice(0, ctx.pos - line.from);

    // 1. Attribute completion: `obj.sub.` or `obj.pr`
    const dotMatch = lineBefore.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z0-9_]*)$/);
    if (dotMatch) {
      const attrTarget = dotMatch[1];
      const prefix = dotMatch[2];
      const from = ctx.pos - prefix.length;
      const items = await provider.complete({
        prefix,
        attrTarget,
        cellSource: ctx.state.doc.toString(),
        docSource: provider.getDocSource(),
      });
      if (ctx.aborted || items.length === 0) return null;
      return {
        from,
        options: items.map(toCodeMirrorCompletion),
        validFor: items.length < COMPLETION_LIMIT ? /^[A-Za-z0-9_]*$/ : undefined,
      };
    }

    // 2. Bare identifier completion (needs at least 2 chars or explicit Ctrl+Space)
    const wordMatch = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*$/);
    if (!wordMatch && !ctx.explicit) return null;
    const prefix = wordMatch ? wordMatch.text : "";
    if (!ctx.explicit && prefix.length < 2) return null;

    const items = await provider.complete({
      prefix,
      attrTarget: null,
      cellSource: ctx.state.doc.toString(),
      docSource: provider.getDocSource(),
    });
    if (ctx.aborted || items.length === 0) return null;

    return {
      from: wordMatch ? wordMatch.from : ctx.pos,
      options: items.map(toCodeMirrorCompletion),
      validFor: items.length < COMPLETION_LIMIT ? /^[A-Za-z0-9_]*$/ : undefined,
    };
  };

  return [
    signatureHelpField,
    signatureWatcher,
    signatureKeymap,
    EditorState.languageData.of(() => [{ autocomplete: pythonCompletionSource }]),
  ];
}

function toCodeMirrorCompletion(item: PythonCompletionItem): Completion {
  return {
    label: item.label,
    type: item.kind,
    detail: item.detail || undefined,
    info: item.doc || undefined,
    boost: item.kind === "variable" || item.kind === "function" || item.kind === "method" ? 1 : 0,
  };
}
