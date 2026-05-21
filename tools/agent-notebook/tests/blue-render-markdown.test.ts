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
