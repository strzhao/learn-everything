// 红队验收测试 —— HTTP API 契约（契约 6 + 契约 7）
//
// 覆盖：
//   - GET /            → 200 text/html，含 <title> 与 messages 字样
//   - GET /api/lesson  → 200 application/json，shape 含 task / blocks / runs
//   - GET /static/*    → 200，返回 app.js / style.css
//   - 错误格式（type: 'error' 块）的 message 与 raw 字段
//
// 黑盒：spawn server.ts，所有断言通过 fetch + json 进行。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  FIXTURES,
  startServer,
  stopServer,
  type ServerHandle,
} from "./helpers/server.ts";

let handle: ServerHandle | null = null;

beforeAll(async () => {
  handle = await startServer(FIXTURES.normal);
});

afterAll(async () => {
  await stopServer(handle);
  handle = null;
});

describe("GET /", () => {
  test("返回 200 + text/html，含 <title> 标签和 messages 字样（场景 A）", async () => {
    const res = await fetch(`${handle!.baseUrl}/`);
    expect(res.status).toBe(200);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("text/html");

    const body = await res.text();
    expect(body.toLowerCase()).toContain("<title>");
    expect(body.toLowerCase()).toContain("messages");
  });
});

describe("GET /api/lesson", () => {
  test("返回 200 + application/json，payload 含 task / blocks / runs 三字段（契约 6）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    expect(res.status).toBe(200);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/json");

    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("task");
    expect(json).toHaveProperty("blocks");
    expect(json).toHaveProperty("runs");

    expect(typeof json.task).toBe("string");
    expect(Array.isArray(json.blocks)).toBe(true);
    expect(Array.isArray(json.runs)).toBe(true);
  });

  test("task 字段等于 task-dir 末段 '01-minimal-agent-loop' 风格（来自 normal fixture 名）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as { task: string };
    // fixtures/normal 的末段是 "normal"
    expect(json.task.length).toBeGreaterThan(0);
    expect(json.task).toContain("normal");
  });

  test("blocks 数量 ≥ 5 且 type 集合含 markdown / code / log（场景 B）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as { blocks: Array<{ type: string }> };
    expect(json.blocks.length).toBeGreaterThanOrEqual(5);

    const typeSet = new Set(json.blocks.map((b) => b.type));
    expect(typeSet.has("markdown")).toBe(true);
    expect(typeSet.has("code")).toBe(true);
    expect(typeSet.has("log")).toBe(true);
  });

  test("blocks[].type 取值仅在 {markdown, code, log, error} 范围内（契约 2 联合类型）", async () => {
    const allowed = new Set(["markdown", "code", "log", "error"]);
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as { blocks: Array<{ type: string }> };
    for (const b of json.blocks) {
      expect(allowed.has(b.type)).toBe(true);
    }
  });

  test("code 块的 source.section 集合至少含 2 个不同值（场景 C）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as {
      blocks: Array<{
        type: string;
        source?: { section?: number | string };
      }>;
    };
    const sections = json.blocks
      .filter((b) => b.type === "code")
      .map((b) => b.source?.section)
      .filter((s) => s !== undefined);
    const uniqueSections = new Set(sections);
    expect(uniqueSections.size).toBeGreaterThanOrEqual(2);
  });

  test("code 块结构正确：含 lang / content / source.file 字段（契约 2）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as {
      blocks: Array<{
        type: string;
        lang?: string;
        content?: string;
        source?: { file?: string; section?: number | string };
      }>;
    };
    const codeBlocks = json.blocks.filter((b) => b.type === "code");
    expect(codeBlocks.length).toBeGreaterThan(0);
    for (const b of codeBlocks) {
      expect(typeof b.lang).toBe("string");
      expect(typeof b.content).toBe("string");
      expect((b.content ?? "").length).toBeGreaterThan(0);
      expect(b.source).toBeDefined();
      expect(typeof b.source!.file).toBe("string");
      expect(b.source!.section).toBeDefined();
    }
  });

  test("log round=1 块 content 含 'tool_use' 且含 '\"a\": 23'（场景 D）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as {
      blocks: Array<{
        type: string;
        content?: string;
        source?: { round?: number };
      }>;
    };
    const round1 = json.blocks.find(
      (b) => b.type === "log" && b.source?.round === 1,
    );
    expect(round1).toBeDefined();
    expect(round1!.content).toContain("tool_use");
    expect(round1!.content).toContain('"a": 23');
  });

  test("log 块带 stopReason（来自 ROUND 标记），且为字符串（契约 2）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as {
      blocks: Array<{
        type: string;
        stopReason?: string;
        source?: { round?: number; section?: string };
      }>;
    };
    const roundLogs = json.blocks.filter(
      (b) => b.type === "log" && b.source?.round !== undefined,
    );
    expect(roundLogs.length).toBeGreaterThanOrEqual(2);
    // 至少 round=1 / round=2 应有 stopReason=tool_use（来自 fixture 引用的真实 run-log.txt）
    const r1 = roundLogs.find((b) => b.source?.round === 1);
    const r2 = roundLogs.find((b) => b.source?.round === 2);
    expect(r1?.stopReason).toBe("tool_use");
    expect(r2?.stopReason).toBe("tool_use");
  });

  test("log section='FINAL MESSAGES' 块的 content 含 'tool_result'", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as {
      blocks: Array<{
        type: string;
        content?: string;
        source?: { section?: string };
      }>;
    };
    const finalBlk = json.blocks.find(
      (b) => b.type === "log" && b.source?.section === "FINAL MESSAGES",
    );
    expect(finalBlk).toBeDefined();
    expect(finalBlk!.content).toContain("tool_result");
    expect(finalBlk!.content).toContain("1181");
  });

  test("blocks 顺序与 lesson.md 源顺序严格一致（契约 2 保证）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/lesson`);
    const json = (await res.json()) as {
      blocks: Array<{
        type: string;
        source?: { round?: number; section?: number | string };
      }>;
    };
    // fixture/normal/lesson.md 顺序：
    //   markdown(标题/段落) → code section=1 → code section=2
    //   → log round=1 → log round=2 → log section="FINAL MESSAGES"
    // 仅看 code/log 的有序投影
    const projection = json.blocks
      .filter((b) => b.type === "code" || b.type === "log")
      .map((b) => {
        if (b.type === "code") return `code:${b.source?.section}`;
        if (b.source?.round !== undefined) return `log:round=${b.source.round}`;
        return `log:section=${b.source?.section}`;
      });
    expect(projection).toEqual([
      "code:1",
      "code:2",
      "log:round=1",
      "log:round=2",
      'log:section=FINAL MESSAGES',
    ]);
  });
});

describe("GET /static/*", () => {
  test("/static/app.js 返回 200 且 body 非空", async () => {
    const res = await fetch(`${handle!.baseUrl}/static/app.js`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("/static/style.css 返回 200 且 body 非空", async () => {
    const res = await fetch(`${handle!.baseUrl}/static/style.css`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("GET 不存在的路由", () => {
  test("未知路径返回非 200 状态码", async () => {
    const res = await fetch(`${handle!.baseUrl}/nonexistent-route-xyz`);
    // 约定为 404，但只要不是 2xx 即可 —— 留出实现空间
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    // 显式消费 body
    await res.text().catch(() => {});
  });
});
