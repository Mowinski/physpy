import { describe, expect, it } from "vitest";
import {
  renderMarkdownWithLatex,
  renderStdoutWithLatexHtml,
  stripCommentedMarkdown,
} from "../src/markdownLatex";

describe("markdownLatex", () => {
  describe("stripCommentedMarkdown", () => {
    it("uncomments multi-line or math-containing # commented markdown blocks", () => {
      const raw = "# ## Heading\n# Formula: $$E = mc^2$$\n# - item 1";
      expect(stripCommentedMarkdown(raw)).toBe("## Heading\nFormula: $$E = mc^2$$\n- item 1");
    });

    it("leaves normal uncommented markdown untouched", () => {
      const md = "# Title\nNormal paragraph with $x^2$.";
      expect(stripCommentedMarkdown(md)).toBe(md);
    });
  });

  describe("renderMarkdownWithLatex", () => {
    it("renders headings, bold, italic, links, inline code, and fenced code blocks", () => {
      const md = [
        "# Main Title",
        "Paragraph with **bold**, *italic*, `inline_code()`, and [PhysPy](https://example.com).",
        "```python",
        "x = 1 < 2 & 3",
        "```",
      ].join("\n");

      const html = renderMarkdownWithLatex(md);
      expect(html).toContain('<h1 class="md-h1">Main Title</h1>');
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain('<code class="md-inline-code">inline_code()</code>');
      expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">PhysPy</a>');
      expect(html).toContain('<pre class="md-code-block" data-lang="python"><code>x = 1 &lt; 2 &amp; 3</code></pre>');
    });

    it("renders inline math ($...$, \\(...\\)) and display math ($$...$$, \\[...\\]) with KaTeX", () => {
      const md = [
        "Inline $\\rho_0$ and \\(\\omega_0\\).",
        "",
        "$$\\Delta p = \\rho_0 g h$$",
        "",
        "\\[E = \\hbar \\omega\\]",
      ].join("\n");

      const html = renderMarkdownWithLatex(md);
      expect(html).toContain("md-math-inline");
      expect(html).toContain("md-math-block");
      expect(html).toContain("katex");
    });

    it("renders blockquotes, lists, horizontal rules, and markdown tables", () => {
      const md = [
        "> Quoted note",
        "",
        "---",
        "",
        "- First bullet",
        "- Second bullet",
        "",
        "1. Step one",
        "2. Step two",
        "",
        "| Param | Value |",
        "| --- | --- |",
        "| $g$ | 9.81 |",
      ].join("\n");

      const html = renderMarkdownWithLatex(md);
      expect(html).toContain("<blockquote>Quoted note</blockquote>");
      expect(html).toContain("<hr />");
      expect(html).toContain("<ul><li>First bullet</li><li>Second bullet</li></ul>");
      expect(html).toContain("<ol><li>Step one</li><li>Step two</li></ol>");
      expect(html).toContain('<table class="md-table">');
      expect(html).toContain("<th>Param</th><th>Value</th>");
    });
  });

  describe("renderStdoutWithLatexHtml", () => {
    it("escapes plain stdout when no $ is present", () => {
      expect(renderStdoutWithLatexHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    });

    it("renders inline $...$ and display $$...$$ math in stdout while supporting escaped \\$", () => {
      const out = renderStdoutWithLatexHtml("Price: \\$10, mass $m_1 = 5$, energy $$E = mc^2$$");
      expect(out).toContain("Price: $10");
      expect(out).toContain("output-math-inline");
      expect(out).toContain("output-math-block");
      expect(out).toContain("katex");
    });
  });
});
