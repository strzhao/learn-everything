import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseLesson } from "../lib/parse-lesson";
import { buildMessagesSnapshots } from "../lib/messages-replay";

const OTTER =
  "/Users/stringzhao/workspace_sync/personal_projects/Otter/tasks/01-minimal-agent-loop";

async function setup(lesson: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "msg-replay-"));
  writeFileSync(join(dir, "lesson.md"), lesson);
  writeFileSync(
    join(dir, "agent.ts"),
    await Bun.file(join(OTTER, "agent.ts")).text(),
  );
  writeFileSync(
    join(dir, "run-log.txt"),
    await Bun.file(join(OTTER, "run-log.txt")).text(),
  );
  return dir;
}

test("3 round blocks → 3 snapshots, lengths increase", async () => {
  const dir = await setup(
    [
      "@include(./run-log.txt, round=1)",
      "@include(./run-log.txt, round=2)",
      "@include(./run-log.txt, round=3)",
      `@include(./run-log.txt, section="FINAL MESSAGES")`,
    ].join("\n\n"),
  );
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const snaps = buildMessagesSnapshots(blocks);
    expect(snaps.length).toBe(3);
    const lens = snaps.map((s) => s.messages.length);
    // initial user (1) + round1 assistant + round1 user[tool_result] = 3
    // + round2 assistant + round2 user[tool_result] = 5
    // + round3 assistant (end_turn) = 6
    expect(lens).toEqual([3, 5, 6]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot[0].messages[0] is initial user prompt", async () => {
  const dir = await setup(
    [
      "@include(./run-log.txt, round=1)",
      `@include(./run-log.txt, section="FINAL MESSAGES")`,
    ].join("\n\n"),
  );
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const snaps = buildMessagesSnapshots(blocks);
    expect(snaps[0].messages[0].role).toBe("user");
    expect(snaps[0].messages[0].content).toContain("23");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addedIndices marks the new entries each round", async () => {
  const dir = await setup(
    [
      "@include(./run-log.txt, round=1)",
      "@include(./run-log.txt, round=2)",
      "@include(./run-log.txt, round=3)",
      `@include(./run-log.txt, section="FINAL MESSAGES")`,
    ].join("\n\n"),
  );
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const snaps = buildMessagesSnapshots(blocks);
    // round1: 初始 user + assistant + user[tool_result] 都算"新增"
    expect(snaps[0].addedIndices).toEqual([0, 1, 2]);
    expect(snaps[1].addedIndices).toEqual([3, 4]);
    expect(snaps[2].addedIndices).toEqual([5]); // end_turn 仅 assistant
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_result content uses real value from FINAL MESSAGES (not '<tool result>')", async () => {
  const dir = await setup(
    [
      "@include(./run-log.txt, round=1)",
      `@include(./run-log.txt, section="FINAL MESSAGES")`,
    ].join("\n\n"),
  );
  try {
    const blocks = await parseLesson(join(dir, "lesson.md"));
    const snaps = buildMessagesSnapshots(blocks);
    const lastMsg = snaps[0].messages[snaps[0].messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].content).toBe("1081");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
