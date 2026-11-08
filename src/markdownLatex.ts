/**
 * Lightweight Markdown + LaTeX (KaTeX) renderer for PhysPy Markdown cells.
 * Supports:
 * - Display math: `$$ ... $$` and `\[ ... \]`
 * - Inline math: `$ ... $` and `\( ... \)`
 * - Headings (`#`..`######`), bold/italic, inline/fenced code blocks,
 *   lists (`-`, `*`, `1.`), blockquotes (`>`), tables (`| col |`), horizontal rules (`---`).
 */
import katex from "katex";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripCommentedMarkdown(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return raw;
  const allStartWithHash = nonEmpty.every((l) => /^\s*#/.test(l));
  const hasCommentedMathOrMd = nonEmpty.some((l) =>
    /^\s*#\s*(\$\$|\\\[|\\frac|\\int|\\sum|#{1,6}\s|[-*]\s)/.test(l),
  );
  if (allStartWithHash && (hasCommentedMathOrMd || nonEmpty.length > 1)) {
    return lines.map((l) => l.replace(/^\s*# ?/, "")).join("\n");
  }
  return raw;
}

export function renderMarkdownWithLatex(markdown: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const id = `\u0000PH_${placeholders.length}_\u0000`;
    placeholders.push(html);
    return id;
  };

  let text = stripCommentedMarkdown(markdown).replace(/\r\n/g, "\n");

  // 1. Stash fenced code blocks ```lang ... ```
  text = text.replace(/```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
    return stash(
      `<pre class="md-code-block"${langAttr}><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
    );
  });

  // 2. Stash inline code `...`
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) =>
    stash(`<code class="md-inline-code">${escapeHtml(code)}</code>`),
  );

  // 3. Stash display math `$$ ... $$` and `\[ ... \]`
  const renderMath = (tex: string, displayMode: boolean): string => {
    // Clean any stray leading `# ` comment markers inside multiline math blocks
    const cleanedTex = tex
      .split("\n")
      .map((l) => l.replace(/^\s*#\s?/, ""))
      .join("\n")
      .replace(/#\s*$/, "")
      .trim();
    try {
      const rendered = katex.renderToString(cleanedTex, {
        displayMode,
        throwOnError: false,
        output: "html",
      });
      return displayMode
        ? `<div class="md-math-block">${rendered}</div>`
        : `<span class="md-math-inline">${rendered}</span>`;
    } catch {
      return `<code>${escapeHtml(cleanedTex)}</code>`;
    }
  };

  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => stash(renderMath(tex, true)));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => stash(renderMath(tex, true)));

  // 4. Stash inline math `$ ... $` and `\( ... \)`
  text = text.replace(
    /(?<!\\|\$)\$(?!\s)((?:\\.|[^$\n])+?)(?<!\s|\\)\$(?!\$)/g,
    (_, tex: string) => stash(renderMath(tex, false)),
  );
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => stash(renderMath(tex, false)));

  // 5. Format inline Markdown on escaped text
  const formatInline = (raw: string): string => {
    let s = escapeHtml(raw);
    // Bold `**text**`
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Italic `*text*`
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    // Links `[label](url)`
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return s;
  };

  // 6. Process block-level elements line by line
  const lines = text.split("\n");
  const outHtml: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Standalone stashed block (fenced code or display math)
    if (/^\u0000PH_\d+_\u0000$/.test(trimmed)) {
      outHtml.push(trimmed);
      i++;
      continue;
    }

    // Heading `#`..`######`
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      outHtml.push(`<h${level} class="md-h${level}">${formatInline(headingMatch[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule `---` or `***`
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      outHtml.push("<hr />");
      i++;
      continue;
    }

    // Blockquote `> ...`
    if (trimmed.startsWith(">")) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      outHtml.push(`<blockquote>${qLines.map(formatInline).join("<br />")}</blockquote>`);
      continue;
    }

    // Markdown Table
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const parseRow = (rowStr: string) =>
        rowStr
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => formatInline(c.trim()));

      const headers = parseRow(lines[i]);
      i += 2; // skip header + separator line
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|")) {
        bodyRows.push(parseRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      outHtml.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }

    // Unordered list `- ` or `* `
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      outHtml.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list `1. `
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      outHtml.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s|(?:-{3,}|\*{3,})\s*$)/.test(lines[i])
    ) {
      paraLines.push(formatInline(lines[i]));
      i++;
    }
    outHtml.push(`<p>${paraLines.join("<br />")}</p>`);
  }

  // Restore placeholders
  let finalHtml = outHtml.join("\n");
  finalHtml = finalHtml.replace(/\u0000PH_(\d+)_\u0000/g, (_, idxStr: string) => {
    return placeholders[Number(idxStr)] ?? "";
  });

  return finalHtml;
}
