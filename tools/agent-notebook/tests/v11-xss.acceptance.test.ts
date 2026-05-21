// 红队 v1.1 验收测试 —— 契约 11: XSS 防护边界（hljs 集成 + escapeHtml）
//
// 覆盖：
//   - code 块 content 字段是原始字符串（含 <script> 字面），交由前端 hljs 内部转义
//   - markdown 块 html 字段中 lesson.md 文本里的 <script> 字面必须实体转义为 &lt;script&gt;
//
// 这是设计决议 7 + 契约 2 + 契约 11 的硬验证。
// 严格黑盒：spawn server.ts，所有断言通过 fetch + JSON。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, stopServer, type ServerHandle } from "./helpers/server.ts";

const V11_XSS =
  "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/tools/agent-notebook/tests/fixtures/v11/xss";

let handle: ServerHandle | null = null;

beforeAll(async () => {
  handle = await startServer(V11_XSS);
});

afterAll(async () => {
  await stopServer(handle);
  handle = null;
});

type Block =
  | { type: "markdown"; html: string }
  | {
      type: "code";
      lang: string;
      content: string;
      source: { file: string; section: number | string };
    }
  | { type: "log"; content: string; source: Record<string, unknown> }
  | { type: "error"; message: string; raw: string };

async function fetchBlocks(): Promise<Block[]> {
  const res = await fetch(`${handle!.baseUrl}/api/lesson`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { blocks: Block[] };
  expect(Array.isArray(json.blocks)).toBe(true);
  return json.blocks;
}

describe("XSS 防护：契约 11 + 决议 7", () => {
  test("code 块 content 字段保留原始 <script> 字面（不预先 escapeHtml，交由前端 hljs 转义）", async () => {
    const blocks = await fetchBlocks();
    const codeBlocks = blocks.filter((b): b is Extract<Block, { type: "code" }> => b.type === "code");
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);

    // 找到引用 snippet.ts section=1 的 code 块
    const xssBlock = codeBlocks.find(
      (b) => b.source.section === 1 && b.source.file.includes("snippet.ts"),
    );
    expect(xssBlock).toBeDefined();

    // 关键断言：content 是原始字符串，含 raw `<script>alert(1)</script>` 字面
    expect(xssBlock!.content).toContain("<script>alert(1)</script>");
    // 应同时含我们 fixture 中的字符串字面 payload
    expect(xssBlock!.content).toContain("<script>alert('also-as-string')</script>");

    // 反向断言：content 不应预先 escape 为 &lt;
    // （如果蓝队错误地预先 escapeHtml，content 会变成 "&lt;script&gt;..."）
    expect(xssBlock!.content).not.toContain("&lt;script&gt;");
    expect(xssBlock!.content).not.toContain("&lt;/script&gt;");
  });

  test("code 块 content 首行是 section 起点注释（slice 起点正确）", async () => {
    const blocks = await fetchBlocks();
    const xssBlock = blocks.find(
      (b): b is Extract<Block, { type: "code" }> =>
        b.type === "code" && b.source.section === 1,
    );
    expect(xssBlock).toBeDefined();
    const firstLine = xssBlock!.content.split("\n")[0];
    expect(firstLine).toContain("// ---------- 1. xss block ----------");
  });

  test("markdown 块 html 字段必须将 lesson.md 中的 <script> 字面转义为 &lt;script&gt;", async () => {
    const blocks = await fetchBlocks();
    const mdBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "markdown" }> => b.type === "markdown",
    );
    expect(mdBlocks.length).toBeGreaterThanOrEqual(1);

    // 拼接所有 markdown.html 全文检查
    const allHtml = mdBlocks.map((b) => b.html).join("\n");
    expect(allHtml.length).toBeGreaterThan(0);

    // 关键断言 1：lesson.md 文本中含 <script>alert('lesson-md')</script> 字面，
    // 渲染后 markdown.html 必须为实体转义形式（contract 2）
    expect(allHtml).toContain("&lt;script&gt;");
    expect(allHtml).toContain("&lt;/script&gt;");

    // 关键断言 2：绝不能含原始可执行 <script> 标签
    // 注意：必须排除合法 attribute 中的 "script" 文本（HTML 渲染器无此风险，因为我们手写最小 markdown）
    // 直接检查不含 "<script>" 与 "</script>" 字面（小写）
    expect(allHtml).not.toContain("<script>");
    expect(allHtml).not.toContain("</script>");
  });

  test("响应整体（序列化 JSON）不含可执行 <script> 标签字面", async () => {
    // 防御性兜底：把整个响应当字符串扫一遍，凡是 raw <script> 都必须包在 code.content 字段里
    // （code.content 是 JSON 字符串值，序列化后会显示为 "<script>" 但被双引号包裹）
    // 这里只检查：markdown.html 字段里不能逃逸出 raw <script>
    const blocks = await fetchBlocks();
    const mdBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "markdown" }> => b.type === "markdown",
    );

    for (const mb of mdBlocks) {
      // markdown html 不能含原生可执行 script tag
      const lower = mb.html.toLowerCase();
      // 允许 attribute / 文本中含 "script" 字样，但严禁 `<script` 开始标签
      expect(lower.includes("<script")).toBe(false);
      expect(lower.includes("</script")).toBe(false);
    }
  });

  test("XSS fixture 的 lesson.md 解析无错误块（slice 成功 + markdown 转义成功）", async () => {
    const blocks = await fetchBlocks();
    const errorBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "error" }> => b.type === "error",
    );
    // XSS fixture 设计为全部正常 slice，无错误降级；如有 error 说明 fixture 或 slice 实现有问题
    expect(errorBlocks.length).toBe(0);
  });

  test("blocks 顺序与 fixture lesson.md 一致：先 markdown，后 code", async () => {
    const blocks = await fetchBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    // 第一个非 markdown 块应是 code（来自 @include(./snippet.ts, section=1)）
    const firstCodeIdx = blocks.findIndex((b) => b.type === "code");
    const firstMdIdx = blocks.findIndex((b) => b.type === "markdown");
    expect(firstMdIdx).toBeGreaterThanOrEqual(0);
    expect(firstCodeIdx).toBeGreaterThanOrEqual(0);
    expect(firstMdIdx).toBeLessThan(firstCodeIdx); // markdown 一定先出现
  });
});
