// markdown → HTML：marked (CommonMark + GFM) + DOMPurify XSS 净化
//
// 与原架构的契约约束（看 plan）：
//   - parse-lesson.ts 仍调用 renderMarkdown(md) 拿 HTML 字符串
//   - app.js 用 `pre.md-code[data-md-lang]` 找 fenced code，交给 hljs 着色
//       → 重写 code renderer，输出 <pre class="md-code" data-md-lang="..."><code>...</code></pre>
//   - style.css 用 .md-table 选择器
//       → 重写 table renderer，输出 <table class="md-table">...
//   - 契约 2 + 契约 11：lesson.md 里的 <script> 等 inline HTML 必须实体转义为 &lt;script&gt;
//       → 重写 html renderer，对原始 HTML 字面 escapeHtml，源头切断
//   - DOMPurify 兜底：剥离任何漏网的事件处理器 / 危险协议链接

import { Marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const langAttr = lang ? ` data-md-lang="${escapeHtml(lang)}"` : "";
      return `<pre class="md-code"${langAttr}><code>${escapeHtml(text)}</code></pre>\n`;
    },
    // 表格：marked 默认 <table>，加 .md-table class 对齐 style.css
    table(token) {
      let header = "";
      for (const cell of token.header) {
        header += this.tablecell(cell);
      }
      const head = `<thead>\n<tr>\n${header}</tr>\n</thead>\n`;
      let body = "";
      for (const row of token.rows) {
        let rowHtml = "";
        for (const cell of row) {
          rowHtml += this.tablecell(cell);
        }
        body += `<tr>\n${rowHtml}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      // wrapper 提供 overflow-x 兜底；table 自身保持正常 table 显示，宽度由 lesson 区决定
      return `<div class="md-table-wrap"><table class="md-table">\n${head}${body}</table></div>\n`;
    },
    // 把 lesson.md 里的 inline / block HTML 字面实体转义掉（契约 2 + 11）
    // text 可能是单个 token (Tag) 或整段 raw block；都按字面转义
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-md-lang"],
    // 默认白名单已包含 p/h1-6/ul/ol/li/blockquote/code/pre/table/thead/tbody/tr/th/td
    // /a/img/strong/em/del/hr/br/input/span/div 等；javascript: / data: 等危险协议默认过滤
  });
}
