# topic-init-template.md — 新 Topic 初始化模板

当用户首次使用 `/learn <topic>` 创建一个新 topic 时，AI 应按照本模板在 `topics/<slug>/state.md` 写入初始内容。

---

## state.md 完整模板

```markdown
---
topic: <用户输入的主题名称，保留原始表述>
slug: <kebab-case 格式，全小写，空格替换为连字符>
status: active
stuck_count: 0
created_at: <ISO8601 时间戳，精确到秒，如 2026-05-21T14:23:00+08:00>
updated_at: <ISO8601 时间戳，与 created_at 相同>
bloom_level: remember
artifact_count: 0
---

## 当前位置

bloom: remember | 已覆盖: （首轮 lecture 后由 AI 追加首个概念名）

## 下一步建议

预判: socratic 验证 <首轮概念>

## 卡点记录

（暂无）
```

---

## 字段说明

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `topic` | string | 非空 | 用户原始输入的主题名称，不做格式转换 |
| `slug` | string | kebab-case，仅小写字母/数字/连字符 | 用于目录名，由 topic 自动生成 |
| `status` | enum | `active` \| `paused` \| `completed` | 初始化时固定为 `active` |
| `stuck_count` | int | ≥ 0 | 初始化时固定为 `0`；每次 `stuck-detected` 时 +1；`stuck->lecture` 执行后归零 |
| `created_at` | ISO8601 | 带时区 | 首次初始化时设置，不再修改 |
| `updated_at` | ISO8601 | 带时区 | 每次 AI 完成动作后更新 |
| `bloom_level` | enum | `remember` \| `understand` \| `apply` \| `analyze` \| `evaluate` \| `create` | 你当前所处的布鲁姆认知层级，初始化为 `remember` |
| `artifact_count` | int | ≥ 0 | 已交付的 artifact 数量，每次写入新 artifact 后 +1 |

---

## H2 段落规范

**整体原则**：三个 H2 段落**按需简洁更新**，每段 1-3 行，不写 prose 段落。详见 `SKILL.md` 的 `## 落盘策略` 章节（仅里程碑动作触发 state.md 更新）。

### `## 当前位置`

形如 `bloom: <level> | 已覆盖: <concept1>, <concept2>, ...`，1-2 行。

**"已覆盖"清单是概念追踪的权威源**——取代旧设计中由 journal 各 lecture 摘要承担的追踪职责。每次 `accept`（socratic 或 task 通过）时，AI 在"已覆盖"清单后追加新概念名（用 `, ` 分隔），不删除历史项。

**更新时机**：仅 `accept` / `assemble` 时；过渡态动作（lecture/socratic/task）不更新。

### `## 下一步建议`

AI 对自身下一轮行动的预规划，形如：

```
预判: <动作类型> (<具体方向>) | 备选: <动作类型> (<方向>)
```

1-2 行即可。备选可省略。

**更新时机**：仅在 `task` 下发时或其他里程碑动作触发时按需更新——**不要求每轮更新**。下次调度时若发现 `## 下一步建议` 已陈旧（与 journal 末条不符），AI 在新里程碑触发时覆盖即可。

### `## 卡点记录`

append-only 一行/卡点，形如：

```
- <date> <concept>（hint <N>/原因）→ <处理方式>
```

**更新时机**：每次 `stuck-detected` 追加一行（含 hint 编号）；`stuck->lecture` 执行后在对应条目末尾补 "→ 已切换讲解模式" 或 "→ 暂存"。`stuck_count` 归零不清除历史卡点条目（append-only）。

---

## 示例：学习「Python 异步编程」时的初始 state.md

```markdown
---
topic: Python 异步编程
slug: python-async-programming
status: active
stuck_count: 0
created_at: 2026-05-21T14:23:00+08:00
updated_at: 2026-05-21T14:23:00+08:00
bloom_level: remember
artifact_count: 0
---

## 当前位置

bloom: remember | 已覆盖: 同步阻塞 vs 异步事件循环（餐厅类比）

## 下一步建议

预判: socratic 验证 (问"为什么需要异步")

## 卡点记录

（暂无）
```

> 后续每次 accept 时，AI 在"已覆盖"清单后追加新概念名（如 `, async/await 语法, Future 对象`）。`## 下一步建议` 仅在 task 下发或里程碑触发时更新，不要求每轮重写。

---

## slug 生成规则

```
原始 topic → 全部转小写 → 中文/特殊字符替换为 "-" → 连续连字符合并为单个 → 首尾去掉连字符
示例：
  "Python 异步编程" → "python-"  → "python"（如含中文，建议用拼音或英文描述）
  "async/await basics" → "async-await-basics"
  "React + TypeScript" → "react-typescript"
```

> **注意**：slug 一旦创建不可修改，因为它是目录名的唯一标识符。如果用户在 `/learn` 时输入了同一主题的变体（如"Python async"和"Python 异步"），AI 应识别出可能是同一主题并询问是否复用已有 slug，而非新建重复目录。
