// 红队验收测试 —— @include 语法 3 形态 + 错误降级 + HTML 实体转义
//
// 覆盖契约：
//   1. lesson.md @include 指令语法（section int / section string / round int + 互斥）
//   2. parseLesson 输出（错误块隔离、HTML 实体转义、块顺序）
//   3-5. slice 逻辑（通过 /api/lesson 间接验证）
//   7. error 块格式（含 message + raw 字段）
//
// 黑盒：使用 fixtures/errors，spawn server.ts，仅通过 fetch 断言。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  FIXTURES,
  startServer,
  stopServer,
  type ServerHandle,
} from "./helpers/server.ts";

let handle: ServerHandle | null = null;

beforeAll(async () => {
  handle = await startServer(FIXTURES.errors);
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
  | {
      type: "log";
      content: string;
      source: { file: string; round?: number; section?: string };
      stopReason?: string;
    }
  | { type: "error"; message: string; raw: string };

async function fetchBlocks(): Promise<Block[]> {
  const res = await fetch(`${handle!.baseUrl}/api/lesson`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { blocks: Block[] };
  expect(Array.isArray(json.blocks)).toBe(true);
  return json.blocks;
}

describe("@include 语法 3 主形态（契约 1）", () => {
  test("含正常 code section int + log round int + log section string 三形态时 fixtures/normal 全部成功（在另一个文件覆盖；这里只验 errors fixture 中也存在 round/section 形态）", async () => {
    // errors fixture 第八段是 @include(./run-log.txt, round=3)，应解析成功
    // 第四段是 @include(./agent.ts, section=3)，应解析成功
    const blocks = await fetchBlocks();
    const codeSection3 = blocks.find(
      (b) => b.type === "code" && (b.source as any)?.section === 3,
    );
    expect(codeSection3).toBeDefined();
    expect(codeSection3!.type).toBe("code");

    const logRound3 = blocks.find(
      (b) => b.type === "log" && (b.source as any)?.round === 3,
    );
    expect(logRound3).toBeDefined();
    expect(logRound3!.type).toBe("log");
    // fixture 引用的真实 run-log.txt round 3 stop_reason=end_turn
    expect((logRound3 as any).stopReason).toBe("end_turn");
  });
});

describe("错误降级（契约 1 互斥 + 契约 2 错误块隔离 + 契约 7 错误格式）", () => {
  test("所有 4 类失败 @include 都生成 type=error 块（路径不存在 / round 不存在 / section 名不存在 / 互斥违反）", async () => {
    const blocks = await fetchBlocks();
    const errBlocks = blocks.filter((b) => b.type === "error");
    // 期望至少 4 个 error 块（fixture 故意制造 4 处失败）
    expect(errBlocks.length).toBeGreaterThanOrEqual(4);
  });

  test("错误块结构正确：含 message (string) 与 raw (string)（契约 2 + 契约 7）", async () => {
    const blocks = await fetchBlocks();
    const errBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "error" }> => b.type === "error",
    );
    expect(errBlocks.length).toBeGreaterThan(0);
    for (const e of errBlocks) {
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
      expect(typeof e.raw).toBe("string");
      // raw 应保留原 @include 行
      expect(e.raw).toContain("@include");
    }
  });

  test("错误块 raw 字段精确还原原始 @include 行（不含路径不存在）", async () => {
    const blocks = await fetchBlocks();
    const errBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "error" }> => b.type === "error",
    );
    // fixture 第二段是 @include(./does-not-exist.ts, section=1)
    const notFound = errBlocks.find((e) => e.raw.includes("does-not-exist.ts"));
    expect(notFound).toBeDefined();
    expect(notFound!.raw).toContain("@include(./does-not-exist.ts, section=1)");
  });

  test("错误块 raw 字段保留 round 不存在的原文", async () => {
    const blocks = await fetchBlocks();
    const errBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "error" }> => b.type === "error",
    );
    const round999 = errBlocks.find((e) => e.raw.includes("round=999"));
    expect(round999).toBeDefined();
    expect(round999!.raw).toContain("@include(./run-log.txt, round=999)");
  });

  test("错误块 raw 字段保留 section 名不存在的原文", async () => {
    const blocks = await fetchBlocks();
    const errBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "error" }> => b.type === "error",
    );
    const noSection = errBlocks.find((e) =>
      e.raw.includes("NONEXISTENT SECTION"),
    );
    expect(noSection).toBeDefined();
  });

  test("互斥违反（同传 section 与 round）触发 error 块（契约 1）", async () => {
    const blocks = await fetchBlocks();
    const errBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "error" }> => b.type === "error",
    );
    // fixture 第七段：@include(./run-log.txt, section=1, round=2)
    const mutex = errBlocks.find(
      (e) => e.raw.includes("section=1") && e.raw.includes("round=2"),
    );
    expect(mutex).toBeDefined();
  });

  test("错误块不影响其他 block 渲染（错误隔离 —— 契约 2 关键保证）", async () => {
    const blocks = await fetchBlocks();
    // fixture 设计：失败块周围环绕正常的 markdown / code / log
    // 验证：① 至少 1 个 markdown ② 至少 1 个 code ③ 至少 1 个 log
    const types = new Set(blocks.map((b) => b.type));
    expect(types.has("markdown")).toBe(true);
    expect(types.has("code")).toBe(true);
    expect(types.has("log")).toBe(true);
    expect(types.has("error")).toBe(true);

    // 第八段 @include(./run-log.txt, round=3) 必须解析成功（在多个错误后还能正常工作）
    const logRound3 = blocks.find(
      (b) => b.type === "log" && (b as any).source?.round === 3,
    );
    expect(logRound3).toBeDefined();
  });

  test("整体 JSON 仍可解析（场景 E）：即便有 error 块也不返回 5xx", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toBeDefined();
    expect((json as any).blocks).toBeDefined();
  });
});

describe("HTML 实体转义（契约 2 关键 XSS 防御）", () => {
  test("markdown 块的 html 字段不含原生 <script> 标签（必须被转义）", async () => {
    const blocks = await fetchBlocks();
    const mdBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "markdown" }> => b.type === "markdown",
    );
    expect(mdBlocks.length).toBeGreaterThan(0);
    // 找到含 'xss' 字眼的那个 markdown block（fixture 第三段）
    const xssBlock = mdBlocks.find((b) => b.html.includes("xss"));
    expect(xssBlock).toBeDefined();
    // 必须不含原生 <script> 与 </script>（应被转义为 &lt;script&gt;）
    expect(xssBlock!.html).not.toContain("<script>");
    expect(xssBlock!.html).not.toContain("</script>");
  });

  test("html 字段包含转义后的实体 &lt; / &gt;（契约 2 明确要求）", async () => {
    const blocks = await fetchBlocks();
    const mdBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "markdown" }> => b.type === "markdown",
    );
    const xssBlock = mdBlocks.find((b) => b.html.includes("xss"));
    expect(xssBlock).toBeDefined();
    // 应至少出现一次 &lt; 或 &gt;
    const hasEscapedLt = xssBlock!.html.includes("&lt;");
    const hasEscapedGt = xssBlock!.html.includes("&gt;");
    expect(hasEscapedLt || hasEscapedGt).toBe(true);
  });

  test("html 字段含转义后的 & 字符（lesson.md 中的 '&' 字面量必须 → &amp;）", async () => {
    const blocks = await fetchBlocks();
    const mdBlocks = blocks.filter(
      (b): b is Extract<Block, { type: "markdown" }> => b.type === "markdown",
    );
    // fixture 第三段含字面字符串 "& 字符"
    const ampBlock = mdBlocks.find(
      (b) => b.html.includes("&amp;") || b.html.includes("&#38;"),
    );
    expect(ampBlock).toBeDefined();
  });

  test("整个响应文本中绝对不含可执行的 <script> 字面（全局 XSS 检查）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const text = await res.text();
    // 注意：这里检查 JSON 字符串里不应有未转义的 <script> 序列。
    // 在 JSON 里 '<' 字符是合法的，因此我们检查的是 markdown.html 字段语义上是否会输出
    // 浏览器 innerHTML 时变成执行的 <script>。
    // 由于响应是 JSON，'<' 字面会出现在被序列化的字符串里。
    // 我们换一个角度：把 markdown.html 字段拼起来再扫一遍。
    const json = JSON.parse(text) as { blocks: Block[] };
    const allHtml = json.blocks
      .filter((b) => b.type === "markdown")
      .map((b) => (b as any).html as string)
      .join("\n");
    expect(allHtml).not.toContain("<script>");
    expect(allHtml).not.toContain("</script>");
    expect(allHtml).not.toContain("<b>bold</b>"); // <b> 也必须被转义（最小 markdown 子集不支持原生 HTML）
  });
});

describe("块顺序与源顺序一致（错误块也按 lesson.md 源位置排布）", () => {
  test("errors fixture 中：第一个错误块（does-not-exist.ts）出现在 code section=3 之前", async () => {
    const blocks = await fetchBlocks();
    // 找索引
    let idxFirstErr = -1;
    let idxCodeSec3 = -1;
    blocks.forEach((b, i) => {
      if (
        idxFirstErr === -1 &&
        b.type === "error" &&
        (b as any).raw?.includes("does-not-exist.ts")
      ) {
        idxFirstErr = i;
      }
      if (b.type === "code" && (b as any).source?.section === 3) {
        idxCodeSec3 = i;
      }
    });
    expect(idxFirstErr).toBeGreaterThanOrEqual(0);
    expect(idxCodeSec3).toBeGreaterThanOrEqual(0);
    expect(idxFirstErr).toBeLessThan(idxCodeSec3);
  });

  test("最后一个 block（按 lesson.md 末段）是 log round=3（契约 2 顺序保证）", async () => {
    const blocks = await fetchBlocks();
    // 最后一个非 markdown 块应是 log round=3
    const nonMd = blocks.filter((b) => b.type !== "markdown");
    const last = nonMd[nonMd.length - 1];
    expect(last).toBeDefined();
    expect(last!.type).toBe("log");
    expect((last as any).source?.round).toBe(3);
  });
});
