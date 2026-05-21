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
created_at: <ISO8601 时间戳，精确到秒，如 2025-11-05T14:23:00+08:00>
updated_at: <ISO8601 时间戳，与 created_at 相同>
bloom_level: remember
artifact_count: 0
---

## 当前位置

（初始化）用户刚开始学习「<topic>」。尚未进行任何讲解或反问。下一步：完成首轮 `lecture`，介绍该主题的核心概念和学习路径。

## 下一步建议

- 动作类型：`lecture`
- 建议切入角度：从「<topic>」最核心的一个概念出发，用类比（analogy）介绍，控制在 200-400 字内，不要一次性覆盖所有内容
- 本轮目标：让用户对该主题建立第一印象（first impression），引发兴趣和好奇心

## 卡点记录

（暂无。每当 stuck_count 触发 stuck-detected 动作时，在此追加记录：卡在了什么概念、卡的原因推测。）
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
| `bloom_level` | enum | `remember` \| `understand` \| `apply` \| `analyze` \| `evaluate` \| `create` | 当前学生所处的布鲁姆认知层级，初始化为 `remember` |
| `artifact_count` | int | ≥ 0 | 已交付的 artifact 数量，每次写入新 artifact 后 +1 |

---

## H2 段落规范

### `## 当前位置`

记录学生此刻在学习旅程中的具体坐标，包含：
- 已学习的概念清单（bullet 列表，初始化时为空）
- 当前 bloom_level 对应的理解深度描述
- 上一轮动作类型及其结果摘要（初始化时写"尚未开始"）

**更新时机**：每次 `accept` 动作完成后，以及每次 `assemble` 动作完成后。

### `## 下一步建议`

AI 对自身下一轮行动的预规划，包含：
- 推荐动作类型（`lecture` / `socratic` / `task` / `assemble`）
- 具体的问题或任务描述（如果下一步是 `socratic`，这里预写问题方向）
- 本轮期望达到的认知目标（Bloom 层级对应的期望行为）

**更新时机**：每轮动作结束时更新，供下次调度参考。

### `## 卡点记录`

时间序列的卡点日志，每条记录包含：
- 触发时间（ISO8601）
- 卡住的具体概念
- stuck_count 达到触发阈值时的推断原因
- 已采取的应对动作（`stuck->lecture` 后补记）

**更新时机**：每次 `stuck-detected` 动作时追加；`stuck->lecture` 执行后，在对应条目补记"→ 已切换讲解模式"。

---

## 示例：学习「Python 异步编程」时的初始 state.md

```markdown
---
topic: Python 异步编程
slug: python-async-programming
status: active
stuck_count: 0
created_at: 2025-11-05T14:23:00+08:00
updated_at: 2025-11-05T14:23:00+08:00
bloom_level: remember
artifact_count: 0
---

## 当前位置

（初始化）用户刚开始学习「Python 异步编程」。尚未进行任何讲解或反问。下一步：完成首轮 `lecture`，介绍同步 vs 异步的核心差异。

## 下一步建议

- 动作类型：`lecture`
- 建议切入角度：用"餐厅点餐"类比解释什么是同步阻塞（synchronous blocking），再对比 Python `asyncio` 的事件循环（event loop）机制
- 本轮目标：让用户理解"为什么需要异步"（motivation），而非急于介绍 `async/await` 语法

## 卡点记录

（暂无）
```

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
