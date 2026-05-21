// 红队 v1.1 验收测试 —— 契约 9: Block.code.source 扩展字段
//
// 覆盖：
//   - 新字段 startLine / endLine / totalLines 必须存在且为 number
//   - DbC 谓词：1 ≤ startLine ≤ endLine ≤ totalLines
//   - 真实数值：fixtures/v11/normal/lesson.md 引用 agent.ts section=1/2/4，
//     断言对应 code block 的 startLine 与真实 `// ---------- N. ` 行号匹配
//   - v1 backward compatible：旧字段 file / section 仍存在
//
// 严格黑盒：spawn server.ts，所有断言通过 fetch + JSON。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, stopServer, type ServerHandle } from "./helpers/server.ts";

const V11_NORMAL =
  "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/tools/agent-notebook/tests/fixtures/v11/normal";

let handle: ServerHandle | null = null;

beforeAll(async () => {
  handle = await startServer(V11_NORMAL);
});

afterAll(async () => {
  await stopServer(handle);
  handle = null;
});

type CodeBlock = {
  type: "code";
  lang: string;
  content: string;
  source: {
    file: string;
    section: number | string;
    startLine: number;
    endLine: number;
    totalLines: number;
  };
};

type AnyBlock = { type: string; source?: Record<string, unknown> } & Partial<CodeBlock>;

async function fetchCodeBlocks(): Promise<CodeBlock[]> {
  const res = await fetch(`${handle!.baseUrl}/api/lesson`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { blocks: AnyBlock[] };
  expect(Array.isArray(json.blocks)).toBe(true);
  return json.blocks.filter((b): b is CodeBlock => b.type === "code");
}

describe("Block.code.source 新字段（契约 9）", () => {
  test("所有 type=code 块的 source 含 startLine/endLine/totalLines（数字字段）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    expect(codeBlocks.length).toBeGreaterThanOrEqual(3); // lesson 引用了 section 1/2/4 三段

    for (const b of codeBlocks) {
      expect(b.source).toBeDefined();
      expect(typeof b.source.startLine).toBe("number");
      expect(typeof b.source.endLine).toBe("number");
      expect(typeof b.source.totalLines).toBe("number");
    }
  });

  test("DbC 谓词：1 ≤ startLine ≤ endLine ≤ totalLines", async () => {
    const codeBlocks = await fetchCodeBlocks();
    expect(codeBlocks.length).toBeGreaterThan(0);

    for (const b of codeBlocks) {
      expect(b.source.startLine).toBeGreaterThanOrEqual(1);
      expect(b.source.endLine).toBeGreaterThanOrEqual(b.source.startLine);
      expect(b.source.totalLines).toBeGreaterThanOrEqual(b.source.endLine);
    }
  });

  test("真实数值：section=1 startLine=4（agent.ts 第 4 行 `// ---------- 1. 配置...`）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    const sec1 = codeBlocks.find((b) => b.source.section === 1);
    expect(sec1).toBeDefined();
    expect(sec1!.source.startLine).toBe(4);
    // section 1 在 agent.ts 中以 line 10 开始的 section 2 终止，因此 endLine ≤ 9
    expect(sec1!.source.endLine).toBeLessThanOrEqual(9);
    expect(sec1!.source.endLine).toBeGreaterThanOrEqual(4);
  });

  test("真实数值：section=2 startLine=10（agent.ts 第 10 行 `// ---------- 2. 工具定义 ...`）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    const sec2 = codeBlocks.find((b) => b.source.section === 2);
    expect(sec2).toBeDefined();
    expect(sec2!.source.startLine).toBe(10);
    // section 2 终止于 line 30 起的 section 3，因此 endLine ≤ 29
    expect(sec2!.source.endLine).toBeLessThanOrEqual(29);
    expect(sec2!.source.endLine).toBeGreaterThanOrEqual(10);
  });

  test("真实数值：section=4 startLine=35（agent.ts 第 35 行 `// ---------- 4. Agent Loop ----------`）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    const sec4 = codeBlocks.find((b) => b.source.section === 4);
    expect(sec4).toBeDefined();
    expect(sec4!.source.startLine).toBe(35);
    // section 4 终止于 line 73 起的 section 5，因此 endLine ≤ 72
    expect(sec4!.source.endLine).toBeLessThanOrEqual(72);
    expect(sec4!.source.endLine).toBeGreaterThanOrEqual(35);
  });

  test("totalLines 与真实文件一致（agent.ts ~75 行，宽容 ±2）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    // agent.ts 三段 totalLines 必相同（同一文件）
    const agentTotals = codeBlocks
      .filter((b) => b.source.file.includes("agent.ts"))
      .map((b) => b.source.totalLines);
    expect(agentTotals.length).toBeGreaterThanOrEqual(3);
    const uniq = new Set(agentTotals);
    expect(uniq.size).toBe(1); // 同一文件 totalLines 必一致
    const total = [...uniq][0]!;
    expect(total).toBeGreaterThanOrEqual(73);
    expect(total).toBeLessThanOrEqual(77);
  });

  test("片段长度匹配 content 实际行数（endLine - startLine + 1 ≈ content.split('\\n').length，允许 ±1 容忍尾部换行）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    expect(codeBlocks.length).toBeGreaterThan(0);

    for (const b of codeBlocks) {
      const expectedLineCount = b.source.endLine - b.source.startLine + 1;
      // content.split('\n') 在尾部换行情况下会多 1 个空串元素；在无尾换行时正好等于行数
      const actualSplitCount = b.content.split("\n").length;
      // 允许 actualSplitCount 与 expectedLineCount 差 ≤ 1（trailing newline 影响）
      const diff = Math.abs(actualSplitCount - expectedLineCount);
      expect(diff).toBeLessThanOrEqual(1);
    }
  });

  test("v1 backward compatible：旧字段 file / section 不变（toMatchObject 验证）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    expect(codeBlocks.length).toBeGreaterThanOrEqual(3);

    // section=1
    const sec1 = codeBlocks.find((b) => b.source.section === 1);
    expect(sec1).toBeDefined();
    // 注意：bun 1.3.14 toMatchObject + expect.any(String) 有副作用污染原对象（typeof 字符串字段变 object），
    // 故 typeof 检查必须放在 toMatchObject 之前
    expect(typeof sec1!.source.file).toBe("string");
    expect(sec1!.source.file.length).toBeGreaterThan(0);
    expect(sec1).toMatchObject({
      type: "code",
      source: { file: expect.any(String), section: 1 },
    });

    // section=2
    const sec2 = codeBlocks.find((b) => b.source.section === 2);
    expect(sec2).toBeDefined();
    expect(typeof sec2!.source.file).toBe("string");
    expect(sec2).toMatchObject({
      type: "code",
      source: { file: expect.any(String), section: 2 },
    });

    // section=4
    const sec4 = codeBlocks.find((b) => b.source.section === 4);
    expect(sec4).toBeDefined();
    expect(typeof sec4!.source.file).toBe("string");
    expect(sec4).toMatchObject({
      type: "code",
      source: { file: expect.any(String), section: 4 },
    });
  });

  test("section=4 content 首行包含 `// ---------- 4. Agent Loop ----------`（slice 起点正确）", async () => {
    const codeBlocks = await fetchCodeBlocks();
    const sec4 = codeBlocks.find((b) => b.source.section === 4);
    expect(sec4).toBeDefined();
    // content 首行（split('\n')[0]）应是 section 起点注释
    const firstLine = sec4!.content.split("\n")[0];
    expect(firstLine).toContain("// ---------- 4.");
    expect(firstLine).toContain("Agent Loop");
  });
});
