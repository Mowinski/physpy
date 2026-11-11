export type CsvDelimiter = "," | ";" | "\t";

/** Detect the most likely CSV delimiter (`,`, `;`, or `\t`) from text and optional filename. */
export function detectCsvDelimiter(text: string, pathHint?: string | null): CsvDelimiter {
  if (pathHint && /\.tsv$/i.test(pathHint)) return "\t";
  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  const lines: string[] = [];
  let inQuotes = false;
  let cur = "";
  for (let i = 0; i < text.length && lines.length < 15; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      cur += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (cur.trim().length > 0) lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0 && lines.length < 15) lines.push(cur);
  if (lines.length === 0) return ",";

  const countDelim = (line: string, delim: string): number => {
    let count = 0;
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') i++;
        else q = !q;
      } else if (ch === delim && !q) {
        count++;
      }
    }
    return count;
  };

  let bestDelim: CsvDelimiter = ",";
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((l) => countDelim(l, delim));
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    const first = counts[0];
    const consistent = counts.every((c) => c === first && c > 0);
    const total = nonZero.reduce((a, b) => a + b, 0);
    const score = (consistent ? 1000 : 0) + nonZero.length * 10 + total;
    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }
  return bestDelim;
}

/** Parse RFC 4180 CSV text into a rectangular 2D string array. */
export function parseCsv(text: string, delimiter: CsvDelimiter): string[][] {
  if (text.length === 0) return [[""]];

  // Strip UTF-8 BOM if present
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }

  // Push final field/row unless we're right after a trailing newline with nothing following
  if (fieldStarted || row.length > 0 || inQuotes) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [[""]];
  const maxCols = Math.max(1, ...rows.map((r) => r.length));
  for (const r of rows) {
    while (r.length < maxCols) r.push("");
  }
  return rows;
}

/** Serialize a 2D array back into RFC 4180 CSV text. */
export function serializeCsv(
  rows: string[][],
  delimiter: CsvDelimiter,
  lineEnding = "\n",
  trailingNewline = true,
): string {
  if (rows.length === 0) return "";
  const escapeField = (val: string): string => {
    const needsQuotes =
      val.includes(delimiter) ||
      val.includes('"') ||
      val.includes("\n") ||
      val.includes("\r");
    if (!needsQuotes) return val;
    return `"${val.replace(/"/g, '""')}"`;
  };
  const out = rows.map((r) => r.map(escapeField).join(delimiter)).join(lineEnding);
  return trailingNewline && out.length > 0 ? out + lineEnding : out;
}
