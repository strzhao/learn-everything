// 按 round log block 顺序重建 messages 数组的快照序列
// 规则（基于 agent.ts 实际逻辑）：
//   round content (JSON array) → push { role: 'assistant', content: <array> }
//   如果 stop_reason === 'tool_use'：从 content 中抽 tool_use blocks → push { role: 'user', content: [tool_result...] }
//   end_turn 不再追加 user 块
// 初始 messages 取自 lesson 中（如有）的 FINAL MESSAGES log section 第 0 条；否则用占位说明。
//
// v1.4: 按 source.file 分桶 → 多个 Run，每个 Run 独立的 snapshots 序列
//   原来跨文件按 round 编号合并（多次 run 重号 sort 错乱），现按 file 分桶后各自独立演化

import type { Block } from "./parse-lesson";

export interface MessagesSnapshot {
  roundIndex: number;
  messages: any[];
  addedIndices: number[];
}

export interface Run {
  id: string;          // source.file（如 "./run-log-v1-injection-test.txt"）
  label: string;       // 短标签（如 "v1-injection-test"）
  snapshots: MessagesSnapshot[];
}

function extractRoundContentArray(rawContent: string): any[] | null {
  const idx = rawContent.indexOf("\n");
  if (idx === -1) return null;
  const after = rawContent.slice(idx + 1);
  // round content 末尾可能跟着 stdout 文本（如 "[MOCK] would rm -rf ..."），
  // 这些文本不是 JSON 一部分。用括号深度计数找顶层数组真实结尾。
  const start = after.indexOf("[");
  if (start === -1) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < after.length; i++) {
    const ch = after[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(after.slice(start, end)); } catch { return null; }
}

function extractFinalMessages(rawContent: string): any[] | null {
  const idx = rawContent.indexOf("\n");
  if (idx === -1) return null;
  const json = rawContent.slice(idx + 1).trim();
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

function fakeToolResult(toolUse: any): any {
  return { type: "tool_result", tool_use_id: toolUse.id, content: "<tool result>" };
}

// 文件名 → 短标签：去 "./", "run-log-/_" 前缀和 ".txt/.log" 后缀
function makeLabel(file: string): string {
  let n = file.replace(/^\.\//, "").replace(/^run-log[-_]/, "").replace(/\.(txt|log)$/i, "");
  return n || file;
}

// 单 run 的 snapshots 重建（旧 buildMessagesSnapshots 主体逻辑）
function buildSnapshotsForRun(blocks: Extract<Block, { type: "log" }>[]): MessagesSnapshot[] {
  const snapshots: MessagesSnapshot[] = [];
  type RoundEntry =
    | { kind: "round"; block: Extract<Block, { type: "log" }>; round: number }
    | { kind: "final"; block: Extract<Block, { type: "log" }> };
  const ordered: RoundEntry[] = [];
  for (const b of blocks) {
    const src: any = (b as any).source ?? {};
    if (typeof src.round === "number") ordered.push({ kind: "round", block: b, round: src.round });
    else if (typeof src.section === "string" && src.section === "FINAL MESSAGES")
      ordered.push({ kind: "final", block: b });
  }

  const finalEntry = ordered.find((e) => e.kind === "final");
  const finalMessages =
    finalEntry && finalEntry.kind === "final"
      ? extractFinalMessages(finalEntry.block.content)
      : null;

  const roundBlocks = ordered
    .filter((e): e is Extract<RoundEntry, { kind: "round" }> => e.kind === "round")
    .slice()
    .sort((a, b) => a.round - b.round)
    .map((e) => e.block);

  const initial: any[] = [];
  if (finalMessages && finalMessages.length > 0 && finalMessages[0].role === "user") {
    initial.push(finalMessages[0]);
  }

  const toolResultByUseId = new Map<string, any>();
  if (finalMessages) {
    for (const msg of finalMessages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const blk of msg.content) {
        if (blk?.type === "tool_result" && blk.tool_use_id) {
          toolResultByUseId.set(blk.tool_use_id, blk);
        }
      }
    }
  }

  let messages: any[] = initial.slice();
  let prevLen = 0;
  for (let i = 0; i < roundBlocks.length; i++) {
    const block = roundBlocks[i];
    const arr = extractRoundContentArray(block.content);
    if (!arr) continue;
    messages.push({ role: "assistant", content: arr });
    if (block.stopReason === "tool_use") {
      const toolUses = arr.filter((b: any) => b?.type === "tool_use");
      if (toolUses.length > 0) {
        const toolResults = toolUses.map((tu: any) => toolResultByUseId.get(tu.id) ?? fakeToolResult(tu));
        messages.push({ role: "user", content: toolResults });
      }
    }
    const addedIndices: number[] = [];
    for (let k = prevLen; k < messages.length; k++) addedIndices.push(k);
    prevLen = messages.length;
    snapshots.push({ roundIndex: i + 1, messages: messages.slice(), addedIndices });
  }

  if (finalMessages && finalMessages.length > messages.length) {
    const addedIndices: number[] = [];
    for (let k = messages.length; k < finalMessages.length; k++) addedIndices.push(k);
    snapshots.push({
      roundIndex: snapshots.length + 1,
      messages: finalMessages.slice(),
      addedIndices,
    });
  }

  return snapshots;
}

/**
 * 按 source.file 分桶，每桶独立产生一个 Run（含 snapshots 序列）。
 * 桶顺序按 lesson.md 中首次出现的顺序排列，保持阅读节奏。
 */
export function buildRuns(blocks: Block[]): Run[] {
  const fileOrder: string[] = [];
  const fileBuckets = new Map<string, Extract<Block, { type: "log" }>[]>();
  for (const b of blocks) {
    if (b.type !== "log") continue;
    const file = (b as any).source?.file;
    if (!file) continue;
    if (!fileBuckets.has(file)) {
      fileBuckets.set(file, []);
      fileOrder.push(file);
    }
    fileBuckets.get(file)!.push(b);
  }
  const runs: Run[] = [];
  for (const file of fileOrder) {
    const bucket = fileBuckets.get(file)!;
    const snapshots = buildSnapshotsForRun(bucket);
    if (snapshots.length === 0) continue;
    runs.push({ id: file, label: makeLabel(file), snapshots });
  }
  return runs;
}
