import { replaceSymbolsInIdent } from "./editor/symbols";

/**
 * Splits a single source line into its code portion and trailing `# ...` comment,
 * ignoring `#` characters inside single- or double-quoted string literals.
 */
export function splitCodeAndComment(line: string): { code: string; comment: string | null } {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return {
        code: line.slice(0, i),
        comment: line.slice(i + 1).trim() || null,
      };
    }
  }

  return { code: line, comment: null };
}

function normalizeDescComment(raw: string | null): string | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("%%")) return null;
  if (/^@media\s*:/i.test(cleaned)) return null;
  cleaned = cleaned.replace(/^@desc\s*:\s*/i, "").trim();
  return cleaned || null;
}

function extractAssignedTargets(code: string): string[] {
  let trimmed = code.trim();
  if (!trimmed || /^(?:def|class|if|elif|else|for|while|with|try|except|finally|return|import|from)\b/.test(trimmed)) {
    return [];
  }

  // Strip optional export / const prefixes
  trimmed = trimmed.replace(/^(?:export\s+const|const\s+export|export|const)\b\s*/, "");

  // Match simple assignment `lhs = rhs` (excluding `==`, `!=`, `<=`, `>=`)
  const eqIdx = trimmed.search(/(?<![=!<>])=(?!=)/);
  if (eqIdx <= 0) return [];

  const lhs = trimmed.slice(0, eqIdx).trim();
  if (!lhs) return [];

  // Strip optional type annotation `x: float`
  const parts = lhs.split(",");
  const names: string[] = [];
  for (const part of parts) {
    const withoutType = part.split(":")[0].trim();
    if (/^(?:\\[A-Za-z]+\w*|[A-Za-z_]\w*)$/.test(withoutType)) {
      names.push(withoutType);
    }
  }
  return names;
}

/**
 * Extracts variable descriptions from a Python/PhysPy source string.
 * Supports inline comments (`m_0 = 24.5 g  # masa piknometru`) and
 * comment lines immediately above a definition (`# @desc: ...` or `# ...`).
 * Stores both the raw identifier and its normalized Python identifier (`\rho` -> `rho`).
 */
export function extractVariableDescriptions(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  let pendingComment: string | null = null;

  for (const line of lines) {
    const { code, comment } = splitCodeAndComment(line);
    const trimmedCode = code.trim();

    if (!trimmedCode) {
      if (comment !== null) {
        pendingComment = normalizeDescComment(comment);
      } else {
        // Blank line resets pending comment so unrelated comments don't leak down
        pendingComment = null;
      }
      continue;
    }

    const targets = extractAssignedTargets(trimmedCode);
    const desc = normalizeDescComment(comment) ?? pendingComment;
    pendingComment = null;

    if (targets.length > 0 && desc) {
      for (const rawName of targets) {
        map.set(rawName, desc);
        const pyName = replaceSymbolsInIdent(rawName);
        if (pyName && pyName !== rawName) {
          map.set(pyName, desc);
        }
      }
    }
  }

  return map;
}

/**
 * Updates or removes the inline description comment on a variable's definition line.
 * Returns the updated source and whether a matching definition was found.
 */
export function updateVariableDescriptionInSource(
  source: string,
  varName: string,
  newDescription: string,
): { updated: string; changed: boolean } {
  const targetNorm = replaceSymbolsInIdent(varName.trim());
  const cleanDesc = newDescription.replace(/\r?\n/g, " ").trim();
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const { code } = splitCodeAndComment(lines[i]);
    const targets = extractAssignedTargets(code);
    const matches = targets.some((t) => t === varName.trim() || replaceSymbolsInIdent(t) === targetNorm);
    if (!matches) continue;

    const codeTrimmed = code.replace(/\s+$/, "");
    if (cleanDesc) {
      lines[i] = `${codeTrimmed}  # ${cleanDesc}`;
    } else {
      lines[i] = codeTrimmed;
    }

    // Remove a `# @desc:` comment immediately above if present to avoid stale duplicates
    if (i > 0) {
      const prev = splitCodeAndComment(lines[i - 1]);
      if (!prev.code.trim() && prev.comment && /^@desc\s*:/i.test(prev.comment)) {
        lines.splice(i - 1, 1);
      }
    }

    return { updated: lines.join("\n"), changed: true };
  }

  return { updated: source, changed: false };
}
