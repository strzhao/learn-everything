// 红队验收测试 —— messagesSnapshots 演化正确性（契约 6 + 验收场景 3）
//
// 覆盖：
//   - snapshot 数量 = log round 块数量（场景 F）
//   - messages 长度严格递增（每展开一轮新增条目）
//   - addedIndices 标注与上一快照对比新增的下标，且都落在当前 messages 范围内
//   - roundIndex 字段有意义（递增或对应 round 编号）
//   - 与 Otter 真实 run-log.txt（3 轮）对齐：FINAL MESSAGES 含 6 条
//
// 黑盒：fixtures/normal 含 round=1, round=2, FINAL MESSAGES 三个 log block。
// 注意：snapshot 是按"含 round 的 log block"顺序生成；FINAL section 不算 round。
// 但 FINAL MESSAGES 含完整最终态，可作为"最后一轮快照"的合法来源（设计文档允许 round=N
// 直至 FINAL）。我们只断言 snapshots 至少有 2 个（round=1 / round=2），且 messages 数组
// 长度严格递增。

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

type MessagesSnapshot = {
  roundIndex: number;
  messages: any[];
  addedIndices: number[];
};

type LessonResp = {
  task: string;
  blocks: Array<{
    type: string;
    source?: { round?: number; section?: string };
  }>;
  messagesSnapshots: MessagesSnapshot[];
};

async function fetchLesson(): Promise<LessonResp> {
  const res = await fetch(`${handle!.baseUrl}/api/lesson`);
  expect(res.status).toBe(200);
  return (await res.json()) as LessonResp;
}

describe("messagesSnapshots 基础结构（契约 6）", () => {
  test("messagesSnapshots 是数组且非空", async () => {
    const j = await fetchLesson();
    expect(Array.isArray(j.messagesSnapshots)).toBe(true);
    expect(j.messagesSnapshots.length).toBeGreaterThan(0);
  });

  test("每个 snapshot 形状正确：{ roundIndex: number, messages: any[], addedIndices: number[] }", async () => {
    const j = await fetchLesson();
    for (const s of j.messagesSnapshots) {
      expect(typeof s.roundIndex).toBe("number");
      expect(Array.isArray(s.messages)).toBe(true);
      expect(Array.isArray(s.addedIndices)).toBe(true);
      // addedIndices 全是非负整数
      for (const idx of s.addedIndices) {
        expect(typeof idx).toBe("number");
        expect(Number.isInteger(idx)).toBe(true);
        expect(idx).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("snapshot 数量与 log block 对应关系（场景 F）", () => {
  test("snapshot 数量 ≥ 含 round 的 log block 数量（≥2）", async () => {
    const j = await fetchLesson();
    const roundLogs = j.blocks.filter(
      (b) => b.type === "log" && b.source?.round !== undefined,
    );
    expect(roundLogs.length).toBeGreaterThanOrEqual(2);
    // 严格 = 数量 是 brainstorm 的目标，但允许 FINAL section 也产出一个 snapshot
    // 故下界为 roundLogs.length，上界 = 总 log 块数
    const totalLogs = j.blocks.filter((b) => b.type === "log").length;
    expect(j.messagesSnapshots.length).toBeGreaterThanOrEqual(roundLogs.length);
    expect(j.messagesSnapshots.length).toBeLessThanOrEqual(totalLogs);
  });
});

describe("messages 数组长度严格递增（场景 F + 场景 3 演化）", () => {
  test("snapshot[i].messages.length < snapshot[i+1].messages.length", async () => {
    const j = await fetchLesson();
    const lengths = j.messagesSnapshots.map((s) => s.messages.length);
    expect(lengths.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
    }
  });

  test("第一个 snapshot 的 messages 长度 ≥ 1（至少含初始 user prompt）", async () => {
    const j = await fetchLesson();
    expect(j.messagesSnapshots[0].messages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("addedIndices 语义正确性（场景 3 NEW 高亮基础）", () => {
  test("第一个 snapshot 的 addedIndices = [0..N-1]（全部都是新增）", async () => {
    const j = await fetchLesson();
    const first = j.messagesSnapshots[0];
    const expectedAll = Array.from(
      { length: first.messages.length },
      (_, i) => i,
    );
    // 排序后比较，避免顺序差异
    expect([...first.addedIndices].sort((a, b) => a - b)).toEqual(expectedAll);
  });

  test("后续 snapshot 的 addedIndices 都落在当前 messages 范围内", async () => {
    const j = await fetchLesson();
    for (let i = 1; i < j.messagesSnapshots.length; i++) {
      const s = j.messagesSnapshots[i];
      for (const idx of s.addedIndices) {
        expect(idx).toBeLessThan(s.messages.length);
        // 新增条目应大于上一快照长度（即新增条目在数组末段）
        expect(idx).toBeGreaterThanOrEqual(
          j.messagesSnapshots[i - 1].messages.length,
        );
      }
    }
  });

  test("后续 snapshot 的 addedIndices 数量 = (当前 messages 长度 - 上一快照 messages 长度)", async () => {
    const j = await fetchLesson();
    for (let i = 1; i < j.messagesSnapshots.length; i++) {
      const cur = j.messagesSnapshots[i];
      const prev = j.messagesSnapshots[i - 1];
      const delta = cur.messages.length - prev.messages.length;
      expect(cur.addedIndices.length).toBe(delta);
    }
  });
});

describe("messages 演化与 Otter 真实 run-log.txt 一致（fixtures/normal 引用真实数据）", () => {
  test("最终 snapshot 的 messages 数量 = 6（来自真实 FINAL MESSAGES：1 user + assistant + user/tool_result + assistant + user/tool_result + assistant）", async () => {
    const j = await fetchLesson();
    const last = j.messagesSnapshots[j.messagesSnapshots.length - 1];
    expect(last.messages.length).toBe(6);
  });

  test("最终 snapshot 的最后一条 message.role === 'assistant' 且 content 含 '1181'", async () => {
    const j = await fetchLesson();
    const last = j.messagesSnapshots[j.messagesSnapshots.length - 1];
    const lastMsg = last.messages[last.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    // content 是数组（含 thinking + text blocks）；序列化后应含 1181
    const serialized = JSON.stringify(lastMsg.content);
    expect(serialized).toContain("1181");
  });

  test("snapshot 中存在 tool_use_id 'call_00_DmcxLs9jQntHJToJtRC24385'（场景 4 因果对应基础）", async () => {
    const j = await fetchLesson();
    // 在任一 snapshot 的任一 message 中应能找到这个 id
    let found = false;
    for (const s of j.messagesSnapshots) {
      const txt = JSON.stringify(s.messages);
      if (txt.includes("call_00_DmcxLs9jQntHJToJtRC24385")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("第一个含 round=1 后的快照里，messages 应至少含 user 初始 prompt 与 assistant 第一轮回应（≥2 条）", async () => {
    const j = await fetchLesson();
    // 最早含 round=1 影响的快照即 snapshots[0]
    const s0 = j.messagesSnapshots[0];
    expect(s0.messages.length).toBeGreaterThanOrEqual(2);
    // 第 0 条是 user，第 1 条是 assistant
    expect(s0.messages[0].role).toBe("user");
    expect(s0.messages[1].role).toBe("assistant");
  });
});

describe("snapshot 不含错误块对应的脏数据", () => {
  test("snapshot.messages 序列化结果不含 '@include' 字符串（演化基于真实 round 数据，与原始 lesson.md 文本无关）", async () => {
    const j = await fetchLesson();
    for (const s of j.messagesSnapshots) {
      const serialized = JSON.stringify(s.messages);
      expect(serialized).not.toContain("@include");
    }
  });
});
