# notes.md —— Task 03 对照报告

> 5 条 `bypassPermissions` 推测对照 claude-code 工业实现 + mode 矩阵的物理承载分析 + 推测之外的发现 + 写回 v2 的改进意见。
>
> v3 代码不是凭空设计的 —— 它是"读完源码 + 跑通 4 份 run-log"之后对 Task 02 推测的再表达。本文档证明每一行 v3 都有源码支撑或实验支撑。

---

## §1. 源码定位（步骤 0）

**结论**：claude-code 的 permission 子系统**有可读源码**，并且是 5 条推测的最佳验证靶子。

### grep 的关键字与命中

| 关键字 | 命中文件 |
|---|---|
| `bypassPermissions` | `src/utils/permissions/permissions.ts` (line 1269) |
| `safetyCheck` | `src/utils/permissions/permissions.ts` (多处) |
| `requiresUserInteraction` | `src/utils/permissions/permissions.ts:1232` + 各 tool 定义 |
| `logPermissionDecision` | `src/hooks/toolPermission/permissionLogging.ts:181` |
| `acceptEdits` / `PermissionMode` 枚举字面量 | `node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts:337` |
| `dangerouslyDisableSandbox` | `sdk-tools.d.ts:373` + `src/tools/BashTool/` |

### 关键路径

- **判决核心**：`src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseToolInner()`（1158-1310 行），是 (tool × mode × input) → policy 的唯一入口
- **审计核心**：`src/hooks/toolPermission/permissionLogging.ts` 的 `logPermissionDecision()`，注释明说 *"Single entry point for all permission decision logging"*
- **执行层**：`src/hooks/toolPermission/handlers/` 下 `interactiveHandler.ts`（交互式）/ `swarmWorkerHandler.ts`（subagent）/ `coordinatorHandler.ts` 各自实现"如何向 user 询问"
- **mode 枚举**：`sdk-tools.d.ts:337` 给出 `"acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan"`（v3 实现了前 3 个）

源码片段全部归档在 [excerpts.md](./excerpts.md)，下文按需引用。

---

## §2. 5 条推测逐条对照

### 推测 1：bypass 不在 model 层，system prompt 不变

**判定**：✅ **命中**

**源码**：[excerpts.md §1](./excerpts.md) — `src/constants/prompts.ts:189`

System prompt 第 189 行只说 `"a user-selected permission mode"` 这种**通用语**，从不写具体 mode 字符串。model 在 bypass 模式下读到的 system prompt 跟 default 模式下**字面量完全一致**。mode 只在 `appState.toolPermissionContext.mode` 这个 harness-internal state 里流转，永远不进发给 model 的 messages。

**推理**：这是"安全不依赖 model 行为"原则的极端体现 —— 工业 harness 甚至连"让 model 知道当前 mode"这件事都不做。model 行为分布因此对 mode 切换是稳定的：bypass 下 model 仍然按"被 ask 时收到 is_error"的方式预期反应，audit 的诚实性不依赖 model 配合。

**v3 对应**：`SYSTEM_PROMPT` 字面量（段 7）在三种 mode 下完全一致；`mode` 仅作为 `runLoop` 的参数传到 `dispatch`，从不写入 `messages`。

---

### 推测 2：ask_user 在 bypass 下仍挂在 tools schema 里

**判定**：✅ **命中**（且工业实现比推测**更精致**）

**源码**：[excerpts.md §2](./excerpts.md) — `src/utils/permissions/permissions.ts:1230-1236`

```ts
// 1e. Tool requires user interaction even in bypass mode
if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === 'ask') {
  return toolPermissionResult
}
```

**推理**：工业实现的优雅之处 —— 不在"tools schema 注册阶段"做 mode 过滤，而是在"permission 判决阶段"用 `tool.requiresUserInteraction?.()` 钩子让每个工具**自己声明**是否 bypass-immune。AskUserQuestion / ReviewArtifact / ExitPlanMode 这类"本质就是要 user 交互的工具"声明 `requiresUserInteraction = true`，于是在 §5 的 `shouldBypassPermissions` 早返回**之前**就被拦下 —— ask 行为绕不过去。

**v3 对应**：段 1 的 `modeMatrix` 第二行 `if (tool === "ask_user") return "auto-allow"` —— 我做的简化是直接给 ask_user 放行（因为 ask_user 的 executor 本身就是 readline 询问 user，policy 层不需要再拦）。工业方案更通用：`requiresUserInteraction` 钩子可以适用于任何"必须 user 在场"的工具，扩展性强 —— 这是 v3 可以借鉴的改进点（见 §5 写回 v2 的改进意见）。

---

### 推测 3：bypass 触发有 audit 日志

**判定**：✅ **命中**

**源码**：[excerpts.md §3](./excerpts.md) — `src/hooks/toolPermission/permissionLogging.ts:178-235`

注释明说 *"Single entry point for all permission decision logging. Called by permission handlers after every approve/reject. Fans out to: analytics events, OTel telemetry, code-edit OTel counters, and toolUseContext decision storage."*

**推理**：工业 audit log 是多维度的：
- `decision`: accept / reject
- `source`: `'config'`（mode 自动允许）/ `'user_temporary'` / `'user_permanent'` / `'hook'` —— **bypass 触发的 allow 走 `source='config'`**，跟 user 临时点 y 区分开来
- `tool_name` + `messageId` + `toolUseID` —— 可追溯到具体那一轮的那个 tool_use
- `waiting_for_user_permission_ms` —— 即使是 auto-allow 也记录"是否经过了 user 等待时间"，便于事后区分

**v3 对应**：段 4 的 `audit()` 函数 + dispatch 里的 `console.error('[AUDIT] ...')`。我做的简化版只输出文本行；工业版用结构化 event + OTel telemetry，但**信息维度（mode / tool / decision / source）一致**。run-log-bypass.txt 第 50-55 行能看到 2 条 `[AUDIT] auto-allow tool=delete_file mode=bypassPermissions` 写到 stderr。

---

### 推测 4：bypass 有 hard-block 列表 / 作用域限制

**判定**：✅ **命中**（且比推测**更系统化**）

**源码**：[excerpts.md §4](./excerpts.md) — `src/utils/permissions/permissions.ts:1252-1260`

```ts
// 1g. Safety checks (e.g. .git/, .claude/, .vscode/, shell configs) are
// bypass-immune — they must prompt even in bypassPermissions mode.
```

工业 hard-block 名单包括（按代码注释）：`.git/` / `.claude/` / `.vscode/` / shell 配置文件 —— 都是 *"动一下就难恢复"* 的目录。

**推理**：这正是 Socratic 04 Q4 收紧确认的 *"hard-block 防的是 user 自己 / 双因素激活在 bypass 下的延伸"* 的工业版。注意工业实现还有**额外两条**类似免疫机制（[excerpts.md §7](./excerpts.md)）：
- **1f. content-specific ask rule**：user 之前显式配置过的 `Bash(npm publish:*)` 这种规则，bypass 也尊重
- **1d. deny rule**：deny 规则永远优先于 mode 决策

整体看，bypass 不是"全部放过"，而是"在 *N* 条免疫规则之后才放过"。这跟"sandbox 与 mode 正交"是同一思想的延伸：**防御不是单层开关，是多层条件**。

**v3 对应**：段 2 的 `HARD_BLOCK_PATHS` 列表 + `isHardBlocked` 函数 + 段 1 矩阵函数第一行 `if (isHardBlocked(...)) return "hard-block"`。run-log-bypass-hard-blocked.txt 是这条推测的实战验证：
- model 在 bypass 下试图删 `/Library/Caches/myapp-cache.bin`
- dispatch 触发 `[AUDIT] hard-block ... (bypass-immune)`
- tool_result 拼回 `is_error: true` + `"Hard-block: ... cannot be deleted even in bypass mode"`
- model 下一轮诚实汇报 + 给出 sudo rm / Finder 等替代方案

---

### 推测 5：mode 矩阵的物理承载是 dispatch + is_error，不是某个 config 表

**判定**：⚠️ **部分命中**（推测的精神对了，但实现形态需要修正）

**源码**：[excerpts.md §5](./excerpts.md) — `src/utils/permissions/permissions.ts:1262-1281`

**对的部分**：
- mode **不是查表** —— 没有任何一个 `Map<Mode, Policy>` 或 JSON 配置直接映射
- mode 字符串 `'bypassPermissions'` 由 `if (shouldBypassPermissions) return { behavior: 'allow', ... }` 这种**有序 if 早返回**的形式消费
- 决定本身是 `behavior` 字段（行为），决定的依据是 `decisionReason` 附带带出来供 audit log 使用 —— "config 是输入，policy 是行为" 1:1 对应

**需要修正的部分**：
- 我推测的 *"dispatch + is_error 二维"* 太简化了。工业实现是 *"有序 if 链 + 多维 decisionReason"*：
  - 1a/1b/1c/1d/1e/1f/1g/2a/2b/3 —— 一共 10+ 步，每步处理一种维度（deny rule / tool checkPermissions / requiresUserInteraction / content rule / safetyCheck / mode bypass / always-allowed rule / ...）
  - mode 是其中**一步**（2a），不是顶层 dispatch 入口
- `is_error: true` **不是 mode 矩阵的承载层**，它是 tool_result 拼回 messages 时的**协议反馈通道**。两层职责分开：判决在 permissions.ts，反馈在 tool_result 协议字段

**精修后的表述**：mode 矩阵的物理承载 = **有序 if 链上的某一步 + 早返回 + decisionReason 多维传出**；is_error 是这个判决传到 model 的**协议出口**。

**v3 对应**：段 4 dispatch 内的 `if (policy === "hard-block") ... if (policy === "ask") ... auto-allow ...` 是简化版的"有序 if 链"。`is_error: true` 在三个地方用：(a) hard-block 路径；(b) ask 被拒绝；(c) 未知 tool。这正确反映了 *"决定 + 反馈分两层"* 的分工。

---

## §3. mode 矩阵的物理承载结构

```
                    +---------------------------+
                    |  dispatch(name, input,    |
                    |           mode)           |
                    +---------------------------+
                                 |
                                 v
                   +-------------+--------------+
                   |  modeMatrix(tool, input,   |
                   |             mode)          |
                   |  -- 有序 if 链 --           |
                   +---+----+----+----+----+----+
                       |    |    |    |    |
                       v    v    v    v    v
                   hard  ask_   read  bypass acceptEdits
                   block user   like  any?  & edit_like
                       |    |    |    |    |
                       v    v    v    v    v
                   "hard "auto "auto"auto "auto"
                   block" allow"allow"llow"allow"
                                                  |
                                                  v
                                              ELSE: "ask"
                                                  |
                          +-----------------------+
                          |
              +-----------+-----------+
              |                       |
              v                       v
   policy === "ask"        policy === "auto-allow"
              |                       |
              v                       v
   弹 readline                 (mode !== default 且
   (y / N)                      非 read / 非 ask_user)
              |                       |
              v                       v
   y → execute             写 [AUDIT] 一行
   N → is_error: true              到 stderr
                                     |
                                     v
                            execute(name, input)
                                     |
                                     v
                            content + is_error
                                     |
                                     v
                            tool_result 拼回 messages
                                     |
                                     v
                           model 在下一轮看见 is_error
                           → 自适应（诚实汇报 / 替代方案）
```

**关键节点对照工业实现**：

- `modeMatrix` 第 1 行 `isHardBlocked` ↔ `permissions.ts:1252-1260` (1g safetyCheck)
- `modeMatrix` 第 2 行 `tool === "ask_user"` ↔ `permissions.ts:1230-1236` (1e requiresUserInteraction)
- `modeMatrix` 第 3 行 `READ_LIKE.has(tool)` ↔ 工业实现里走 `tool.checkPermissions()` 返回 allow（1c）
- `modeMatrix` 第 4 行 `mode === "bypassPermissions"` ↔ `permissions.ts:1262-1281` (2a shouldBypassPermissions)
- `modeMatrix` 第 5 行 `mode === "acceptEdits"` ↔ 类似但 mode 不同的早返回（工业版还需结合 1b autoAccept 配置）

policy → `tool_result.is_error` 的映射是**协议层**，不是 mode 矩阵的一部分。这是 v3 设计的关键认识：**policy 决定 + 反馈传递分两层职责**。

---

## §4. 推测之外的发现

### 4.1 三层 handler 工厂分离（interactive / swarm-worker / coordinator）

[excerpts.md §6](./excerpts.md)。`src/hooks/toolPermission/handlers/` 把 "**policy 怎么决定**"（统一在 `permissions.ts`）与 "**ask 怎么发生**"（不同环境不同 handler）解耦：

- `interactiveHandler.ts` (19.7K)：交互式终端，readline-style 弹询问
- `swarmWorkerHandler.ts` (5.4K)：swarm 模式下 subagent 没有自己的 UI，权限请求通过 parent agent 转发
- `coordinatorHandler.ts` (2.3K)：协调多个 swarm worker 的 mode 继承

**洞察**：v3 把"询问 user" 直接硬编码成 `prompt()` —— 在 production 系统里这是错的，因为同一套 mode 矩阵代码应该在 CLI / IDE 插件 / web UI / subagent 多种宿主下复用。**workaround = 工厂模式**：让 mode 矩阵生产 "需要 ask" 的信号，由宿主自己决定怎么"问"。

### 4.2 deny rule + content-specific ask rule 也 bypass-immune

[excerpts.md §7](./excerpts.md)。bypass 的免疫列表不止系统级 hard-block，还包括 user 在 settings.json 里自己写的 `Bash(npm publish:*)` 这种**显式配置规则**。

**洞察**：这把"hard-block 是 user 兜底"扩展为更通用的原则：**user 任何曾说过的"这要确认"都比 bypass 优先**。user 当下的 "我开了 bypass" 是临时表态，user 历史上的显式配置规则是长期意图 —— **harness 默认相信长期意图，怀疑临时表态**。

### 4.3 mode 不止 3 个

[excerpts.md §8](./excerpts.md) + sdk-tools.d.ts:337 完整枚举：

```ts
mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
```

- `plan`：plan mode，只读不写（与 ExitPlanMode 工具配合）
- `auto`：推测是介于 default 和 bypass 之间的"温和自动允许"
- `dontAsk`：可能在 swarm-worker 环境下用（subagent 不能弹 readline）

**洞察**：v3 只实现了基础 3 种 mode，但工业实现至少有 6 种 —— mode 是高度可扩展的维度。**(tool × mode) → policy** 矩阵随着 mode 维度增加而组合爆炸，但因为是 *"有序 if 链 + 早返回"* 而不是 *"M × N 查表"*，扩展新 mode 只需要加一段 if 分支，不需要重写矩阵。

---

## §5. 写回 v2 的改进意见

基于上面 4 节的对照，如果让我重做 v2，会做以下 3 处改动：

### 5.1 把 `requiresUserInteraction` 钩子搬到 v2

v2 的工具 schema 完全没有 *"是否需要 user 在场"* 这个属性 —— delete_file 必须 ask，是被 dispatch 函数硬编码的 `if (name === "delete_file")` 决定的。改进：在 tool 定义里加一个 `requiresUserInteraction` 字段（默认 false），让每个 tool 自己声明。dispatch 第一步检查这个字段，不依赖 tool 名字。

**好处**：(a) v2 升 v3 时不需要改 dispatch；(b) 加新工具时 permission 行为是工具定义的一部分，不会被遗忘；(c) ask_user / ExitPlanMode 这类"工具本质"是要 user 交互的，可以用同一个钩子统一表达。

**对应工业实现**：[excerpts.md §2](./excerpts.md)（`permissions.ts:1230-1236`）。

### 5.2 把 dispatch 的 `if name === "delete_file"` 拆成"判决 + 反馈"两层

v2 的 dispatch 现在做了两件事：决定要不要 ask（policy 判决）+ 跑 readline 询问 user（执行决定）。production 里这两层应该分开：

```ts
// 第 1 层：判决 —— 输入 (tool, input, mode)，输出 {behavior, decisionReason}
function decide(tool, input, mode): { behavior: 'allow' | 'ask' | 'deny', reason: ... }

// 第 2 层：执行决定 —— 输入 behavior，决定是真跑、问 user、还是直接拒
function executeWithDecision(decision, tool, input): { content, is_error }
```

**好处**：(a) decide 函数纯函数，可以单测；(b) 不同环境（CLI / IDE / swarm）可以共享 decide，各自实现 executeWithDecision；(c) audit log 只需要 decide 的输出就能写，不需要等 executor 跑完

**对应工业实现**：`src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseToolInner()`（纯判决）+ `src/hooks/toolPermission/handlers/*` 三层 handler（各自执行）。

### 5.3 audit log 的 source 字段多维度

v2 没有 audit 概念，v3 也只输出一行文本。改进：audit 应该是结构化事件，至少含：

```ts
{ decision, source, tool, input, mode, decisionReason, waiting_for_user_permission_ms }
```

特别是 `source` 字段：区分 `'config'`（mode 自动允许）/ `'user_temporary'`（user 当下点 y）/ `'user_permanent'`（user 之前设置的 always-allow）/ `'hard-block'` —— 这让事后审计能回答"这次为什么放过了？"

**对应工业实现**：[excerpts.md §3](./excerpts.md)（`permissionLogging.ts:181-235`）。

---

## §6. 一句话总结

5 条推测全部被工业实现验证或精修。最大的学习：

> **mode 矩阵的物理承载不是数据，是一条有序的 if 链；mode 字符串只是 if 链的输入参数；is_error 不是矩阵的一部分，是判决传到 model 的协议出口。判决与执行、决定与反馈，是两层独立职责。**

这就是 evaluate → create 的真正跨越：从"看懂别人为什么这么写"到"自己能基于同样原理写出可扩展的代码"。v3 的 196 行就是这次跨越的物理证据。
