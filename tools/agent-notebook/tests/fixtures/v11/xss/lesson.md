# XSS 防护红队测试课程（fixture：v11/xss）

这份课程用于验证设计决议 7（hljs 转义边界）+ 契约 11（XSS 红队验证）。

## 1. lesson.md 文本中的 `<script>` 字面

下面这段属于 markdown 段落（非 code 块），含 `<script>alert('lesson-md')</script>` 字面字符串，
parse-lesson 渲染为 markdown.html 时**必须**实体转义为 `&lt;script&gt;`。

## 2. 引用 snippet.ts section=1 —— code 块含 `<script>` 字面

@include(./snippet.ts, section=1)
