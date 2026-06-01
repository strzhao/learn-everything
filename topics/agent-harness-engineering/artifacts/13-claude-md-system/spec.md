# Task 13 Spec: v13 Mini Project-Memory System + Reauthored mini-CLAUDE.md

> agent 至此已学会"用户主动喊技能"（v11 skill）和"任务自我管理"（v12 todo）。v13 加最后一层——**agent 一开会就背在身上的项目级长期记忆**：CLAUDE.md。它复用 v10 system prompt section（上轨）+ v11 attachment 通道（下轨）字面 0 修改地接住整个子系统——**架构正交性第 7 次验证**。下半场用 `/init` 的 every-line-test 重写一份 mini-CLAUDE.md 作设计哲学的论文证明。

## 目标

在 v12 ~1700 行之上加 ~200 行实现 mini project-memory 系统，并交付一份重写的 mini-CLAUDE.md。验证 5 个核心论断：

1. **双轨注入**——CLAUDE.md 同时走两条已学注入通道：上轨 `systemPromptSection('memory')` 享 prompt cache（v10 工厂字面不动）/ 下轨 `nested_memory` attachment 转 `wrapMessagesInSystemReminder` user message（v11 通道字面不动）。两轨服务不同生命周期内容（stable 上轨 / 触发式下轨），不是冗余而是经济选择
2. **三层加载 append-not-override + 后加载者优先**——User (~/.claude/CLAUDE.md) → Project (项目根 CLAUDE.md) → Local (CLAUDE.local.md) 顺序加载，全部 `result.push(...)` 不覆盖；输出到 prompt 时**字面位置靠后 = 优先级高**——LLM prompt 工程的隐式合并语义
3. **双重 dedup = task 02 双层防御同源**——Session-Set（永不驱逐 / `Tool.ts:222` `loadedNestedMemoryPaths`）+ readFileState LRU（100 entry 可驱逐）。**单 LRU 不够**：busy session 中旧 entry 驱逐导致同一份 CLAUDE.md 反复注入 → 既炸 context 又破坏 prompt cache prefix 距离
4. **TOCTOU rule + compact-triggered cache clear**——读 CLAUDE.md **不做 existence check** 直接 `fs.readFile` 失败回 null（`bridgePointer.ts:76-82` 字面 "no existence check (CLAUDE.md TOCTOU rule)"）；`maybeCompact` 末尾触发 `clearMemoryCache`（跟 v10 `clearSystemPromptSections` 同精神 / `postCompactCleanup.ts:25,52-54`）—— 因为 compact 后语义状态变 / cached value stale 必须重读
5. **架构正交性第 7 次验证 + prompt-as-actionable-constraint 极致**——dispatch / hook / permission / obs / cache 对 CLAUDE.md 加载链字面 0 修改自动复用。下半场 mini-CLAUDE.md 重写实践 `init.ts:97` every-line-test：每条规则都附**判例**（具体的"我们曾犯过 X 错"），是 v6/v10/v11/v12 软契约线索的最浓密物理载体——**不仅约束写在 prompt，连"什么样的约束值得写"的元约束也写在 prompt 里**

## 教学复杂度控制（工业砍掉项）

| 工业特性 | v13 决策 | 理由 |
|---|---|---|
| 4 层加载（Managed `/etc/claude-code` + User `~/.claude` + Project + Local）| 简化为 3 层（User + Project + Nested）| Managed 是企业部署场景，跟 User 机制完全相同 |
| ~~Project 内部 root→CWD 子层扫描~~ | **保留**（user 反馈点 2 决定） | monorepo / nested package 场景必需，演示"后加载者优先"最直接 |
| 三套独立缓存（getMemoryFiles memoize / getUserContext memoize / cachedClaudeMdContent）| 简化为单一 Map（`memoryCache: Map<string, MemoryFile>`）| 三套是工业避免循环依赖的工程权衡，教学版没循环依赖压力 |
| readFileState LRU 100 entry | 简化为 LRU 8 entry | 8 entry 能在 demo 中物理演示驱逐场景，触发 Session-Set 防御逻辑 |
| `MemoryFile` 完整字段（path/type/content/parent/globs/contentDiffersFromDisk/rawContent）| 简化为 `{path, type, content}` | parent/globs 服务条件激活，contentDiffersFromDisk 服务 Edit/Write 检测——都是高级特性 |
| `processedPaths` Set 防递归 | 不实现 | 教学版 nested 只支持单层（无递归 import 链）|
| `safelyReadMemoryFileAsync` 多种错误分类 | 简化为 try/catch + return null | TOCTOU 核心是"不预检查"，错误分类是健壮性补丁 |
| `isInjectedMemoryFile` filter（避免 system prompt 重复注入 nested）| 不实现 | 教学版 eager-load 只加载 User+Project+Local 三层，nested 永远走下轨 attachment |
| `--add-dir` 多目录支持 | 不实现 | 单 cwd 覆盖核心机制 |
| Auto-memory（memdir）/ 团队 memory / Managed conditional rules | 不实现 | 跟 CLAUDE.md 子系统正交，属另一个学习主题 |
| `/init` 命令 + OLD_INIT_PROMPT/NEW_INIT_PROMPT 全文 | 不实现命令本身 | 只在重写 mini-CLAUDE.md 实践阶段把 every-line-test 用作"立法门槛" |

## 设计要点

### §27: ProjectMemoryLoader（loadMemoryFiles）

- 启动时一次性扫描三层路径，**Project 层支持 root→CWD 多层级联**（user 反馈点 2 决定保留）：
  1. **User**: `~/.claude/CLAUDE.md`（可选 / 不存在跳过）
  2. **Project root→CWD cascade**: 从 cwd 向 root 走每一层，遇到 `CLAUDE.md` 全部 push 到列表（如 cwd=`/repo/packages/foo` 时按顺序加载 `/repo/CLAUDE.md` → `/repo/packages/CLAUDE.md` → `/repo/packages/foo/CLAUDE.md` 三层）
  3. **Local**: `<cwd>/CLAUDE.local.md`（项目私人 / 不存在跳过）
- 每条加载经 `safelyReadMemoryFile`：直接 `await fs.readFile(path, 'utf-8')`，**不预先 stat 检查存在性**——任何错误（ENOENT / 权限 / 编码错）统一 `return null`
- 返回 `MemoryFile[]`，**`result.push` 顺序 = User → Project root → Project sub-pkgs → Local**（数组末尾 = 优先级高 / cwd 最近的层级在末尾）
- 同时把每条加载的 `path` 加入 `loadedNestedMemoryPaths` Session-Set 防止下轨重复注入
- 工业对照：`src/utils/claudemd.ts:618-625` `processMemoryFile` + `:790-934` 加载顺序 + `:878-920` Project root→CWD cascade + `:424-436` `safelyReadMemoryFileAsync`

### §28: 双轨注入

**上轨（eager / system prompt section）**：
- 在 v10 §19 `PROMPT_SECTIONS` 数组追加 `systemPromptSection('memory', () => loadMemoryPrompt())`
- `loadMemoryPrompt()` 读 §27 加载结果，按"# Memory from {path}\n\n{content}\n\n---\n"格式合并三层
- **v10 工厂字面 0 修改**——这正是架构正交性第 7 次验证的物理证据
- 工业对照：`src/constants/prompts.ts:495` `systemPromptSection('memory', loadMemoryPrompt)` 字面

**下轨（lazy / nested_memory attachment）**：
- FileReadTool（v8 起就有的工具）执行后检查："被读文件的目录里有 CLAUDE.md 吗？"
- 如有：构造 `Attachment { type: 'nested_memory', content: { path, content } }`
- 渲染时走 v11 现有的 `wrapMessagesInSystemReminder` 通道，转成 `{role:"user", content:"<system-reminder>\nContents of {path}:\n\n{content}\n</system-reminder>", isMeta:true}` 注入下一轮 messages
- **v11 通道字面 0 修改**——只新增 `'nested_memory'` case 分支
- 工业对照：`src/utils/messages.ts:3700-3707` `case 'nested_memory'` + `src/utils/attachments.ts:1718-1750` `getNestedMemoryAttachmentsForFile`

### §29: 双重 dedup（Session-Set + readFileState LRU）

- **Session-Set `loadedNestedMemoryPaths: Set<string>`**：永不驱逐，agent 启动时初始化空集合，每次成功加载某 CLAUDE.md（无论上轨或下轨）后 `set.add(absolutePath)`
- **readFileState LRU**：8-entry LRU（教学版小规模），按 `Map` insertion order 实现 LRU 驱逐
- **协同**：每次下轨触发前先 `if (loadedNestedMemoryPaths.has(path)) continue` 跳过；只有 Set 没记录的才进 LRU 加载
- **关键场景演示**：busy session 中 LRU 先把 path X 驱逐 → 后续不重新加载 X（因为 Session-Set 还记得 X 已加载过）
- 工业对照：`src/Tool.ts:217-225` 注释 + `src/utils/attachments.ts:1718-1750` 双层判断

### §30: TOCTOU rule（safelyReadMemoryFile）

- 函数签名：`async function safelyReadMemoryFile(path: string): Promise<string | null>`
- 实现：`try { return await fs.readFile(path, 'utf-8') } catch { return null }`
- **绝不**先 `await fs.stat(path)` 或 `await fs.access(path)` 再 read——避免 stat→read 之间文件被删除/移动的竞态窗口
- 在 §27 / §28 / §29 所有读 CLAUDE.md 的代码路径都过这个函数
- 工业对照：`src/bridge/bridgePointer.ts:76-82` 字面 `"no existence check (CLAUDE.md TOCTOU rule)"`

### §31: compact wiring（clearMemoryCache）

- v10 已有 `maybeCompact` 末尾调 `clearSystemPromptSections`（§7 修改）
- v13 在同位置追加一行 `clearMemoryCache()`：清空 §27 的 `memoryCache: Map`、清空 §29 的 readFileState LRU
- **保留** `loadedNestedMemoryPaths` Session-Set——它是 session 级永不清空的（dedup 逻辑跨 compact 仍有效）
- 工业对照：`src/services/compact/postCompactCleanup.ts:25,52-54` `clearMemoryFiles` 调用位置

### §32: mini-CLAUDE.md 文件 + every-line-test 重写（双交付）

**主交付（demo-project）**：
- 路径：`artifacts/13-claude-md-system/demo-project/CLAUDE.md`（独立 demo 项目的根 CLAUDE.md）
- 长度：50-100 行 markdown
- demo-project 完整结构（4 文件 + 1 触发文件）：
  - `demo-project/CLAUDE.md`（项目根 / 主重写对象）
  - `demo-project/CLAUDE.local.md`（5-10 行 / 演示 Local 层后加载者优先）
  - `demo-project/packages/foo/CLAUDE.md`（10-20 行 / 演示 Project sub-pkg 层 / 反馈点 2 多层扫描的物理证据）
  - `demo-project/subdir/CLAUDE.md`（演示 nested 下轨 attachment 触发）
  - `demo-project/subdir/file.ts`（FileReadTool 触发文件）
- **强制要求**：每一条规则必须附**判例**（"我们曾犯过 X 错"或借用 task 05/11 历史反例）+ "How to apply" 行
- **强制要求**：每一条规则必须 pass `init.ts:97` test："Would removing this cause Claude to make mistakes?"——回答必须是"会"，不是"可能会"
- **禁止包含**（init.ts:110-117 排除清单字面）：
  - 文件列表 / 项目目录结构介绍（`ls` 能看出来的）
  - 标准约定（"用 TypeScript" / "源码在 src/"）
  - 长教程 / 完整 API 文档
  - 频变信息（"当前 sprint 在做 X"）
  - 抽象原则没附判例的（"代码要清晰" / "测试要充分"）

**次交付（reflection in lesson.md）**（user 反馈点 1 (c) 决定）：
- lesson.md 新增 reflection 段（`## reflection: learn-everything 项目自身 CLAUDE.md 的 every-line-test 审视`）
- 不动 learn-everything 项目的 `CLAUDE.md` 原文 / 仅在 lesson.md 中分析
- 逐行审视 `/Users/stringzhao/CLAUDE.md`（learn-everything 项目级）每一条
- 点出 1-3 条**可以砸掉**的（不 pass every-line-test 的具体行 / 解释为什么 / 引用 init.ts:110-117 排除清单具体哪条）
- 同时点出**最强的 1-2 条**（pass every-line-test 最干净 / 判例最真实 / 解释为什么）
- 这是设计哲学下半场的"实战判断力"证明 —— 能批判自己写的 CLAUDE.md 是"会设计"的最强证据

## 交付清单

| 文件 | 内容 |
|---|---|
| `agent-v13-claude-md-system.ts` | ~1900 行（v12 ~1700 + §27/§28/§29/§30/§31 共 ~200 行 / §27 +70 含 root→CWD cascade）|
| `demo-project/CLAUDE.md` | 重写的 mini-CLAUDE.md ~50-100 行 / 每条附判例 / 每条 pass every-line-test（主重写对象）|
| `demo-project/CLAUDE.local.md` | 演示 Local 层后加载者优先（5-10 行）|
| `demo-project/packages/foo/CLAUDE.md` | 演示 Project sub-pkg 层 / root→CWD 多层扫描的物理证据（10-20 行 / user 反馈点 2 决定） |
| `demo-project/subdir/CLAUDE.md` | nested 层（演示下轨 attachment 触发场景）|
| `demo-project/subdir/file.ts` | nested 触发文件（FileReadTool 读它时触发 subdir/CLAUDE.md attachment）|
| `run-log-eager-load.txt` | 启动时多层加载进 system prompt 上轨（cache hit 跨轮）|
| `run-log-nested-trigger.txt` | FileReadTool 读 subdir/file.ts → nested_memory attachment 注入下一轮 |
| `run-log-compact-clear.txt` | maybeCompact 后 memoryCache 清空 / Session-Set 保留 / 下轮重读 |
| `run-log-dedup-busy-session.txt` | LRU 驱逐场景 + Session-Set 防重复注入物理证据 |
| `run-log-root-to-cwd-cascade.txt` | cwd=demo-project/packages/foo 启动 / system prompt 三段 memory section / 下层覆盖上层（user 反馈点 3 决定 / 与反馈点 2 物理对接）|
| `notes.md` | 实现笔记 + 工业对照 + 砍掉项详解 + 5 份 run-log 串读 |
| `excerpts.md` | claude-code 源码引用（claudemd.ts / attachments.ts / messages.ts / Tool.ts / bridgePointer.ts / postCompactCleanup.ts / init.ts）|
| `lesson.md` | 教学叙事（lecture 13+14 内容浓缩成可读叙事 / 8 条 lesson.md 规范 / GPS 类比 + 法律体系类比双类比 / **含 reflection 段批判 learn-everything 自身 CLAUDE.md** / user 反馈点 1 (c) 决定）|
| `README.md` | 三段式（它做什么 / 怎么用 / 与其他组件的关系）|

## 核心论断工业对照

| # | 论断 | 工业源码 file:line | run-log 验证方式 |
|---|---|---|---|
| 1a | 上轨 systemPromptSection('memory') | `prompts.ts:495` | run-log-eager-load: 首轮 system prompt 含 `# Memory from <path>` 三段；Round 2+ cache hit |
| 1b | 下轨 nested_memory wrapMessagesInSystemReminder | `messages.ts:3700-3707` | run-log-nested-trigger: FileReadTool 后下一轮 messages 出现 `<system-reminder>\nContents of subdir/CLAUDE.md:` user-role 块 |
| 2 | 后加载者优先（append-not-override）| `claudemd.ts:790-934` | run-log-eager-load: User 段说 "rule X = A" / Local 段说 "rule X = B" / model 行为遵循 B（Local 在末尾覆盖）|
| 3a | Session-Set 永不驱逐 | `Tool.ts:222` | run-log-dedup-busy-session: 第 1 次加载后 Set 含 path / 跨 5 轮 LRU 8 entry 反复驱逐 / Set 仍在 / 第 6 轮跳过加载 |
| 3b | readFileState LRU 8 entry | `attachments.ts:1734-1750` | run-log-dedup-busy-session: LRU 显示 evict 旧 entry 字面输出 |
| 4a | TOCTOU rule no existence check | `bridgePointer.ts:76-82` | run-log-eager-load: User 层 `~/.claude/CLAUDE.md` 不存在场景 / safelyReadMemoryFile 直接返回 null / 不报错 / 不打 stat syscall（用 strace 不现实，改为代码注释证明）|
| 4b | compact 后 clearMemoryCache | `postCompactCleanup.ts:25,52-54` | run-log-compact-clear: maybeCompact 触发 / OBS 显示 `[CACHE CLEAR] memoryCache=3 entries dropped` / Round N+1 重读三层 |
| 5 | 架构正交性第 7 次 | dispatch/hook/permission/obs 字面不动 | 所有 run-log 都有 OBS METRIC tool_name=read_file 完整 cardinality / PreToolUse hook 触发 / nested_memory attachment 经过 v11 wrapMessagesInSystemReminder（永远不知道 CLAUDE.md 存在）|

## v12 改造点（最小侵入）

| v12 位置 | 改动 | 行数 |
|---|---|---|
| §3 PROMPT_SECTIONS（v10 §19）| 追加 `systemPromptSection('memory', loadMemoryPrompt)` | +1 |
| §5 execute() FileReadTool | execute 后追加 nested_memory 探测调用（5 行） | +5 |
| §7 maybeCompact 末尾 | 加 `clearMemoryCache()` | +1 |
| §10 runRounds | 在 attachment 收集阶段调 `getNestedMemoryAttachments(toolUseContext)` 合并到 attachment 列表 | +5 |
| 新增 §27 ProjectMemoryLoader | loadMemoryFiles + safelyReadMemoryFile + memoryCache + **root→CWD cascade**（user 反馈点 2 决定保留）| +70 |
| 新增 §28 双轨注入 wiring | loadMemoryPrompt（上轨）+ getNestedMemoryAttachments（下轨）| +60 |
| 新增 §29 双重 dedup | loadedNestedMemoryPaths Session-Set + readFileStateLRU 实现 | +40 |
| 新增 §30 TOCTOU 文档化 | safelyReadMemoryFile 内联（已在 §27）+ 注释 | +0 |
| 新增 §31 clearMemoryCache | 清 memoryCache + LRU / 保留 Session-Set | +15 |
| **总计** | | **~197 行新增** |

## mini-CLAUDE.md 重写实操指南（下半场设计哲学落地）

`demo-project/CLAUDE.md` 重写按以下流程：

1. **选场景**：编一个虚拟的 demo 项目（如"内部 promo-card-renderer Web component 库"），让规则有现实的判例土壤
2. **每条规则强制结构**：
   ```markdown
   ### <rule-name>
   <一句 actionable 的约束陈述>
   
   **判例**：<具体的"曾犯过 X 错"故事，1-2 句>
   **How to apply**：<什么时候这条规则触发，1 句>
   ```
3. **每条 pass every-line-test**：动笔前问自己"删掉这条 Claude 会不会犯错？"——回答必须是肯定的"会"，不是"可能会"或"也许"
4. **数量控制**：5-10 条规则 / 不要超过 10 条 / 宁缺毋滥（init.ts 哲学）
5. **示范 Local 层**：`demo-project/CLAUDE.local.md` 5-10 行 / 演示后加载者优先（如 Local 改写一条 Project 的规则方向）
6. **lesson.md 包含 reflection**：分析重写过程中"砍掉了哪 3 条 / 为什么"——这是设计哲学最有教学价值的部分

## 验收标准

1. `bun run agent-v13-claude-md-system.ts` 能跑通，多层 CLAUDE.md 加载进 system prompt + nested 触发 attachment 都生效
2. **run-log-eager-load**：system prompt 字面包含 `# Memory from User` + `# Memory from Project` + `# Memory from Local` 多段 / Round 2+ cache hit（v10 OBS 显示 hit 计数 ≥ 4/5）
3. **run-log-nested-trigger**：FileReadTool 读 `demo-project/subdir/file.ts` 后下一轮 messages 含 `<system-reminder>\nContents of demo-project/subdir/CLAUDE.md:` user-role 块 / model 行为遵循 subdir CLAUDE.md 的指令
4. **run-log-compact-clear**：触发 maybeCompact 后 OBS 字面显示 `[CACHE CLEAR] memoryCache: N entries dropped` / 下一轮 system prompt 重新加载（cache miss）/ Session-Set 保留（dedup 跨 compact 有效）
5. **run-log-dedup-busy-session**：LRU 8 entry 反复驱逐场景 / Session-Set 防止同一份 CLAUDE.md 重复注入 / OBS 字面显示 `[DEDUP] path=X already in session-set, skipping`
6. **run-log-root-to-cwd-cascade**（user 反馈点 3 新增）：cwd=demo-project/packages/foo 启动时 / system prompt memory section 字面包含 3 段 `# Memory from demo-project/CLAUDE.md` → `# Memory from demo-project/packages/CLAUDE.md` → `# Memory from demo-project/packages/foo/CLAUDE.md` / 三层规则方向冲突时 model 行为遵循 foo 层（后加载者优先）
7. **mini-CLAUDE.md 主交付验收**：每条规则附判例 + How to apply / 总长 50-100 行 / 至少有 3 条规则的判例引用 task 05/11 历史反例（保持判例真实性）/ Local 层演示后加载者优先
8. **lesson.md reflection 段验收**（user 反馈点 1 (c) 新增）：lesson.md 含 `## reflection: learn-everything 项目自身 CLAUDE.md 的 every-line-test 审视` 段 / 不动 learn-everything 项目原文 / 点出 1-3 条可砸掉 + 1-2 条最强 / 引用 init.ts 排除清单具体哪条
9. v12 §1-26 核心逻辑不动（除上述 4 处最小改造点 / §3 +1 / §5 +5 / §7 +1 / §10 +5）
10. lesson.md 遵循 lesson.md 叙事规范 8 条 / 含 GPS 三层地图 + 法律体系双类比 / 含 reflection "重写 mini-CLAUDE.md 砍掉了哪 3 条" + 批判 learn-everything CLAUDE.md

## 0 假设原则源码引用清单（all file:line verified by Explore agent）

| 论断 | 文件 | 行号 | 字面证据 |
|---|---|---|---|
| processMemoryFile 函数定义 | `src/utils/claudemd.ts` | 618-625 | `export async function processMemoryFile(filePath, type, processedPaths, includeExternal, depth, parent)` |
| safelyReadMemoryFileAsync TOCTOU | `src/utils/claudemd.ts` | 424-436 | `fs.readFile(filePath, 'utf-8')` 直接读 / try-catch return null |
| 三层加载顺序 | `src/utils/claudemd.ts` | 790-934 | Managed (804) → User (827) → Project (878-920) → Local (923) |
| 上轨 systemPromptSection | `src/constants/prompts.ts` | 495 | `systemPromptSection('memory', () => loadMemoryPrompt())` |
| 下轨 nested_memory case | `src/utils/messages.ts` | 3700-3707 | `case 'nested_memory': return wrapMessagesInSystemReminder([createUserMessage(...)])` |
| Session-Set 初始化 | `src/QueryEngine.ts` | 370 | `loadedNestedMemoryPaths: new Set<string>()` |
| Session-Set 注释 | `src/Tool.ts` | 217-225 | `loadedNestedMemoryPaths` non-evicting Set 解释 |
| 双层 dedup 物理实现 | `src/utils/attachments.ts` | 1718-1750 | `if (toolUseContext.loadedNestedMemoryPaths?.has...) continue` + `if (!toolUseContext.readFileState.has...)` |
| TOCTOU rule 字面命名 | `src/bridge/bridgePointer.ts` | 76-82 | `"handles errors — no existence check (CLAUDE.md TOCTOU rule)"` |
| compact-triggered clear | `src/services/compact/postCompactCleanup.ts` | 25, 52-54 | `clearMemoryFiles()` 调用位置 |
| /init every-line-test | `src/commands/init.ts` | 97 | `"Every line must pass this test: Would removing this cause Claude to make mistakes? If no, cut it."` |
| /init 排除清单 | `src/commands/init.ts` | 110-117 | file lists / standard conventions / long tutorials / volatile info |

---

## 反馈固化记录（2026-06-01）

5 个反馈点已通过 AskUserQuestion 逐条收齐 / spec 已按用户决定全部固化：

| # | 反馈点 | 用户决定 | spec 落实位置 |
|---|---|---|---|
| 1 | mini-CLAUDE.md 重写对象 | (c) demo + learn-everything 批判 | §32 双交付段 + 交付清单 lesson.md 标注 + 验收标准 #8 |
| 2 | 砍掉项保留 | 保留 root→CWD 多层扫描 | 教学复杂度控制表标 ~~~~ + §27 cascade 段 + v12 改造点表 §27 +50→+70 + 交付清单 demo-project/packages/foo/CLAUDE.md |
| 3 | run-log 数量 | 5 份（加 root-to-cwd-cascade）| 交付清单 +1 文件 + 验收标准 #6 |
| 4 | v12 改造点深度 | 默认 4 处侵入 | spec 未变 |
| 5 | 5 条核心论断结构 | 保持 5 条 | spec 未变 |

**最终代码量**：v12 ~1700 + 新增 ~197 行 ≈ v13 ~1900 行  
**最终交付物数量**：13 个文件（agent ts + 5 个 demo CLAUDE.md/.local.md/sub-pkg/subdir + 5 份 run-log + notes/excerpts/lesson/README + spec 本文件）

可以开始实施。
