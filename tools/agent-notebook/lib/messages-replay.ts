// 按 round log block 顺序重建 messages 数组的快照序列
// 规则（基于 agent.ts 实际逻辑）：
//   round content (JSON array) → push { role: 'assistant', content: <array> }
//   如果 stop_reason === 'tool_use'：从 content 中抽 tool_use blocks → push { role: 'user', content: [tool_result...] }
//   end_turn 不再追加 user 块
// 初始 messages 取自 lesson 中（如有）的 FINAL MESSAGES log section 第 0 条；否则用占位说明。

import type { Block } from "./parse-lesson";

export interface MessagesSnapshot {
  roundIndex: number;
  messages: any[];
  addedIndices: number[];
}

/**
 * 从 ROUND log block 的 content 字段提取 JSON 数组（content 形如:
 *   ========== ROUND 1  stop_reason=tool_use ==========
 *   [
 *     { ... }
 *   ]
 * ）
 */
function extractRoundContentArray(rawContent: string): any[] | null {
  // 把首行（分隔符）剥掉，剩余就是 JSON 数组（可能含尾部空行）
  const idx = rawContent.indexOf("\n");
  if (idx === -1) return null;
  const json = rawContent.slice(idx + 1).trim();
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 从 FINAL MESSAGES log section 抽出 messages 数组
 */
function extractFinalMessages(rawContent: string): any[] | null {
  const idx = rawContent.indexOf("\n");
  if (idx === -1) return null;
  const json = rawContent.slice(idx + 1).trim();
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * 简单的"模拟工具执行"：从 tool_use block 推断结果。
 * 因为我们其实不需要真值（高亮配色按 tool_use_id 即可），这里返回占位串。
 * 但为了让 messages 长得跟 agent.ts 一样，从 FINAL MESSAGES 反查最准。
 */
function fakeToolResult(toolUse: any): any {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: "<tool result>",
  };
}

export function buildMessagesSnapshots(blocks: Block[]): MessagesSnapshot[] {
  const snapshots: MessagesSnapshot[] = [];

  // 在 lesson.md 顺序中收集 round / final-section 块（保留 lesson 中的相对顺序）
  type RoundEntry =
    | { kind: "round"; block: Extract<Block, { type: "log" }>; round: number }
    | { kind: "final"; block: Extract<Block, { type: "log" }> };
  const ordered: RoundEntry[] = [];
  for (const b of blocks) {
    if (b.type !== "log") continue;
    const src: any = (b as any).source ?? {};
    if (typeof src.round === "number") {
      ordered.push({ kind: "round", block: b, round: src.round });
    } else if (typeof src.section === "string" && src.section === "FINAL MESSAGES") {
      ordered.push({ kind: "final", block: b });
    }
  }

  // 找 FINAL MESSAGES 用于反查首条 user 消息和真实 tool_result
  const finalEntry = ordered.find((e) => e.kind === "final");
  const finalMessages =
    finalEntry && finalEntry.kind === "final"
      ? extractFinalMessages(finalEntry.block.content)
      : null;

  // round 块按 round 编号升序（处理 lesson 里乱序的边界情况）
  const roundBlocks = ordered
    .filter((e): e is Extract<RoundEntry, { kind: "round" }> => e.kind === "round")
    .slice()
    .sort((a, b) => a.round - b.round)
    .map((e) => e.block);

  // 3) messages 起点：FINAL 第 0 条（user 初始问题）；否则空
  const initial: any[] = [];
  if (finalMessages && finalMessages.length > 0 && finalMessages[0].role === "user") {
    initial.push(finalMessages[0]);
  }

  // 4) 用 FINAL 中的 tool_result 建立 id → tool_result 的查表（保证 fake 的不出现）
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

  // 5) 按 round 演化
  let messages: any[] = initial.slice();
  // 第一个 snapshot 的 addedIndices = [0..N-1]（全部新增）→ 起始 prevLen=0
  let prevLen = 0;

  // 第 0 个快照（初始状态，roundIndex=0 表示"还没展开任何 round"）
  // 设计文档说 "snapshot 数量 = log block 数量"（FINAL 验收场景 F），所以从 round=1 起算
  for (let i = 0; i < roundBlocks.length; i++) {
    const block = roundBlocks[i];
    const arr = extractRoundContentArray(block.content);
    if (!arr) continue;

    // push assistant
    messages.push({ role: "assistant", content: arr });

    // 如果 tool_use → push user[tool_result]
    if (block.stopReason === "tool_use") {
      const toolUses = arr.filter((b: any) => b?.type === "tool_use");
      if (toolUses.length > 0) {
        const toolResults = toolUses.map((tu: any) => {
          const real = toolResultByUseId.get(tu.id);
          return real ?? fakeToolResult(tu);
        });
        messages.push({ role: "user", content: toolResults });
      }
    }

    const addedIndices: number[] = [];
    for (let k = prevLen; k < messages.length; k++) addedIndices.push(k);
    prevLen = messages.length;

    snapshots.push({
      roundIndex: i + 1,
      messages: messages.slice(),
      addedIndices,
    });
  }

  // 若 lesson 含 FINAL MESSAGES 块，且能解出完整 messages → 追加一个 final 快照
  // （end_turn 那一轮的最后 assistant 消息已经在最后一个 round 快照里，
  //  但 fixture/normal 只引用了 round=1 / round=2，缺少 round=3，所以需要 FINAL 来覆盖）
  if (finalMessages && finalMessages.length > messages.length) {
    const addedIndices: number[] = [];
    for (let k = messages.length; k < finalMessages.length; k++) {
      addedIndices.push(k);
    }
    snapshots.push({
      roundIndex: snapshots.length + 1,
      messages: finalMessages.slice(),
      addedIndices,
    });
  }

  return snapshots;
}
