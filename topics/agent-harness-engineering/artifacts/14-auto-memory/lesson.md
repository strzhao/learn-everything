# Lesson 14: Auto Memory — Agent 自己学着记住

> 195 行 TypeScript 让你看见"AI 主动记忆"在物理层由什么构成：不是数据库，不是向量搜索，而是 prompt 协议 + forked sub-agent + 文件系统。

## 这是什么 + 为什么现在学

v13 给了 agent **项目级硬约束**（CLAUDE.md / 人手维护 / git 追踪）。但有些信息是 agent 在对话中"捡到"的——用户偏好、项目临时状态、外部资源指针。这些信息既不应该放 CLAUDE.md（太碎 / 太个人），也不应该丢掉（下次会话还得重新问）。

v14 的 auto-memory 就是解决这个空白：**agent 自己学着记住**。

跟你脑子的工作方式做个类比：
- CLAUDE.md = 你贴在显示器边框上的便签条（团队硬规则，谁来都能看）
- Auto Memory = 你脑子里的"哦对，这个人喜欢简洁回复"（个人画像，你自己积累的）

## 怎么跑

```bash
cd topics/agent-harness-engineering/artifacts/14-auto-memory/
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="记住我喜欢简洁回复"
```

你会看到：
1. 模型识别"记住" → 主动调 FileWriteTool 写 `.claude-memory/feedback_xxx.md`
2. 更新 MEMORY.md 索引
3. Stop hook 触发 → `[EXTRACT] skipping`（因为主路径已经写了）

## 核心设计：双轨并发互斥

这是 v14 的**分水岭概念**——整个子系统的灵魂：

```
用户说"记住 X"─→ 主 agent 识别 → FileWriteTool 写 memory ─→ 互斥 → background 跳过
                                                              │
用户随口提到 Y ─→ 主 agent 不写（没意识到） ─→ 互斥不命中 → background agent 补漏
```

**为什么不只用一条路径？**

- 只用 prompt 协议（主路径）：model 会漏。用户没说"记住"但信息很有价值时（"我们周二发布"），prompt 协议依赖 model 的"记忆意识"——但 model 忙着回答问题时经常忘记这个副任务。
- 只用 background extraction：多余。用户明确说"记住"时 model 已经写了，background 再写一遍是浪费（还可能格式不一致）。

所以工业设计是**双轨并发 + 互斥**：主路径有 agency 优先权 → 如果主 agent 写了，`hasMemoryWritesSince` 返回 true → background 跳过。

这跟 task 02 的 sandbox + permission 双层防御是**同源设计**：两层针对不同失败模式（sandbox 防恶意 / permission 防误操作 → 主路径防漏记 / background 防被动失能）。

## 双轨注入：索引常驻 + 内容按需

记住了还不够——下次对话开始时 agent 要能"想起来"。工业方案是**双轨注入**：

| 轨道 | 物理通道 | 内容 | 特点 |
|------|---------|------|------|
| 上轨 | v10 systemPromptSection | MEMORY.md 索引（一行/条） | Cache-stable / 每轮都在 |
| 下轨 | v11 attachment | 选中的 1-5 条 memory 全文 | Per-turn / helper 选择 |

**为什么分两轨？**

- 全部放 system prompt：memory 多了以后 system prompt 膨胀 → 破坏 prompt cache → 每轮多花钱
- 全部放 attachment：agent 不知道自己有哪些 memory → 无法决定"要不要存 / 已经存过了吗"

所以索引（目录）常驻 system prompt（cache-stable / 字节稳定），具体内容按需注入（每轮最多 5 条 / 用完即弃不锁 cache）。

这正是 v13 双轨注入（system prompt section + nested attachment）的**第二次显形**——结构同型，语义不同（v13 是 CLAUDE.md / v14 是 memory）。

## 双层 dedup

@include 暂略——直接说结论：

model 主动 Read 过的 memory 文件 → Layer 1 readFileStateLRU 拦截（"你已经看过了，不必再给"）。
Attachment 已经 surface 过的 path → Layer 2 surfacedMemoryPaths 拦截（"上一轮已经注入过了"）。

单层不够：Layer 1 覆盖"model 主动读"，Layer 2 覆盖"系统自动注入"。跟 v13 Session-Set + LRU 双重 dedup **同源**。

## 类型四分软契约

Memory 文件的 frontmatter 有 `type` 字段——`user` / `feedback` / `project` / `reference`。

但这个字段是**可选的**。没有 runtime validation 强制。缺失了 scan 不崩（返回 undefined）。

这是 v6 hook reason → v10 cacheBreak reason → v11 INLINE_PATTERN → v12 TodoWrite 不变量 → v13 every-line-test → **v14 类型四分**软契约线索的第六次显形。同一条设计哲学的不同投影：**在 LLM agent 工程里，很多"规则"只能是 prompt 引导，不能是 runtime 强制**——因为 model 需要 agency 来处理边界情况。

## 架构正交性第 8 次验证

v14 不新建任何通道。195 行新代码全靠已有子系统接住：

- v4 fork sub-agent → background extraction
- v6 hook engine → Stop event
- v7 obs → FileWriteTool 自动 cardinality 控制
- v10 systemPromptSection → MEMORY.md 索引
- v11 wrapMessagesInSystemReminder 精神 → relevant_memories attachment
- v13 readFileStateLRU → dedup Layer 1

这是 mini harness 正交架构设计的最终验证——7 个子系统像乐高积木一样自由拼装，新需求不需要打补丁，只需要在已有管道上接新逻辑。

## 工业偏离合规清单

| 偏离 | 教学版 | 工业版 | 理由 |
|------|-------|-------|------|
| Selector | mtime + 关键词规则化 | Sonnet helper model | 避免外部 API 依赖 |
| 路径 | demo-project/.claude-memory/ | ~/.claude/projects/xxx/memory/ | 隔离演示环境 |
| Session cap | 5 文件硬上限 | 60KB (MAX_SESSION_BYTES) | 文件数更直观 |
| Extraction turn | 3 turn | 5 turn | 教学环境足够 |
| Prefetch | 同步 | async 非阻塞 | 延迟优化不影响论断 |
| Prompt cache | 无物理验证 | forked agent shared cache | DeepSeek API 不暴露 |

## 下一步

回到 `/learn` 让课程验收这个 task。v14 是 mini harness 的最后一个子系统——14 个 artifact 齐备后将触发 assemble 拼装毕业产物。
