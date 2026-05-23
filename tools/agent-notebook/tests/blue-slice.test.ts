import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  SliceError,
  sliceCodeSection,
  sliceLogRound,
  sliceLogSection,
} from "../lib/slice";

const TASK_DIR =
  "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/topics/agent-harness-engineering/artifacts/01-minimal-agent-loop";
const AGENT = join(TASK_DIR, "agent.ts");
const LOG = join(TASK_DIR, "run-log.txt");

test("sliceCodeSection extracts section 1 with header line", async () => {
  const s = await sliceCodeSection(AGENT, 1);
  expect(s.content.startsWith("// ---------- 1.")).toBe(true);
  expect(s.content).toContain("settings.json");
  // 不应越过下一区段标记
  expect(s.content).not.toContain("// ---------- 2.");
  // v1.1: startLine/endLine/totalLines
  expect(s.startLine).toBeGreaterThanOrEqual(1);
  expect(s.endLine).toBeGreaterThan(s.startLine);
  expect(s.totalLines).toBeGreaterThanOrEqual(s.endLine);
});

test("sliceCodeSection extracts section 4 (Agent Loop)", async () => {
  const s = await sliceCodeSection(AGENT, 4);
  expect(s.content).toContain("// ---------- 4.");
  expect(s.content).toContain("for (let round");
  expect(s.content).toContain("stop_reason");
  expect(s.content).not.toContain("// ---------- 5.");
});

test("sliceCodeSection extracts last section 5 to EOF", async () => {
  const s = await sliceCodeSection(AGENT, 5);
  expect(s.content).toContain("// ---------- 5.");
  expect(s.content).toContain("FINAL MESSAGES");
});

test("sliceCodeSection throws SliceError when section not found", async () => {
  await expect(sliceCodeSection(AGENT, 99)).rejects.toThrow(SliceError);
});

test("sliceLogRound extracts round 1 with stop_reason", async () => {
  const r = await sliceLogRound(LOG, 1);
  expect(r.stopReason).toBe("tool_use");
  expect(r.content).toContain("ROUND 1");
  expect(r.content).toContain('"a": 23');
  expect(r.content).toContain("tool_use");
  expect(r.content).not.toContain("ROUND 2");
});

test("sliceLogRound extracts round 3 (end_turn)", async () => {
  const r = await sliceLogRound(LOG, 3);
  expect(r.stopReason).toBe("end_turn");
  expect(r.content).toContain("ROUND 3");
  expect(r.content).not.toContain("FINAL MESSAGES");
});

test("sliceLogRound throws when round not found", async () => {
  await expect(sliceLogRound(LOG, 99)).rejects.toThrow(SliceError);
});

test("sliceLogSection extracts FINAL MESSAGES to EOF", async () => {
  const s = await sliceLogSection(LOG, "FINAL MESSAGES");
  expect(s).toContain("FINAL MESSAGES");
  expect(s).toContain("call_00_DmcxLs9jQntHJToJtRC24385");
});

test("sliceLogSection throws when section not found", async () => {
  await expect(sliceLogSection(LOG, "BOGUS")).rejects.toThrow(SliceError);
});
