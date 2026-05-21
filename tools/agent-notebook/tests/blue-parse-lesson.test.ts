import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseLesson } from "../lib/parse-lesson";

const OTTER_TASK_DIR =
  "/Users/stringzhao/workspace_sync/personal_projects/Otter/tasks/01-minimal-agent-loop";

function mkLessonDir(content: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lesson-"));
  writeFileSync(join(dir, "lesson.md"), content);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test("parseLesson parses pure markdown into single markdown block", async () => {
  const dir = mkLessonDir("# Hello\n\nThis is a paragraph.");
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("markdown");
    expect((blocks[0] as any).html).toContain("<h1>Hello</h1>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLesson resolves @include code section", async () => {
  const blocks = await parseLesson(
    "/dev/null", // 直接传一个独立目录，下面构造
  ).catch(() => []);
  // 用临时目录绑定真实 agent.ts
  const dir = mkLessonDir(
    `# Task 01\n\n@include(./agent.ts, section=4)\n\nover.`,
    {},
  );
  // 软链 agent.ts
  const agentSrc = await Bun.file(join(OTTER_TASK_DIR, "agent.ts")).text();
  writeFileSync(join(dir, "agent.ts"), agentSrc);
  try {
    const result = await parseLesson(join(dir, "lesson.md"));
    const types = result.map((b) => b.type);
    expect(types).toContain("markdown");
    expect(types).toContain("code");
    const code = result.find((b) => b.type === "code") as any;
    expect(code.lang).toBe("ts");
    expect(code.source.section).toBe(4);
    expect(code.content).toContain("for (let round");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLesson resolves @include log round", async () => {
  const dir = mkLessonDir(`@include(./run-log.txt, round=1)\n`, {});
  const logSrc = await Bun.file(join(OTTER_TASK_DIR, "run-log.txt")).text();
  writeFileSync(join(dir, "run-log.txt"), logSrc);
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const log = blocks.find((b) => b.type === "log") as any;
    expect(log).toBeTruthy();
    expect(log.source.round).toBe(1);
    expect(log.stopReason).toBe("tool_use");
    expect(log.content).toContain('"a": 23');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLesson resolves @include log section by quoted name", async () => {
  const dir = mkLessonDir(
    `@include(./run-log.txt, section="FINAL MESSAGES")\n`,
    {},
  );
  const logSrc = await Bun.file(join(OTTER_TASK_DIR, "run-log.txt")).text();
  writeFileSync(join(dir, "run-log.txt"), logSrc);
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const log = blocks.find((b) => b.type === "log") as any;
    expect(log).toBeTruthy();
    expect(log.source.section).toBe("FINAL MESSAGES");
    expect(log.content).toContain("FINAL MESSAGES");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLesson emits error block when file missing", async () => {
  const dir = mkLessonDir(`@include(./missing.ts, section=1)\nrest`);
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const err = blocks.find((b) => b.type === "error") as any;
    expect(err).toBeTruthy();
    expect(err.message).toBeTruthy();
    expect(err.raw).toContain("@include");
    // 后续 markdown 仍存在
    expect(blocks.some((b) => b.type === "markdown")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLesson emits error when section not found", async () => {
  const dir = mkLessonDir(`@include(./agent.ts, section=99)\n`);
  const agentSrc = await Bun.file(join(OTTER_TASK_DIR, "agent.ts")).text();
  writeFileSync(join(dir, "agent.ts"), agentSrc);
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const err = blocks.find((b) => b.type === "error") as any;
    expect(err).toBeTruthy();
    expect(err.message).toContain("99");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseLesson preserves source order: markdown → code → markdown → log", async () => {
  const dir = mkLessonDir(
    [
      "# Title",
      "",
      "@include(./agent.ts, section=1)",
      "",
      "讲解一下。",
      "",
      "@include(./run-log.txt, round=1)",
    ].join("\n"),
  );
  const agentSrc = await Bun.file(join(OTTER_TASK_DIR, "agent.ts")).text();
  const logSrc = await Bun.file(join(OTTER_TASK_DIR, "run-log.txt")).text();
  writeFileSync(join(dir, "agent.ts"), agentSrc);
  writeFileSync(join(dir, "run-log.txt"), logSrc);
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    expect(blocks.map((b) => b.type)).toEqual([
      "markdown",
      "code",
      "markdown",
      "log",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
