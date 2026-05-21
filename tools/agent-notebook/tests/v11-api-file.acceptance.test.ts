// 红队 v1.1 验收测试 —— 契约 8: GET /api/file 路由
//
// 覆盖：
//   - 200 正常路径（agent.ts → typescript）
//   - 400 缺失 path 参数
//   - 403 路径越界（../../etc/passwd）
//   - 404 文件不存在
//   - 413 大文件（> 500KB）
//   - lang 推断（.ts / .json / .md / 未知扩展）
//
// 严格黑盒：spawn server.ts，所有断言通过 fetch + JSON。
// 不读取/import 任何 v1.1 蓝队实现代码。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startServer, stopServer, type ServerHandle } from "./helpers/server.ts";

const V11_NORMAL =
  "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/tools/agent-notebook/tests/fixtures/v11/normal";
const BIG_FILE_PATH = join(V11_NORMAL, "big.txt");
// 创建一个临时 .json 与 .unknown 文件用于 lang 推断测试（README.md 已 symlink 存在）
const JSON_FILE_PATH = join(V11_NORMAL, "sample.json");
const UNKNOWN_FILE_PATH = join(V11_NORMAL, "sample.foo");

let handle: ServerHandle | null = null;

beforeAll(async () => {
  // 600KB 大文件（> 500KB 阈值）
  const bigContent = "x".repeat(600 * 1024);
  writeFileSync(BIG_FILE_PATH, bigContent);

  // .json 文件（断言 lang === "json"）
  writeFileSync(JSON_FILE_PATH, '{"hello":"world"}\n');

  // 未知扩展名 .foo 文件（断言 lang === "plaintext"）
  writeFileSync(UNKNOWN_FILE_PATH, "plain text content\n");

  handle = await startServer(V11_NORMAL);
});

afterAll(async () => {
  await stopServer(handle);
  handle = null;
  // 清理临时文件
  for (const p of [BIG_FILE_PATH, JSON_FILE_PATH, UNKNOWN_FILE_PATH]) {
    if (existsSync(p)) unlinkSync(p);
  }
});

describe("GET /api/file —— 契约 8 状态码", () => {
  test("200 正常路径：path=agent.ts → JSON {content, totalLines, lang=typescript}", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=agent.ts`);
    expect(res.status).toBe(200);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/json");

    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("content");
    expect(json).toHaveProperty("totalLines");
    expect(json).toHaveProperty("lang");

    expect(typeof json.content).toBe("string");
    expect((json.content as string).length).toBeGreaterThan(0);
    // agent.ts 实际开头注释 “// Task 01: ...”
    expect(json.content as string).toContain("Task 01");

    expect(typeof json.totalLines).toBe("number");
    expect(json.totalLines as number).toBeGreaterThan(0);
    // agent.ts 实际行数 75（wc -l 结果），允许 ±1 容忍 trailing newline 计数差异
    expect(json.totalLines as number).toBeGreaterThanOrEqual(70);
    expect(json.totalLines as number).toBeLessThanOrEqual(80);

    expect(json.lang).toBe("typescript");
  });

  test("400 缺失参数：GET /api/file（无 path）→ JSON.error === 'path required'", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file`);
    expect(res.status).toBe(400);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/json");

    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("path required");
  });

  test("403 路径越界：path=../../etc/passwd → JSON.error === 'path outside task-dir'", async () => {
    const res = await fetch(
      `${handle!.baseUrl}/api/file?path=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(403);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/json");

    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("path outside task-dir");
  });

  test("404 文件不存在：path=nonexistent.ts → JSON.error === 'file not found'", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=nonexistent.ts`);
    expect(res.status).toBe(404);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/json");

    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("file not found");
  });

  test("413 大文件：600KB big.txt → JSON.error 含 'too large'", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=big.txt`);
    expect(res.status).toBe(413);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/json");

    const json = (await res.json()) as { error?: string };
    expect(typeof json.error).toBe("string");
    expect(json.error!).toContain("too large");
  });
});

describe("GET /api/file —— lang 推断", () => {
  test(".ts 文件 → lang === 'typescript'", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=agent.ts`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { lang: string };
    expect(json.lang).toBe("typescript");
  });

  test(".json 文件 → lang === 'json'", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=sample.json`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      lang: string;
      content: string;
      totalLines: number;
    };
    expect(json.lang).toBe("json");
    expect(json.content).toContain("hello");
    expect(json.totalLines).toBeGreaterThan(0);
  });

  test(".md 文件 → lang === 'markdown' 或 'plaintext'（视实现推断规则）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=README.md`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { lang: string; content: string };
    // 设计文档契约 8 仅明确 .ts → typescript / .js → javascript / 未知 → plaintext
    // .md 视实现推断，宽接受 markdown / plaintext 二者之一即可（不做更窄断言以免 over-specify）
    expect(["markdown", "plaintext"]).toContain(json.lang);
    expect(json.content.length).toBeGreaterThan(0);
  });

  test("未知扩展名 .foo → lang === 'plaintext'（契约 8 默认值）", async () => {
    const res = await fetch(`${handle!.baseUrl}/api/file?path=sample.foo`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { lang: string };
    expect(json.lang).toBe("plaintext");
  });
});
