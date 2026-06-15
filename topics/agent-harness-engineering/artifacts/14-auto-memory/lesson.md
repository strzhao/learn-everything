# v14 · Mini Auto Memory System

> 195 行 TypeScript 让你看见"AI 主动记忆"在物理层由什么构成：不是数据库，不是向量搜索，而是 prompt 协议 + forked sub-agent + 文件系统 + 两层 dedup 闸门。

## 这是什么 + 为什么现在学

v13 给了 agent **项目级硬约束**（CLAUDE.md / 人手维护 / git 追踪）。但有些信息是 agent 在对话中"捡到"的——用户偏好、项目临时状态、外部资源指针。这些信息既不应该放 CLAUDE.md（太碎 / 太个人），也不应该丢掉（下次会话还得重新问）。

v14 解决这个空白：**agent 自己学着记住**。

跟你脑子的工作方式做个类比：
- CLAUDE.md = 你贴在显示器边框上的便签条（团队硬规则，谁来都能看）
- Auto Memory = 你**个人笔记本**（"哦对，这人喜欢简洁回复" / "项目周二发版" / "grafana dashboard 在那个 URL"）——你自己在对话中积累、下次翻出来用

为什么现在学：你在 v12（TodoWrite prompt 软契约 / 主 agent 自律 vs 系统兜底）和 v13（双轨注入 / 双重 dedup）里已经铺好了全部前置。v14 把这两条线索合体——"prompt 协议让 agent 主动写记忆"是 v12 soft contract 的延伸，"双轨注入 + 双层 dedup"是 v13 的结构同型。

## 怎么跑（物理锚点）

```bash
cd topics/agent-harness-engineering/artifacts/14-auto-memory/

# 场景 1：用户明确说"记住" → 主 agent 主路径写 memory
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="记住我喜欢简洁回复，不要废话"

# 场景 2：用户随口提到信息 → background extraction agent 补漏
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="帮我看一下 demo-project/CLAUDE.md 里面有什么内容"

# 场景 3：主 agent 已写 → background 互斥跳过
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="以后代码 review 的时候重点关注性能问题，记住这一点"
```

你会看到的关键现象：`[EXTRACT] skipping — main agent already wrote memory in this turn`（互斥命中）或 `[EXTRACT] triggering background agent`（互斥不命中 → fork 补漏）。

## 核心设计：双轨并发互斥

这是 v14 的**分水岭概念**——想象一个有两只手的秘书：

- **右手（prompt 协议主路径）**：你说"记住 X"，秘书立刻用右手在笔记本上写下。快、准、有 agency。
- **左手（background extraction）**：你随口聊完走了，秘书回想"刚才他提到周二发版...这个该记下来"，用左手补写。慢、被动、兜底。
- **互斥协议**：右手已经写了的话，左手就别再碰同一件事——否则格式不一致还浪费资源。

为什么不只用一条路径？只用右手：model 忙着回答问题时经常忘记"记住"这个副任务。只用左手：用户明确说"记住"时 model 已经写了，background 再写一遍是重复。所以工业设计是**双轨并发 + 互斥**——跟 task 02 sandbox+permission 双层防御同源（两层针对不同失败模式）。

## 场景 1：主路径写 memory — 右手秘书

用户明确说"记住我喜欢简洁回复"，你将看到 model 在 thinking 中识别出"要存 memory"，然后主动调 FileWriteTool：

@include(./run-log-main-write-direct.txt, round=1)

观察三件事：
1. **thinking 里决策**："I need to write a feedback memory file + append to MEMORY.md"——prompt 协议生效，model 自主决定写 memory
2. **双文件写入**：一个写 `feedback-terse.md`（内容），一个写 `MEMORY.md`（索引）——two-step 协议跟工业 extractMemories.ts 一致
3. **frontmatter 有 `type: feedback`**——类型四分软契约，model 自己判定，无 runtime 强制

Round 2 model 只回了"已记住。"两个字。然后看 Stop hook 的关键行为：

@include(./run-log-main-write-direct.txt, round=2)

`[EXTRACT] skipping — main agent already wrote memory in this turn` —— 这就是互斥的物理证据。`hasMemoryWritesSince` 扫到 Round 1 的 FileWriteTool 写入路径落在 `AUTO_MEMORY_DIR` 内 → 返回 true → background agent 不触发。

## 场景 2：Background extraction — 左手秘书补漏

用户没说"记住"，只是问了一句"帮我看下 CLAUDE.md"。主 agent 读完文件、回答完 → Stop event fire → 互斥检查不命中 → fork background agent：

@include(./run-log-background-extract-fallback.txt, round=2)

观察：model 输出结束后，`[EXTRACT] triggering background agent` 触发。下面是 background agent 的独立生命周期：

@include(./run-log-background-extract-fallback.txt, section="swarm[0] LIFECYCLE")

关键观察：
1. **复用 v4 fork sub-agent**：background agent 跟 v4 的 spawn_swarm 是同一条通道，只是 task prompt 变了
2. **独立 context**：swarm[0] 看不到主 agent 的完整对话历史（只有 extraction task 文本）——跟 v4 multi-agent context 隔离同源
3. **本次"No memories to extract"**：因为对话里确实没有值得长期记忆的信息——证明 background agent 有判断力不是无脑写

## 场景 3：互斥 + 双层 dedup 联合验证

这个场景更复杂——用户说"记住关注性能"，主 agent 写入后 background 被互斥跳过。同时在 Round 2 model 读 MEMORY.md 时触发了**双层 dedup**：

@include(./run-log-mutual-exclusion-skip.txt, round=2)

观察 dedup 四行连发：
- `[DEDUP] review-perf-focus already in readFileState — skipping surface` → **Layer 1 命中**：model 刚用 read_file 读过这个 memory，readFileStateLRU 有记录
- `[DEDUP] feedback-terse already surfaced earlier — skipping` → **Layer 2 命中**：BOOT 时 attachment 已注入过
- `[DEDUP] project-release already surfaced earlier — skipping` → Layer 2
- `[DEDUP] user-role already surfaced earlier — skipping` → Layer 2

两层覆盖不同场景：Layer 1 防"model 主动 read 过的不必再 attachment 注入"，Layer 2 防"attachment 已 surface 过的不必再来一遍"。跟 v13 的 Session-Set + LRU 双重 dedup **同源**。

最后确认互斥：

@include(./run-log-mutual-exclusion-skip.txt, round=4)

`[EXTRACT] skipping — main agent already wrote memory in this turn` 再次命中——主 agent Round 1 写了 `review_perf.md`。

## 场景 4：relevant_memories 注入 + 跨场景 dedup

看 BOOT 阶段的注入行为。每次启动时 `injectRelevantMemories` 被调用：

@include(./run-log-relevant-prefetch-double-dedup.txt, section="BOOT")

`[RELEVANT] surfaced 4 memory: review-perf-focus, project-release, feedback-terse, user-role` —— selector 选出 4 条。然后看 FINAL MESSAGES 里 user message 尾部被 append 了完整的 `<system-reminder>` 块（4 条 memory 全文）。

当 model 在 Round 1 主动 `read_file` 读了 `project_release.md` 后，下一轮的 dedup 判断：

@include(./run-log-relevant-prefetch-double-dedup.txt, round=2)

观察 `[DEDUP] project-release already in readFileState — skipping surface` —— Layer 1 (readFileStateLRU) 精确命中：model 自己读过了，system 就不必再 attachment 注入。这跟 v13 的"Session-Set 对 LRU 驱逐免疫"不同层但同精神。

## 代码结构：v14 新增 195 行

下面是 v14 全部新增代码（v13 §1-31 字面 0 修改 / 以下整段 100% 新增）：

@include(./agent-v14-auto-memory.ts, section=32)

§32 是基础设施：路径管理 + frontmatter 解析 + 文件扫描。对照工业 `paths.ts:223-235` / `memoryScan.ts:41-62` / `memdir.ts:129-147`。注意 `type` 字段是 **optional**（line 1137）——软契约第六次显形。

@include(./agent-v14-auto-memory.ts, section=35)

§35 是双轨写入的核心：`hasMemoryWritesSince` 扫 assistant messages 找 FileWriteTool 写入 → `AUTO_MEMORY_DIR` 前缀匹配 → 互斥判定。`executeExtractMemories` 复用 v4 `runSwarm` 作为 fork sub-agent。对照工业 `extractMemories.ts:121-148`（互斥）+ `:415-427`（runForkedAgent）。

## 架构正交性第 8 次验证

v14 不新建任何通道。195 行新代码全靠已有子系统接住：

| 复用子系统 | v14 用途 |
|-----------|---------|
| v4 fork sub-agent | background extraction agent |
| v6 hook engine | Stop event 触发 extraction |
| v7 obs | FileWriteTool 自动 cardinality 控制 |
| v10 systemPromptSection | MEMORY.md 索引上轨 |
| v11 wrapMessagesInSystemReminder 精神 | relevant_memories attachment 下轨 |
| v13 readFileStateLRU | dedup Layer 1 |

7 个子系统像乐高积木自由拼装——新需求不打补丁，只在已有管道上接新逻辑。

## 工业偏离合规清单

| 偏离 | 教学版 | 工业版 | 理由 |
|------|-------|-------|------|
| Selector | mtime + 关键词规则化 | Sonnet helper model call | 避免外部 API 依赖 |
| 路径 | `demo-project/.claude-memory/` | `~/.claude/projects/xxx/memory/` | 隔离演示环境 |
| Session cap | 5 文件硬上限 | 60KB MAX_SESSION_BYTES | 文件数更直观 |
| Extraction turn | 3 turn | 5 turn | 教学环境足够 |
| Prefetch | 同步 | async 非阻塞 | 延迟优化不影响论断 |
| Prompt cache | 无物理验证 | forked agent shared prefix cache | DeepSeek API 不暴露 |

## 下一步

回到 `/learn` 让课程验收 task 14。v14 是 mini harness 的最后一个子系统——14 个 artifact 齐备后将触发 assemble 拼装毕业产物。
