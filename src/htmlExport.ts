/**
 * Generates a standalone, single-file static HTML report from a PhysPy notebook.
 * - Code cells are wrapped in native HTML5 `<details>` (folded by default, expandable).
 * - Rendered Markdown + LaTeX formulas (KaTeX), tables, and plots are embedded directly.
 * - Zero external runtime dependencies required (lightweight KaTeX CSS included).
 */

import type { CellState } from "./main";
import { renderMarkdownWithLatex } from "./markdownLatex";
import type { TableOutput } from "./backend";

export type CodeExportVisibility = "folded" | "expanded" | "hidden";

export interface HtmlExportOptions {
  title: string;
  notebookName: string;
  documentPath: string | null;
  codeVisibility: CodeExportVisibility;
  selectedCellIds: Set<number>;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTableToHtml(tbl: TableOutput): string {
  const parts: string[] = [];
  parts.push('<div class="nb-table-wrap">');
  parts.push('<table class="nb-table">');

  // Header
  parts.push("<thead><tr>");
  parts.push(`<th class="nb-corner-th">${escapeHtml(tbl.index_name || "#")}</th>`);
  for (const col of tbl.columns) {
    const unitStr = col.unit ? ` <span class="nb-unit">[${escapeHtml(col.unit)}]</span>` : "";
    parts.push(`<th>${escapeHtml(col.name)}${unitStr}</th>`);
  }
  parts.push("</tr></thead>");

  // Body
  parts.push("<tbody>");
  for (const row of tbl.rows) {
    parts.push("<tr>");
    parts.push(`<th class="nb-row-th">${escapeHtml(row.index)}</th>`);
    row.cells.forEach((cellVal, ci) => {
      const isNum = tbl.columns[ci]?.is_numeric;
      const numClass = isNum ? ' class="num"' : "";
      parts.push(`<td${numClass}>${escapeHtml(cellVal)}</td>`);
    });
    parts.push("</tr>");
  }
  parts.push("</tbody>");
  parts.push("</table>");

  const rowWord = tbl.total_rows === 1 ? "row" : "rows";
  const colWord = tbl.columns.length === 1 ? "column" : "columns";
  const footerText = tbl.truncated
    ? `Showing first ${tbl.rows.length} of ${tbl.total_rows} ${rowWord} × ${tbl.columns.length} ${colWord}`
    : `${tbl.total_rows} ${rowWord} × ${tbl.columns.length} ${colWord}`;
  parts.push(`<div class="nb-table-footer">${escapeHtml(footerText)}</div>`);
  parts.push("</div>");
  return parts.join("\n");
}

export function generateStaticNotebookHtml(
  cells: CellState[],
  options: HtmlExportOptions,
): string {
  const exportDate = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const includedCells = cells.filter((c) => options.selectedCellIds.has(c.id));
  const renderedCells: string[] = [];

  includedCells.forEach((c, idx) => {
    const cellNum = idx + 1;
    const cellTitle = c.title.trim() || `Cell ${cellNum}`;

    if (c.kind === "markdown") {
      const rawDoc = c.view.state.doc.toString();
      const renderedMd = renderMarkdownWithLatex(rawDoc);
      renderedCells.push(`
        <section class="nb-cell nb-cell-markdown" id="cell-${cellNum}">
          <div class="nb-markdown-body">${renderedMd}</div>
        </section>
      `);
      return;
    }

    if (c.kind === "media") {
      const name = c.mediaPath.split(/[\\/]/).filter(Boolean).pop() || "Media";
      const isImg = /\.(png|jpe?g|svg|webp|gif)$/i.test(c.mediaPath);
      let mediaBody = "";
      if (isImg && c.mediaPath) {
        mediaBody = `<div class="nb-media-wrap"><img src="${escapeHtml(c.mediaPath)}" alt="${escapeHtml(name)}" class="nb-media-img" /></div>`;
      } else {
        mediaBody = `<div class="nb-media-placeholder">📄 Embedded document: <strong>${escapeHtml(name)}</strong></div>`;
      }
      renderedCells.push(`
        <section class="nb-cell nb-cell-media" id="cell-${cellNum}">
          <div class="nb-media-header"><span class="nb-badge nb-badge-media">📄 Media</span> <span class="nb-cell-name">${escapeHtml(cellTitle)}</span></div>
          ${mediaBody}
        </section>
      `);
      return;
    }

    if (c.kind === "deps") {
      const src = c.view.state.doc.toString().trim();
      const linesCount = src ? src.split("\n").length : 0;
      const venvTag = c.venvPath ? ` (${c.venvPath})` : "";
      if (options.codeVisibility === "hidden") {
        return;
      }
      const openAttr = options.codeVisibility === "expanded" ? " open" : "";
      renderedCells.push(`
        <section class="nb-cell nb-cell-deps" id="cell-${cellNum}">
          <details class="nb-code-details"${openAttr}>
            <summary class="nb-code-summary">
              <span class="nb-badge nb-badge-deps">📦 Packages</span>
              <span class="nb-cell-name">${escapeHtml(cellTitle)}${escapeHtml(venvTag)}</span>
              <span class="nb-lines-badge">${linesCount} ${linesCount === 1 ? "package" : "packages"}</span>
            </summary>
            <div class="nb-code-content">
              <pre class="nb-code-pre"><code class="language-python">${escapeHtml(src)}</code></pre>
            </div>
          </details>
        </section>
      `);
      return;
    }

    // Code cell
    const codeSrc = c.view.state.doc.toString();
    const lines = codeSrc.split("\n");
    const linesCount = lines.length;

    const codeSectionHtml: string =
      options.codeVisibility === "hidden"
        ? ""
        : `
          <details class="nb-code-details"${options.codeVisibility === "expanded" ? " open" : ""}>
            <summary class="nb-code-summary">
              <span class="nb-badge nb-badge-code">⚛ Code</span>
              <span class="nb-cell-name">${escapeHtml(cellTitle)}</span>
              <span class="nb-lines-badge">${linesCount} ${linesCount === 1 ? "line" : "lines"}</span>
            </summary>
            <div class="nb-code-content">
              <pre class="nb-code-pre"><code class="language-python">${escapeHtml(codeSrc)}</code></pre>
            </div>
          </details>
        `;

    // Outputs
    const outputParts: string[] = [];

    // 1. Exported bar
    const exportedKeys = Object.keys(c.lastExported || {});
    if (exportedKeys.length > 0) {
      const formatted = exportedKeys.map((k) => `${k} = ${c.lastExported[k]}`).join(", ");
      outputParts.push(`<div class="nb-exported">↳ exported: ${escapeHtml(formatted)}</div>`);
    }

    // 2. KaTeX LaTeX display
    if (c.lastLatex) {
      outputParts.push(`<div class="nb-latex">${c.latexWrap.innerHTML}</div>`);
    }

    // 3. Matplotlib Plots
    if (c.lastPlots && c.lastPlots.length > 0) {
      outputParts.push('<div class="nb-plots">');
      for (const b64 of c.lastPlots) {
        outputParts.push(
          `<div class="nb-plot-card"><img src="data:image/png;base64,${b64}" alt="Plot" class="nb-plot" /></div>`,
        );
      }
      outputParts.push("</div>");
    }

    // 4. Pandas / Structured Tables
    if (c.lastTables && c.lastTables.length > 0) {
      for (const tbl of c.lastTables) {
        outputParts.push(renderTableToHtml(tbl));
      }
    }

    // 5. Stdout / Stderr
    const stdout =
      c.lastTables.length > 0 && c.tableViewMode === "table"
        ? c.lastNonTableStdout
        : c.lastFullStdout;
    const stderr = c.lastStderr;
    if (stdout || stderr) {
      outputParts.push('<pre class="nb-output-text">');
      if (stdout) {
        outputParts.push(escapeHtml(stdout));
      }
      if (stderr) {
        outputParts.push(`<span class="nb-stderr">${escapeHtml(stderr)}</span>`);
      }
      outputParts.push("</pre>");
    }

    const outputHtml =
      outputParts.length > 0
        ? `<div class="nb-cell-output">${outputParts.join("\n")}</div>`
        : "";

    renderedCells.push(`
      <section class="nb-cell nb-cell-code" id="cell-${cellNum}">
        ${codeSectionHtml}
        ${outputHtml}
      </section>
    `);
  });

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(options.title || options.notebookName || "PhysPy Notebook")}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css" crossorigin="anonymous" />
  <style>
    :root {
      --bg: #1e2227;
      --card-bg: #23272e;
      --panel-bg: #282c34;
      --code-bg: #1b1e23;
      --border: #333842;
      --border-subtle: #2c313a;
      --text: #abb2bf;
      --text-bright: #e6edf3;
      --accent: #61afef;
      --accent-dim: rgba(97, 175, 239, 0.12);
      --green: #98c379;
      --purple: #c678dd;
      --yellow: #e5c07b;
      --danger: #e06c75;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }

    html[data-theme="light"] {
      --bg: #f6f8fa;
      --card-bg: #ffffff;
      --panel-bg: #eaeef2;
      --code-bg: #f0f3f6;
      --border: #d0d7de;
      --border-subtle: #e1e4e8;
      --text: #24292f;
      --text-bright: #1f2328;
      --accent: #0969da;
      --accent-dim: rgba(9, 105, 218, 0.08);
      --green: #1a7f37;
      --purple: #8250df;
      --yellow: #9a6700;
      --danger: #cf222e;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14.5px;
      line-height: 1.6;
    }

    /* Container */
    .nb-container {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px 20px 80px;
    }

    /* Header & Navigation Bar */
    .nb-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      padding-bottom: 20px;
      margin-bottom: 28px;
      border-bottom: 1px solid var(--border);
    }
    .nb-title-group h1 {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-bright);
    }
    .nb-meta {
      font-size: 12.5px;
      opacity: 0.75;
    }
    .nb-meta strong {
      color: var(--accent);
    }

    .nb-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .nb-btn {
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .nb-btn:hover {
      background: var(--panel-bg);
      border-color: var(--accent);
      color: var(--text-bright);
    }

    /* Cell layout */
    .nb-cell {
      margin-bottom: 20px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
    .nb-cell-markdown {
      background: transparent;
      border: none;
      box-shadow: none;
      padding: 4px 8px;
    }

    /* Badges */
    .nb-badge {
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .nb-badge-code {
      background: rgba(97, 175, 239, 0.14);
      color: var(--accent);
      border: 1px solid rgba(97, 175, 239, 0.3);
    }
    .nb-badge-deps {
      background: rgba(152, 195, 121, 0.14);
      color: var(--green);
      border: 1px solid rgba(152, 195, 121, 0.3);
    }
    .nb-badge-media {
      background: rgba(229, 192, 123, 0.14);
      color: var(--yellow);
      border: 1px solid rgba(229, 192, 123, 0.3);
    }

    /* Code folding details */
    .nb-code-details {
      background: var(--panel-bg);
    }
    .nb-code-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      color: var(--text);
      list-style: none;
      border-bottom: 1px solid transparent;
      transition: background 0.12s;
    }
    .nb-code-summary::-webkit-details-marker {
      display: none;
    }
    .nb-code-summary:hover {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-bright);
    }
    .nb-code-details[open] .nb-code-summary {
      border-bottom-color: var(--border);
    }
    .nb-cell-name {
      font-weight: 500;
      color: var(--text-bright);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nb-lines-badge {
      font-size: 11px;
      opacity: 0.6;
      font-family: var(--font-mono);
    }

    .nb-code-content {
      background: var(--code-bg);
    }
    .nb-code-pre {
      margin: 0;
      padding: 12px 16px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 13.5px;
      line-height: 1.5;
      color: var(--text-bright);
    }

    /* Output Section */
    .nb-cell-output {
      padding: 12px 16px;
      background: var(--card-bg);
      border-top: 1px solid var(--border);
    }
    .nb-exported {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--green);
      padding: 4px 8px;
      background: rgba(152, 195, 121, 0.08);
      border-left: 3px solid var(--green);
      margin-bottom: 10px;
      border-radius: 2px;
    }
    .nb-latex {
      padding: 10px 0;
      overflow-x: auto;
      text-align: center;
    }
    .nb-plots {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: center;
      margin: 8px 0;
    }
    .nb-plot-card {
      background: #ffffff;
      padding: 8px;
      border-radius: 6px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
      max-width: 100%;
    }
    .nb-plot {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .nb-output-text {
      margin: 8px 0 0;
      padding: 8px 12px;
      background: var(--code-bg);
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text);
    }
    .nb-stderr {
      color: var(--danger);
      display: block;
    }

    /* Tables */
    .nb-table-wrap {
      margin: 10px 0;
      overflow-x: auto;
    }
    .nb-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12.5px;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .nb-table th, .nb-table td {
      padding: 6px 10px;
      border: 1px solid var(--border);
      text-align: left;
    }
    .nb-table th {
      background: var(--panel-bg);
      color: var(--text-bright);
      font-weight: 600;
    }
    .nb-table th .nb-unit {
      color: var(--accent);
      font-weight: 500;
      font-size: 11px;
    }
    .nb-table td.num {
      text-align: right;
    }
    .nb-table tbody tr:nth-child(even) {
      background: rgba(255, 255, 255, 0.02);
    }
    .nb-table-footer {
      font-size: 11.5px;
      opacity: 0.65;
      margin-top: 4px;
      text-align: right;
    }

    /* Markdown styling */
    .nb-markdown-body h1, .nb-markdown-body h2, .nb-markdown-body h3, .nb-markdown-body h4 {
      color: var(--text-bright);
      margin-top: 24px;
      margin-bottom: 10px;
      line-height: 1.3;
    }
    .nb-markdown-body h1 { font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .nb-markdown-body h2 { font-size: 1.4em; }
    .nb-markdown-body h3 { font-size: 1.18em; }
    .nb-markdown-body p { margin: 8px 0; }
    .nb-markdown-body blockquote {
      border-left: 3px solid var(--accent);
      margin: 10px 0;
      padding: 4px 14px;
      background: var(--accent-dim);
      color: var(--text);
    }
    .nb-markdown-body code {
      background: var(--code-bg);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 0.9em;
    }
    .nb-markdown-body pre code {
      background: transparent;
      padding: 0;
    }
    .nb-markdown-body a {
      color: var(--accent);
      text-decoration: none;
    }
    .nb-markdown-body a:hover {
      text-decoration: underline;
    }

    /* Media */
    .nb-media-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
    }
    .nb-media-wrap {
      padding: 12px;
      text-align: center;
    }
    .nb-media-img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
    }
    .nb-media-placeholder {
      padding: 20px;
      text-align: center;
      font-style: italic;
      opacity: 0.75;
    }

    /* Footer */
    .nb-footer {
      text-align: center;
      padding-top: 40px;
      font-size: 12px;
      opacity: 0.55;
      border-top: 1px solid var(--border);
      margin-top: 40px;
    }

    /* Print styling */
    @media print {
      body {
        background: #ffffff !important;
        color: #000000 !important;
      }
      .nb-actions {
        display: none !important;
      }
      .nb-header {
        border-bottom: 2px solid #000000;
      }
      .nb-cell {
        box-shadow: none !important;
        border: 1px solid #cccccc !important;
        page-break-inside: avoid;
      }
      .nb-code-details {
        background: #f8f9fa !important;
      }
      .nb-code-pre {
        color: #000000 !important;
      }
      .nb-table th {
        background: #eeeeee !important;
        color: #000000 !important;
      }
      .nb-table th, .nb-table td {
        border-color: #dddddd !important;
      }
      .nb-code-details[open] summary, .nb-code-details summary {
        color: #000000 !important;
      }
    }
  </style>
</head>
<body>
  <div class="nb-container">
    <header class="nb-header">
      <div class="nb-title-group">
        <h1>${escapeHtml(options.title || options.notebookName || "PhysPy Notebook")}</h1>
        <div class="nb-meta">
          <span>Exported from <strong>${escapeHtml(options.notebookName || "notebook.ppy")}</strong> on ${escapeHtml(exportDate)}</span>
        </div>
      </div>
      <div class="nb-actions">
        <button id="btn-expand-all" class="nb-btn" type="button" title="Expand all code cells">▼ Expand Code</button>
        <button id="btn-collapse-all" class="nb-btn" type="button" title="Collapse all code cells">▶ Fold Code</button>
        <button id="btn-theme-toggle" class="nb-btn" type="button" title="Toggle dark/light theme">🌓 Theme</button>
        <button id="btn-print" class="nb-btn" type="button" title="Print document or save as PDF">🖨 Print</button>
      </div>
    </header>

    <main class="nb-notebook">
      ${renderedCells.join("\n")}
    </main>

    <footer class="nb-footer">
      Generated by <a href="https://github.com" target="_blank" rel="noopener" style="color:inherit;font-weight:600;">PhysPy</a> — Python &amp; Physics Laboratory Notebook
    </footer>
  </div>

  <script>
    (function() {
      var btnExpand = document.getElementById('btn-expand-all');
      var btnCollapse = document.getElementById('btn-collapse-all');
      var btnTheme = document.getElementById('btn-theme-toggle');
      var btnPrint = document.getElementById('btn-print');

      if (btnExpand) {
        btnExpand.addEventListener('click', function() {
          document.querySelectorAll('.nb-code-details').forEach(function(el) { el.open = true; });
        });
      }
      if (btnCollapse) {
        btnCollapse.addEventListener('click', function() {
          document.querySelectorAll('.nb-code-details').forEach(function(el) { el.open = false; });
        });
      }
      if (btnPrint) {
        btnPrint.addEventListener('click', function() { window.print(); });
      }
      if (btnTheme) {
        btnTheme.addEventListener('click', function() {
          var html = document.documentElement;
          var cur = html.getAttribute('data-theme') || 'dark';
          var next = cur === 'dark' ? 'light' : 'dark';
          html.setAttribute('data-theme', next);
        });
      }
    })();
  </script>
</body>
</html>`;
}
