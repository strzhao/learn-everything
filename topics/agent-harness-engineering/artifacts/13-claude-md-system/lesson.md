# Lesson 13 — Mini Project-Memory System (CLAUDE.md 子系统)

> v13 给 agent 加最后一层 —— **开会就背在身上的项目级长期记忆**。复用 v10 system prompt section（上轨）+ v11 attachment（下轨）**字面 0 修改**接住整个子系统。架构正交性第 7 次验证。下半场用 `/init` 的 every-line-test 重写一份 CLAUDE.md 作设计哲学的物理证明。

## 是什么 + 为什么现在学

agent 至此学完两层指令注入：v11 skill = **用户主动喊**才生效（`/skill-name`）；v12 TodoWrite = **任务自我管理**（agent 自己用工具维护清单）。两层都是"agent 主动 + 一次性"模式。

CLAUDE.md 不一样 —— 它是 **agent 一开会就自动背在身上、跨整个 session 持续在场** 的指令层。它跟项目+用户建立长期关系：你的 ~/.claude/CLAUDE.md 永远在 / 项目根的 CLAUDE.md 进项目就在 / 子目录的 CLAUDE.md 走到哪触发哪。

更妙的是 —— v13 没新增任何注入通道。它**完全复用** v10 systemPromptSection（上轨）+ v11 wrapMessagesInSystemReminder attachment（下轨）。dispatch / hook / permission / obs / cache 字面 0 修改接住整个 CLAUDE.md 子系统。这是 mini harness 第 7 次架构正交性验证。

## 怎么跑（物理锚点）

```bash
cd topics/agent-harness-engineering/artifacts/13-claude-md-system

# Demo A: root→CWD cascade 多层加载（5 层 from User to packages/foo）
cd demo-project/packages/foo
bun run ../../../agent-v13-claude-md-system.ts --role=interactive --mode=bypassPermissions --hooks=audit --prompt="按 CLAUDE.md 规则只回复一句话 hello world"

# Demo B: nested attachment lazy 触发（FileReadTool 读子目录文件 → 下一轮注入 subdir/CLAUDE.md）
cd ../..  # back to demo-project
bun run ../agent-v13-claude-md-system.ts --role=interactive --mode=bypassPermissions --hooks=audit --prompt="先用 read_file 工具读 ./subdir/file.ts，然后再回复一句话 task done"

# Demo C: maybeCompact 触发 cache clear（5 个文件顺序读 → ≥5 轮触发 fullCompact）
bun run ../agent-v13-claude-md-system.ts --role=interactive --mode=bypassPermissions --hooks=audit --prompt="按以下顺序逐个完成任务，每完成一个就用 read_file 工具继续下一个，最后回复 [TASK-DONE]：(1) read_file ./CLAUDE.md (2) ..."

# Demo D: LRU 8 entry 驱逐 + Session-Set 防御（不调 model API / 直接演示双层 dedup）
bun run ../agent-v13-claude-md-system.ts --demo=lru-busy
```

预期看到 4 类字面证据：
- `[MEMORY LOAD] cwd=... loaded=N layers=[User+Project*M+Local]` —— 上轨注入
- `[NESTED INJECT] ./subdir/CLAUDE.md (triggered by ./subdir/file.ts)` —— 下轨注入
- `[CACHE CLEAR] memoryCache + LRU cleared by compact: N entries dropped (session-set retained)` —— compact 失效
- `[LRU EVICT] /fake/dir-1/CLAUDE.md` + `[DEDUP] ... already in session-set, skipping` —— 双层 dedup

## 类比 1: GPS 三层地图

把项目级长期记忆比作 GPS 导航的三层地图：

- **`~/.claude/CLAUDE.md`（User）= 全国地图**：打开 GPS 永远载入 / 所有项目共享
- **项目根 `CLAUDE.md`（Project）= 当地路网图**：进城（项目）才载入 / cwd 在哪里就 cascade 到哪里
- **子目录 `CLAUDE.md`（Nested）= 街区路标**：走到哪个街区才弹出来 / FileReadTool 触发
- **`CLAUDE.local.md`（Local）= 你私下贴的便利贴**：只在 cwd 加载 / 不进 git / 个人偏好

GPS 类比有第二层契合点 —— 好导航不是"标出所有路"那叫地图，是"在你会走错的地方提醒你"。这正是 `/init` 命令字面写下的设计哲学：

> "Every line must pass this test: Would removing this cause Claude to make mistakes? If no, cut it." (`src/commands/init.ts:97`)

CLAUDE.md 不是项目 README —— 它是**"Claude 会犯错的地方的镜像"**。

## 类比 2: agent 指令系统的"法律体系"

| 指令形态 | 法律对应 | 特性 |
|---|---|---|
| `settings.json` | 行政令 | `key=value` 机器执行 / 人读起来扁平无理由 |
| system prompt 字段（锁死的）| 宪法 | 一旦写定全员遵守 / 修改成本高（破坏 prompt cache prefix）|
| **CLAUDE.md** | **案例法** | actionable + reason + 判例累积 / 每条都从一个具体错误抽象出来 |
| `/init` 的 every-line-test | 立法门槛 | "removing this would cause problems" = 必须有现实判例才能立法 |

learn-everything 这个项目的 CLAUDE.md "反例（已发生）"段落就是字面**案例法** —— task 05 凭命名推断写错 / task 11 术语跨层糊化都是判例。

## 4 条核心论断（带 run-log 字面证据）

### 论断 1: 双轨注入 = 已学通道复用（架构正交性第 7 次验证）

CLAUDE.md 同时占两条注入通道，**两轨服务不同生命周期内容，不是冗余而是经济选择**：

- **上轨**：v10 `systemPromptSection('memory', loadMemoryPrompt)` —— 享 prompt cache / 适合 stable 全局规则（User + Project + Local 主层）
- **下轨**：v11 `wrapMessagesInSystemReminder` attachment 通道 —— per-turn 重新构造 / 适合"走到哪弹哪"的 nested 内容（FileReadTool 触发）

先看上轨 cascade 加载到 system prompt 的 `[MEMORY LOAD]` 字面证据（cwd=demo-project/packages/foo / 5 层 root→CWD cascade）：

@include(./run-log-root-to-cwd-cascade.txt, round=1)

观察：`[MEMORY LOAD] loaded=5 layers=[User+Project*3+Project(packages/foo)]` —— 从 home 一路 cascade 到 cwd / 5 层全部进 system prompt 上轨。

再看下轨 nested attachment 物理注入到 messages 的 user-role text block（FileReadTool 读 ./subdir/file.ts → 下一轮 messages 含 `<system-reminder>\nContents of ./subdir/CLAUDE.md:`）：

@include(./run-log-nested-trigger.txt, section="FINAL MESSAGES")

观察：FINAL MESSAGES 第 3 条 user message 的 content 数组 —— 第一个 block 是 tool_result（必须紧跟 tool_use / 详见后面"工业洞察"段）/ 第二个 block 是 `<system-reminder>\nContents of ./subdir/CLAUDE.md:` text block。这就是 v11 wrapMessagesInSystemReminder 通道在 v13 的物理对应。

下面是 v13 §27-§31 完整实现（5 段 165 行 / **100% v13 新增** / v12 中 §27 不存在 / 跟 v12 相比仅 4 处 +12 行最小侵入分布在 §3/§5/§7/§10）。代码顶部 `⬇⬇⬇⬇⬇ v13 新增起点` marker 标识起始 / 末尾 `⬆⬆⬆⬆⬆ v13 新增结束` 标识结束 —— 你从 lesson 进来阅读时**不必在脑里 diff**：以下整段全是新代码 / 历史代码（v12 §1-26）你已经在前面 12 个 lesson 学过了。

@include(./agent-v13-claude-md-system.ts, section=27)

**架构正交性第 7 次验证物理证据**：v12 §1-26 字面 0 修改（除 §3 +1 行 / §5 +5 行 / §7 +1 行 / §10 +5 行 / 共 4 处最小侵入 / 总 +12 行）。dispatch / hook / permission / obs / cache 对 CLAUDE.md 完全不知道却自然命中。

### 论断 2: 三层 append + 后加载者优先

cwd=demo-project 启动 / cascade 加载 4 层（User + Project + Local + 进 demo subdir 通过 nested 触发再加 1 层）。看 model 在 Round 2 的 thinking 和最终输出 —— 它在心里把三层规则**叠成同一个动作**：

@include(./run-log-nested-trigger.txt, round=2)

观察 thinking 段字面拆解三层规则：
1. Project 层 CLAUDE.md 说：回答前必须以 [ROOT-RULE] 标签开头
2. Local 层 CLAUDE.local.md 说：[ROOT-RULE] 升级为 [LOCAL-OVERRIDE]
3. Nested 层 subdir/CLAUDE.md 说：回答需追加 [NESTED-LOADED] 标签

最终 text 输出 `[LOCAL-OVERRIDE] task done [NESTED-LOADED]` —— 三层规则同时生效 / Local 层覆盖 Project 层（"后加载者优先"成立）/ Nested 层叠加。

**这就是 LLM prompt 工程的隐式合并语义**：append-not-override + 字面位置靠后 = 优先级高。"后说的盖前说的"是 model 在 prompt 上下文里的天然行为 / 不需要任何特殊代码强制。

### 论断 3: 双重 dedup = task 02 双层防御同源

为什么需要双层 —— LRU 假设"被驱逐 = 不再用"对 model 主动访问的文件成立 / 但 CLAUDE.md 是**系统自动注入**（不是 model 主动 Read）/ LRU 抽象覆盖不到这类访问模式。Session-Set 不是给 LRU 修 bug，是处理 LRU 抽象之外的另一类访问模式。

run-log-dedup-busy-session.txt 用 9 次连续 add 演示 LRU 8-entry 触顶驱逐 + Session-Set 跨驱逐拦截：

@include(./run-log-dedup-busy-session.txt, section="LRU-BUSY DEMO")

观察阶段 1：第 9 次 add 触发 `[LRU EVICT] /fake/dir-1/CLAUDE.md (cap=8)` / Session-Set 9 个全保留。
观察阶段 2：dir-1 已不在 LRU（false）但仍在 Session-Set（true）。
观察阶段 3：用同一个 evicted path 模拟重新 nested attempt → `[DEDUP] ... already in session-set, skipping (LRU evicted but Session-Set retained)` 字面拦截 / 防止重复注入炸 context + 破坏 cache prefix。

跟 task 02 sandbox+permission 双层防御**同源** —— 两层针对不同失效模式，不是冗余而是必要互补。详见 notes.md §3。

### 论断 4: TOCTOU + compact 触发 cache clear

让 model 顺序 read 5 个文件（让 rounds=5 > MAX_ROUNDS_BEFORE_FULL_COMPACT=4）触发 fullCompact —— 看 §31 clearMemoryCache 在 maybeCompact 末尾被调用 + Session-Set 跨 compact 保留：

@include(./run-log-compact-clear.txt, round=5)

观察 round=5：
- `========== COMPACT EVENT round=5 type=full ==========` —— maybeCompact 触发 fullCompact
- 紧跟生成的 [COMPACTED SUMMARY]（model 替换原始历史）
- `[CACHE CLEAR] memoryCache + LRU cleared by compact: 3 entries dropped (session-set retained, 7 entries kept)` —— **§31 字面执行 + Session-Set 跨 compact 保留 7 条**
- 紧跟 `[MEMORY LOAD] cwd=... loaded=2 layers=[User, Local]` —— compact 后重新加载只 2 层（其余 5 层在 Session-Set 不重新加载 / Session-Set 防御了"compact 后重复注入"）

跟 v10 `clearSystemPromptSections` 同精神：compact 后语义状态变 → cached value stale → 必须丢 cache 强制重算 / 但只清能重算的 / Session-Set 是 dedup 承诺不能跨 compact 失效。

TOCTOU rule 编译过 + 不存在文件 graceful return null（demo 中 ~/.claude/CLAUDE.md 等不存在不报错）—— 详见 notes.md §4 工业对照。

## 工业洞察（lesson 13 最高光）：为什么用独立 isMeta user message

实现 §10 wiring 时我把 nestedReminders prepend 到 toolResults 之前 —— 跑 nested-trigger demo 立刻报：

```
messages.2: tool_use ids were found without tool_result blocks immediately after
```

**Anthropic API 严格要求**：上一条 tool_use → 下一条 user message 的**第一个 content block 必须是对应的 tool_result**。中间不能塞 text block。

修复：`[...toolResults, ...nestedReminders]`（append 而非 prepend）。

**这次踩坑揭示了一个工业实现的隐藏动机** —— 看工业 `messages.ts:3700-3707` 把 nested_memory 转成**独立 isMeta user message** 而不是塞进同一个 user content：

```ts
case 'nested_memory': {
  return wrapMessagesInSystemReminder([
    createUserMessage({ content: `Contents of ...`, isMeta: true }),
  ])
}
```

不是为了 `isMeta` semantics（教学版可以不要 isMeta）—— **是为了避开 tool_use→tool_result 位置约束**！独立 message 就没有这个问题，可以用 system-reminder wrap 自由编排。教学版用同一 user message append 也工作 / 但条件是必须严格 tool_result-first 顺序。

这是 spec 文档完全没有的工业洞察 —— **真跑才发现**。验证了 0 假设原则的价值：spec 写得再细也不能替代真跑物理验证。

## 设计哲学下半场：every-line-test 实践

`demo-project/CLAUDE.md` 重写过程：

**砍掉的 4 条候选规则**（不 pass every-line-test）：
- ~~"项目使用 TypeScript + bun runtime"~~ —— 标准约定 / Claude `ls` 一下就知道（init.ts:110-117 排除清单字面命中）
- ~~"代码要清晰简洁"~~ —— 抽象原则没附判例 / 删掉不会让 Claude 犯具体错（init.ts:115）
- ~~"提交注释要写清楚 why"~~ —— 这是团队 git commit 规范 / 不是给 Claude 的 actionable 约束
- ~~"src/ 是源码目录"~~ —— 文件结构介绍 / Claude `ls` 出来（init.ts:110）

**保留的 6 条规则**（每条都附**真实判例** + How to apply）：

1. 改 .tsx 前必须 Read（判例：className kebab→Pascal 改名导致 oldString 推断失败）
2. 改 promotion 类型字段必同步 fixtures（判例：q3 price 类型变更 fixture drift 假绿挂 30 分钟）
3. CI failing 不允许 push --force（判例：上季抢点跳 lint 上线 build 挂回滚）
4. 新组件优先复用 src/ui/（判例：4 个 Button 组件并存设计审查打回 q4 sprint）
5. 改 promotion-banner.tsx props 必跑 storybook（判例：hover state 单测看不出来一周后才发现挂了）
6. catch 块的 logger.error 必含 promotion_id（判例：q2 排查灰盘 800 个 promotion 30 分钟才定位）

**6 条 + 0 条空话 + 0 条标准约定** —— 这就是 every-line-test 的物理产出。每条都从"我们曾犯过 X 错"抽象出来。

## reflection: learn-everything 项目自身 CLAUDE.md 的 every-line-test 审视

cd 到本项目根读 `/Users/stringzhao/workspace/agi/live/learn-everything/CLAUDE.md`，逐条审视：

**最强 2 条**（pass test 最干净 / 判例最真实）：

1. **0 假设原则**（line 45-66）—— 含 task 05 凭命名推断写错 + task 11 术语跨层糊化两个**真判例** / 每条规则有 Why + How to apply / 这是案例法的教科书写法。每删一条规则 Claude 都会立刻退回到那个犯错状态。
2. **why/how 优先于 what 原则**（lesson 13 当轮新增）—— 直接来自本次 LRU 100 第一版回答失衡判例 / 5 条强制规则覆盖了 instructor 教学场景所有"什么时候必须铺 why"的失衡情况。

**可砸掉的 1-2 条**：

1. **"## 代码风格"段落**（最末尾）的"中文写作，技术术语保留英文括注（如'间隔效应（spacing effect）'）"—— 这是**写作风格偏好**不是"删了 Claude 会犯错的具体行为"。删掉 Claude 不会犯错，只会让 lesson.md 写法略微不同。命中 init.ts:115 字面"abstract principles without case examples"。
2. **"## 仓库结构"段落的 ASCII tree**（line 8-23）—— 这是项目结构介绍 / Claude 用 `ls` 几次就能 build 出心智模型。`init.ts:110` 字面排除"file lists / standard project structure"。删掉不影响 Claude 行为。

注：这两条不是错误 —— 它们对**人类工程师**审 PR 时有价值（项目新成员快速建立结构印象）/ 但 CLAUDE.md 是给 AI 读的 / 双读 surface 这两条偏向人读价值。如果要严格 every-line-test / 应该挪到 README.md 而非 CLAUDE.md。

**这个 reflection 不是要改 learn-everything 项目的 CLAUDE.md**（user 反馈点 1 (c) 字面"不动原文"）—— 是证明你已经具备"批判任何一份 CLAUDE.md 是否符合 every-line-test"的实操判断力。这是设计哲学下半场的**最强毕业证**。

## 工业偏离教学化简（合规清单）

| 工业行为 | v13 化简 | 偏离理由 |
|---|---|---|
| 4 层加载（含 `/etc/claude-code` Managed）| 3 层（User+Project+Local）| Managed 是企业部署场景 / 跟 User 机制完全相同 |
| 三套独立缓存（避免循环依赖）| 单 Map | 工业避免 yoloClassifier→permission→claudemd 循环 / 教学版无此压力 |
| readFileState LRU 100 entry / 25MB 字节双限 | 8 entry（保字节限） | 8 entry 在 demo 中能物理演示驱逐 / 100 entry 需要人造 100+ 文件场景 |
| 上轨 cascade 不查 Session-Set | 上轨 cascade 也查 Session-Set | 工业行为 / 教学化简后让 [MEMORY LOAD] 跨 compact 减少 / 演示 Session-Set 跨 compact 保留更直观 |
| nested_memory 走独立 isMeta user message | 同 user message append（toolResults 之后）| 工业避开 tool_use→tool_result 位置约束 / 教学版 append 也工作 |
| 4 阶段处理（Phase 1 conditional rules / Phase 2 nested / Phase 3 unconditional / Phase 4 cwd-level conditional only）| 只走 Phase 3 nested directories | 跟 CLAUDE.md 子系统正交的高级特性（globs / conditional rules）|
| Auto-memory / team-memory / Managed conditional rules | 不实现 | 跟 CLAUDE.md 子系统正交 |

**工业偏离不是 bug** —— 是教学版的有意化简 / lesson 13 上半场学清楚机制要点 / notes.md 详细对照工业实现差异。

## 下一步

回到主对话让 instructor 做 task 13 验收 / accept → artifact_count 11→13 → 触发 assemble 拼装 13 个 artifact 作 mini harness 毕业证。
