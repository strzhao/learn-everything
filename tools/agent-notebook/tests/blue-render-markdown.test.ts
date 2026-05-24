import { test, expect } from "bun:test";
import { renderMarkdown, escapeHtml } from "../lib/render-markdown";

test("escapeHtml escapes < > & \" '", () => {
  expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
    `&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;`,
  );
});

test("renderMarkdown handles H1-H3", () => {
  const html = renderMarkdown("# Title\n## Sub\n### Tiny");
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<h2>Sub</h2>");
  expect(html).toContain("<h3>Tiny</h3>");
});

test("renderMarkdown handles paragraph + inline code + bold", () => {
  const html = renderMarkdown("hello `code` and **bold** text");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<p>");
});

test("renderMarkdown handles unordered list", () => {
  const html = renderMarkdown("- one\n- two\n- three");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<li>three</li>");
});

test("renderMarkdown escapes raw < > & in paragraph", () => {
  const html = renderMarkdown("a < b && c > d");
  expect(html).toContain("&lt;");
  expect(html).toContain("&gt;");
  expect(html).toContain("&amp;");
  expect(html).not.toContain("<script>");
});

test("renderMarkdown does not allow injecting raw HTML", () => {
  const html = renderMarkdown("hello <script>alert(1)</script>");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

// --- 以下为 marked + DOMPurify 引入后新增的语法覆盖 ---

test("renderMarkdown handles blockquote (>)", () => {
  const html = renderMarkdown("> hello world");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("hello world");
});

test("renderMarkdown handles ordered list (1. 2.)", () => {
  const html = renderMarkdown("1. foo\n2. bar");
  expect(html).toContain("<ol>");
  expect(html).toContain("<li>foo</li>");
  expect(html).toContain("<li>bar</li>");
});

test("renderMarkdown handles links [text](url)", () => {
  const html = renderMarkdown("see [home](https://example.com)");
  expect(html).toContain(`<a href="https://example.com">home</a>`);
});

test("renderMarkdown strips javascript: links (XSS)", () => {
  const html = renderMarkdown("[x](javascript:alert(1))");
  expect(html).not.toContain("javascript:");
});

test("renderMarkdown handles nested lists", () => {
  const html = renderMarkdown("- a\n  - b\n- c");
  // 嵌套：a 的 <li> 内部应再次出现 <ul>
  expect(html).toMatch(/<li>a[\s\S]*<ul>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>[\s\S]*<\/li>/);
});

test("renderMarkdown handles strikethrough (~~x~~)", () => {
  const html = renderMarkdown("~~gone~~");
  expect(html).toContain("<del>gone</del>");
});

test("renderMarkdown handles italic (*x* / _x_)", () => {
  const html = renderMarkdown("*it* and _also_");
  expect(html).toContain("<em>it</em>");
  expect(html).toContain("<em>also</em>");
});

test("renderMarkdown handles task list (- [ ] / - [x])", () => {
  const html = renderMarkdown("- [ ] todo\n- [x] done");
  expect(html).toMatch(/<input[^>]+type="checkbox"/);
  expect(html).toMatch(/<input[^>]+checked/);
});

test("renderMarkdown handles horizontal rule (---)", () => {
  const html = renderMarkdown("before\n\n---\n\nafter");
  expect(html).toContain("<hr>");
});

test("renderMarkdown handles backslash escape (\\*not bold\\*)", () => {
  const html = renderMarkdown("\\*not bold\\*");
  expect(html).not.toContain("<strong>");
  expect(html).toContain("*not bold*");
});

test("renderMarkdown emits fenced code with md-code class + data-md-lang for hljs hook", () => {
  const html = renderMarkdown("```ts\nconst x = 1;\n```");
  expect(html).toContain(`class="md-code"`);
  expect(html).toContain(`data-md-lang="ts"`);
});

test("renderMarkdown emits GFM table with md-table class", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  expect(html).toContain(`class="md-table"`);
  expect(html).toContain("<th>a</th>");
  expect(html).toContain("<td>1</td>");
});
