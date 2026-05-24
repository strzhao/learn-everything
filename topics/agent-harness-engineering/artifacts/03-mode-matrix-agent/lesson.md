# Task 03：mode matrix agent —— 把 5 条推测物理化

> Task 02 v2 只解决了"该不该 ask"的二分判决，但真实 production harness 面对的是 (tool × mode) → policy 的多维矩阵。这次我们把 Task 02 的 5 条 `bypassPermissions` 推测、对照 claude-code 源码验证、并落到 196 行可运行代码上。看完你应该能说清三件事：(1) mode 矩阵的物理承载到底是什么；(2) 为什么 hard-block 防的不是 model 也不是 injection 而是 user 自己；(3) "判决"和"反馈"为什么必须分两层职责。

## 是什么

Task 02 v2 实现了"单层 harness gate"：每个破坏性 tool 都弹 readline。但 production 用户不可能为每个文件确认 —— 长会话、批量操作、CI 场景都需要 *"放手让 model 干"* 的模式。同时又不能完全放手：rm -rf / 这种动作即使 user 主动开 bypass 也得拦住。

v3 用 3 种 mode 表达这个张力：

- **default**：每个 destructive tool 都 ask（≈ v2 行为）
- **acceptEdits**：edit_file 自动通过、delete_file 仍 ask —— 体现矩阵的"按 tool 分类"
- **bypassPermissions**：所有 tool 直接放行，**但** hard-block 列表里的 path 永远拒

3 种 mode 共享同一个 system prompt（**model 不知道自己在哪个 mode**），同一份 tools schema（**ask_user 永远在**），只在 dispatch 内部的一个矩阵函数里分化行为。

## §1. Mode 枚举与 mode 矩阵

mode 是 **string union**（参考 claude-code `sdk-tools.d.ts:337`，工业实现也是字符串）。policy 不是 config 表里的数据，**它是 modeMatrix 函数读 mode + tool 后做的 runtime 决策**。这就是 Socratic 04 Q2 收紧确认的："config 是行为的输入，dispatch 是行为本身"。

@include(./agent-v3-mode-matrix.ts, section=1)

注意 5 条 if 的**顺序**：hard-block 优先于一切（与 mode 正交）→ ask_user 永远放行（推测 2 的体现）→ read 类工具永远安全 → bypass 放过其余 → acceptEdits 放过 edit → default 兜底 ask。这是一个**有序 if 链**而不是 M×N 查表 —— 后面对照源码时会看到工业 `hasPermissionsToUseToolInner` 用的就是同样形态。

## §2. Hard-block 列表（user 兜底，跟 mode 正交）

这是 Socratic 04 Q4 收紧确认的核心抽象在代码里的体现 —— **hard-block 防的不是 model 不是 prompt injection，是 user 自己**。user 在 bypass 模式下开了"万能开关"，但人脑容易把"放手 bypass" 跟 "放心删 /" 混淆，所以 harness 必须替 user 兜底极端路径。

@include(./agent-v3-mode-matrix.ts, section=2)

`HARD_BLOCK_PATHS` 是个静态列表（mock 简化版）。工业实现见 claude-code 源码 `src/utils/permissions/permissions.ts:1252-1260` 的 `safetyCheck`：

```ts
// 1g. Safety checks (e.g. .git/, .claude/, .vscode/, shell configs) are
// bypass-immune — they must prompt even in bypassPermissions mode.
if (
  toolPermissionResult?.behavior === 'ask' &&
  toolPermissionResult.decisionReason?.type === 'safetyCheck'
) {
  return toolPermissionResult
}
```

注意工业实现是 `return` 一个 *"ask"* 行为 —— bypass 仍然弹询问而不是直接拒绝，让 user 当下显式确认。v3 简化成直接 `is_error`，但思想一致：**bypass 越不过 hard-block**。

## §3. Tools schema（含 ask_user，三种 mode 下不变）

推测 2 的代码体现 —— `ask_user` 永远挂在 tools schema 里。bypass 不删它、不在 system prompt 里告诉 model "你现在不用 ask_user 了"。**保留 model 的"主动澄清"通道**：即使 bypass 让自动执行更快，model 仍然可以在不确定时主动询问 user 意图。

@include(./agent-v3-mode-matrix.ts, section=3)

对照 claude-code `permissions.ts:1230-1236` 的更通用做法：工业实现不在 schema 层做 mode 过滤，而是在判决层用 `tool.requiresUserInteraction?.()` 钩子让**每个工具自己声明**是否 bypass-immune。AskUserQuestion / ReviewArtifact / ExitPlanMode 都返回 true，于是 bypass 早返回**之前**就被 ask 兜住。

这是 v3 可以借鉴的扩展点：现在硬编码 `tool === "ask_user"`，未来加新的"需要 user 在场"工具时（比如 git_commit）只需要在 tool 定义里加一个字段，dispatch 不用改。

## §4. Dispatch 是矩阵的物理化

这是 v3 最核心的段。3 个 policy 分支：hard-block 立刻 audit + is_error；ask 弹 readline；auto-allow 在非 default mode 下写 audit。

@include(./agent-v3-mode-matrix.ts, section=4)

**关键设计**：

- **audit 行打到 stderr**（`console.error`）—— 跟 stdout 的 JSON dump 隔离。这样 run-log 文件里 audit 和 model 输出物理可区分。
- **mode !== "default" 且非 read/ask_user 才打 audit** —— default 下 auto-allow 是基础行为（read 总是安全），不审计；bypass / acceptEdits 下任何非 read 的 auto-allow 都审计。
- **is_error 是协议反馈通道**，不是矩阵的一部分 —— 矩阵决定 policy，is_error 把 policy 的"拒绝"传到 model。

对照工业 `permissions.ts:1262-1281`：

```ts
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' || ...
if (shouldBypassPermissions) {
  return {
    behavior: 'allow',
    updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
    decisionReason: { type: 'mode', mode: appState.toolPermissionContext.mode },
  }
}
```

工业版返回的不只是 allow，还附带 `decisionReason: {type: 'mode', mode: ...}` —— 决定**是行为**（behavior 字段），决定的依据**是数据**（decisionReason 字段），两层分开传给下游 audit log 使用。这是推测 5 在工业实现里的精确形态。

## §5. default mode：destructive 一律 ask

User prompt：`请删除 /tmp/test1.txt 和 /tmp/test2.txt 两个文件。`

User 输入：第一个删除答 `N`（拒绝），第二个答 `y`（允许）。

@include(./run-log-default.txt, round=1)

注意 Round 1 model 先调了**两次 read_file**（检查文件存在）—— deepseek 训练分布的稳健行为。read_file 在所有 mode 下都 auto-allow，所以没有 readline 也没有 audit，dispatch 直接 mock 返回。

@include(./run-log-default.txt, round=2)

Round 2 model 调 2 个 delete_file。dispatch 对每个都弹 readline：第一个 user 答 N → `is_error: true`，第二个 user 答 y → mock 删除成功。看 tool_result 里的 is_error 字段是怎么写的，这是协议层的关键信号。

@include(./run-log-default.txt, round=3)

Round 3 model 看到 is_error 后**自适应**：用 ✅ / ❌ 区分两个文件的命运，主动建议 *"如果您仍然需要删除它，请确认后我再尝试"*。**harness 没在 system prompt 里教 model 怎么处理 is_error，model 凭训练分布自然处理** —— 跟 Task 02 v2 观察到的现象完全一致。

## §6. acceptEdits mode：矩阵性体现

User prompt：`请把 /tmp/foo.txt 的内容改成 "updated"，然后删除 /tmp/old.txt 这个旧文件。`

User 输入：delete_file 弹 readline 时答 `y`。

@include(./run-log-accept-edits.txt, round=2)

Round 2 是关键 —— model 同时调 edit_file 和 delete_file：

- **edit_file**：dispatch 判定 `auto-allow`（acceptEdits 模式 + edit_like），写 audit 行 `[AUDIT] auto-allow tool=edit_file mode=acceptEdits input=/tmp/foo.txt`，直接 mock 写入
- **delete_file**：dispatch 判定 `ask`（不在 EDIT_LIKE 集合里），弹 readline

这就是 *"(tool × mode) → policy"* **矩阵性的物理体现**：同一个 mode 下，不同 tool 走不同分支；同一个 tool 在不同 mode 下走不同分支。policy 不是 mode 的属性、也不是 tool 的属性，是 (tool × mode) 这个**二元组**的属性。

## §7. bypassPermissions mode：audit 必须可见

User prompt：`请删除 /tmp/test1.txt 和 /tmp/test2.txt 两个文件。`（同 §5）

@include(./run-log-bypass.txt, round=2)

Round 2 model 调 2 个 delete_file，dispatch 完全没弹 readline，直接：

- `[AUDIT] auto-allow tool=delete_file mode=bypassPermissions input=/tmp/test1.txt`
- `[MOCK] would rm -rf /tmp/test1.txt`
- `[AUDIT] auto-allow tool=delete_file mode=bypassPermissions input=/tmp/test2.txt`
- `[MOCK] would rm -rf /tmp/test2.txt`

**audit 是 bypass 的灵魂**。没有 audit，bypass 就是不可观测的黑洞 —— 事后无法追溯 "model 在 bypass 下到底删了什么"，违反 production 原则（推测 3）。工业实现把 audit 做成多维度结构化事件（`source` / `decisionReason` / `waiting_for_user_permission_ms`），写到 OTel telemetry —— v3 简化成一行文本，但维度一致。

## §8. bypass + hard-block：5 条推测的实战汇合

User prompt：`我在清理系统，请删除这两个无用文件：/tmp/old1.log 和 /Library/Caches/myapp-cache.bin。两个都已确认无用，直接删除。`

这个 prompt 故意设计成 *"看起来无害"* —— `/Library/Caches/MyApp/junk.tmp` 是个真实存在的 cache 文件类型，model 不会过度警觉。但 `/Library/...` 在 hard-block 列表里。

@include(./run-log-bypass-hard-blocked.txt, round=1)

Round 1 model 直接调 2 个 delete_file，dispatch 分化：

- **第一个 `/tmp/old1.log`**：bypass + 非 hard-block path → `[AUDIT] auto-allow ...` + mock 删除
- **第二个 `/Library/Caches/...`**：hard-block 优先 → `[AUDIT] hard-block ... mode=bypassPermissions (bypass-immune)` + 返回 `is_error: true` + `"Hard-block: ... cannot be deleted even in bypass mode"`

注意 audit 行里特意带了 `(bypass-immune)` 标记 —— 事后审计就能区分 "bypass 自动放过" 和 "bypass 都拦不住"。

@include(./run-log-bypass-hard-blocked.txt, round=2)

Round 2 model 看到 is_error 后**完美自适应**（甚至比 Task 02 v2 的样本更完整）：

- 第一行 ✅ 直接说 `/tmp/old1.log` 已删除
- 第二行 ❌ 说 `/Library/Caches/...` 被系统保护路径限制
- **主动给出替代方案**：手动通过 Finder 删除 / `sudo rm` 在终端中删除

**关键观察**：harness 没有在 system prompt 里教 model "如果遇到 hard-block 怎么办"。model 只是看到 `is_error: true` 和 content `"Hard-block: ... even in bypass mode"`，凭训练分布**自然**输出了 "诚实汇报 + 替代建议"。这正是 Task 02 v2 *"harness 的 NO 给 model 一个明确锚点"* 在新场景下的再次验证 —— **safety 不依赖 model 行为，但 model 的协作能力是 bonus**。

## §9. 5 条推测对照工业实现（小结）

- **推测 1 ✅ 命中** — `src/constants/prompts.ts:189` system prompt 只说 *"a user-selected permission mode"*，不写任何具体 mode 字符串，model 字面量无感
- **推测 2 ✅ 命中** —`permissions.ts:1230-1236` 用 `tool.requiresUserInteraction?.()` 钩子让 AskUserQuestion 类工具 bypass-immune，比 v3 硬编码更通用
- **推测 3 ✅ 命中** — `permissionLogging.ts:181` 是 *"Single entry point for all permission decision logging"*，多维度结构化事件（decision / source / tool / decisionReason / waiting_ms）
- **推测 4 ✅ 命中** — `permissions.ts:1252-1260` safetyCheck 路径 bypass-immune，且工业实现额外有 deny rule / content-specific ask rule 两条免疫机制
- **推测 5 ⚠️ 部分命中** — mode 字符串确实是数据（`appState.toolPermissionContext.mode`），但 policy 是有序 if 链 + 早返回 + 多维 `decisionReason`，不是 *"dispatch + is_error 二维"* 这么扁平。是 *"10+ 步有序 if 链"*，mode 是其中一步

完整对照与推理见 [notes.md §2](./notes.md)。

## §10. 写回 v2 的 3 处改进意见

基于 5 条推测的对照，如果重做 v2 会改这 3 处：

- **把 `requiresUserInteraction` 钩子搬到 v2**：tool 定义里加一个字段（默认 false），让每个工具自己声明是否需要 user 在场。dispatch 第一步检查它，不再依赖 tool 名字硬编码
- **dispatch 拆成"判决 + 执行"两层**：`decide()` 纯函数输出 `{behavior, decisionReason}`，`executeWithDecision()` 根据 behavior 真跑/问 user/拒绝。好处：decide 可单测、不同环境（CLI/IDE/swarm）共享 decide、audit 只需 decide 输出
- **audit log 升级为结构化事件**：不只输出文本，而是带 `{decision, source, tool, input, mode, decisionReason, waiting_ms}` 多字段。特别是 `source` 字段区分 `'config'` / `'user_temporary'` / `'user_permanent'` / `'hard-block'`

完整改进意见与对应工业实现见 [notes.md §5](./notes.md)。

## §11. 全周期 messages dump（供深入研读）

如果你想看完整的 messages 数组（包括所有 assistant 回复 + 所有 tool_result 拼回），可以展开 FINAL MESSAGES：

### default mode 全周期

@include(./run-log-default.txt, section="FINAL MESSAGES")

### bypass + hard-block 全周期

@include(./run-log-bypass-hard-blocked.txt, section="FINAL MESSAGES")

注意每一轮 `assistant` content 里的 `thinking` block —— model 的内部推理被显式记录在 messages 里，下一轮 dispatch 可以"看见"上一轮 model 的思考过程。这是 production harness 用 extended thinking 协议的一面：harness 不只能调 tool，还能观察 model 的 reasoning chain，为 audit / debug / training data 收集提供原始信号。

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。如果 bloom_level 升到 create，下一步是 **Lecture 04**（context compaction 或 multi-agent coordinator 二选一）。
