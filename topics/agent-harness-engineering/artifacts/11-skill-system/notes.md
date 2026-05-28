# notes.md — v11 实现笔记 + 工业对照 + 砍掉项说明

## §1 — 改动统计

v10 → v11 的最小侵入：

| v10 位置 | 改动 | 实际行数 |
|---|---|---|
| 顶部注释 | v11 标头 + 5 论断 + 工业引用列表 | 8 行 |
| §3 BASE_TOOLS 之后 | 新增 `SKILL_TOOL` 定义 | 11 行 |
| §3 `getToolsForRole` | interactive + coordinator 加入 SKILL_TOOL（swarm-worker 不加） | 1 行修改 |
| §5 `execute()` MCP 分支之前 | 新增 `if (name === "Skill") return executeSkillTool(...)` | 5 行 |
| §10 `runInteractive` + `runCoordinator` | 新增 `buildInitialUserContent` helper + 改 messages 初始化 | 10 行 |
| §22 启动入口 | 新增 `loadSkillsFromDir(skillsDir)` 调用 | 4 行 |
| **新增 §23-§26** | 加载器 + SkillTool execute + listing + shell 引擎 | **~165 行** |

总计：~200 行新增（含注释），v10 §1-22 核心字面不动（§21 `assembleSystemPrompt` 一字未改 —— skill_listing **不进** system prompt）。

## §2 — 工业 vs v11 教学版决策对照表

| 维度 | claude-code 工业版 | v11 教学版 | 砍掉理由 |
|---|---|---|---|
| 目录扫描层数 | 4 层（managed/user/project/--add-dir）+ legacy `commands/` 子目录 | 1 层 `./skills/<name>/` | 核心机制一样，多层只是配置 |
| YAML 解析 | `gray-matter` + `js-yaml` | 手写正则 | 教学版限定 4 个字段 |
| 条件激活（paths） | `paths: [src/**]` 字段触发条件加载 | 不实现 | 全 unconditional |
| 文件 id dedup | `realpath` 拿 fileId 在 Set 里查重 | 不做 | 单目录无重复 |
| skill_listing 注入 | `getSkillListingAttachments` → wrapInSystemReminder（per-turn delta-dedup via `sentSkillNames` Set） | 首轮一次 prepend 不做 delta | 短会话教学场景看不到 dedup 价值 |
| inline 通道 | `newMessages: [createUserMessage({content, isMeta: true})]` + `contextModifier` | `tool_result.content` | 都是 user-role content，本质相同 |
| fork 隔离 | `runAgent` + `prepareForkedCommandContext` + `general-purpose` agent baseline | 复用 `spawn_swarm` → `runSwarm` | 同精神不同物理路径 |
| 两层 alwaysAllow merge | 第一次 shell 期间（loadSkillsDir.ts:379-388）+ 第二次给子 agent（forkedAgent.ts:147-171） | 只做第一次 | fork 后的 worker 拿到成品，不需要再 propagate |
| `${CLAUDE_SESSION_ID}` 替换 | 实现（每个 session 唯一 UUID） | 不实现 | 教学版无 session 概念 |
| MCP skill 安全边界 | `loadedFrom !== 'mcp'` 才跑 shell（loadSkillsDir.ts:371-374） | 不区分（暂未加 MCP skill source） | 但 lesson + notes 明确说明 |
| PowerShell 路由 | `frontmatter.shell === 'powershell'` 走 PowerShellTool | bash only | 同 promptShellExecution.ts:80-83 simplification |
| INLINE_PATTERN lookbehind | `(?<=^|\s)` 防 markdown 内联 `foo\`!\`bar` 误匹配 | 同实现 | 教学版坑：中文冒号"："不被 lookbehind 接受，SKILL.md 里 `分支：` 后必须空格 |

## §3 — 两层 alwaysAllow merge 的工业精确路径

v11 教学版只做第一层（shell 模板期间），这是合理简化但隐藏了一个工业必备的设计——fork 进去的子 agent 后续可能调 Bash tool，那时需要继承 skill 声明的 `allowed-tools`。工业的两层架构：

**第一层 — `loadSkillsDir.ts:374-396` `getPromptForCommand` 内部**：
```ts
finalContent = await executeShellCommandsInPrompt(
  finalContent,
  {
    ...toolUseContext,
    getAppState() {  // 包装一层
      const appState = toolUseContext.getAppState()
      return {
        ...appState,
        toolPermissionContext: {
          ...appState.toolPermissionContext,
          alwaysAllowRules: {
            ...appState.toolPermissionContext.alwaysAllowRules,
            command: allowedTools,  // ← 第一层 merge
          },
        },
      }
    },
  },
  `/${skillName}`,
  shell,
)
```
**scope**：只在这次 `executeShellCommandsInPrompt` 调用期间生效——shell 跑完返回上层就消失。

**第二层 — `forkedAgent.ts:147-171` `createGetAppStateWithAllowedTools`**：
```ts
export function createGetAppStateWithAllowedTools(
  baseGetAppState: ToolUseContext['getAppState'],
  allowedTools: string[],
): ToolUseContext['getAppState'] {
  if (allowedTools.length === 0) return baseGetAppState
  return () => {
    const appState = baseGetAppState()
    return {
      ...appState,
      toolPermissionContext: {
        ...appState.toolPermissionContext,
        alwaysAllowRules: {
          ...appState.toolPermissionContext.alwaysAllowRules,
          command: [
            ...new Set([
              ...(appState.toolPermissionContext.alwaysAllowRules.command || []),
              ...allowedTools,  // ← 第二层 merge
            ]),
          ],
        },
      },
    }
  }
}
```
**scope**：作为整个 fork 出去的 sub-agent 的 `getAppState` —— sub-agent 后续每次调 Bash 都看得到这个临时允许。

为什么 v11 教学版可以砍掉第二层？因为我们的 swarm-worker 在 `getToolsForRole("swarm-worker")` 里**完全没有 Bash tool**（也没有 MCP tool 之外的工具），worker 根本没有"后续调 Bash"的场景。一旦你给 worker 加上 Bash tool，第二层就必须补回来。

## §4 — `Base directory for this skill:` 双重前缀踩坑

第一轮 git-summary 跑出来 worker 看到的 task 字符串以 `Base directory for this skill: ...\n\nBase directory for this skill: ...` 开头——同一行重复了两次。

根因：
- `getPromptForCommand` 内部硬编码加 `Base directory for this skill: ${baseDir}\n\n${markdown}`（对照工业 `loadSkillsDir.ts:344-348`）
- 我抄 spec.md 示例时在 `git-summary/SKILL.md` 正文里也写了 `Base directory for this skill: ${CLAUDE_SKILL_DIR}`
- `${CLAUDE_SKILL_DIR}` 被替换成 absolute path 后跟代码加的前缀重复

修复：从 git-summary/SKILL.md 删掉正文里那行。**工业 SKILL.md 文件本身不写 `Base directory` 那行**——它是 `getPromptForCommand` 注入的，作者写了反而冗余。

教训：跟 v8 的"langbase token 过期"踩坑一样，run 一遍才知道。

## §5 — INLINE_PATTERN 与中文 punctuation

`/(?<=^|\s)!\`([^\`]+)\`/gm` —— `(?<=^|\s)` 要求 `!` 之前是 whitespace 或行首。中文标点（"："、"，"、"、"）不在 `\s` 字符类里，所以：

❌ 不匹配：`分支：!`git branch``  （中文冒号紧贴）
✅ 匹配：`分支： !`git branch`` （冒号后加 ASCII 空格）

工业为什么用 lookbehind 而不是更宽容的 boundary？`promptShellExecution.ts:53-55` 注释解释：防止 markdown inline code 拼接误匹配 `` `foo`!`bar` `` —— 这种紧邻的 backtick 跟 inline shell `!` 字面长得一样。

教学版的解决方案有 3 个，我们选最简单的（让 SKILL.md 作者多打一个空格）：

| 方案 | 改动位置 | 代价 |
|---|---|---|
| A. SKILL.md 加空格 `分支： !` | 数据层 | skill 作者要记规则 |
| B. 放宽 lookbehind `(?<=^\|[\s:：，。、])` | 引擎层 | 可能误匹配 markdown 中的 `foo:！`bar` 之类边角 case |
| C. 完全去掉 lookbehind | 引擎层 | 引入 `foo\`!\`bar` 误匹配的可能 |

工业用方案 B 是个值得考虑的改进 PR——可能 claude-code 自己也没遇到过中文 skill 作者。

## §6 — fork 复用 spawn_swarm 的精神同构

`spawn_swarm` (v4) 和工业 `SkillTool fork` 是同精神不同物理实现：

| 维度 | spawn_swarm (v4) | 工业 SkillTool fork |
|---|---|---|
| 启动方式 | model 主动调 `spawn_swarm(task=...)` | 加载 SKILL.md 时声明 `context: fork` 自动选择 |
| 子 agent 类型 | `swarm-worker` role | `general-purpose` agent（`baseAgent` 默认值，可被 frontmatter `agent: <type>` 覆盖） |
| 子 agent 工具 | `getToolsForRole("swarm-worker")` 限定 BASE_TOOLS + MCP | 工具继承自父 + skill 的 `allowed-tools` merge |
| 输入格式 | `task: string` | `promptMessages: [createUserMessage({content: skillContent})]` |
| 返回值 | `runSwarm` 末尾提取最后一条 assistant text | `extractResultText(agentMessages)` 取最后一条 assistant text |
| 隔离强度 | 完全独立 context（messages 数组不共享） | 完全独立 context + 独立 readFileState + 独立 abortController |

v11 让 `SkillTool execute` 在 `context: fork` 分支直接调 `spawnFn(content, mode)`——一行代码复用整个 v4 swarm pipeline。这跟工业的"调用 `runAgent` 跑独立 sub-agent"是同构。

## §7 — `<system-reminder>` tag 的语义价值

为什么不直接 `[Available Skills]\n- ...` 不加 reminder 包装？因为 reminder tag 是 claude-code 全系统的**统一约定**——hook 通知 / plan mode 提示 / 文件读取 reminder / diagnostics 警告全都用 `<system-reminder>...</system-reminder>` 包装，model 训练时见过大量这种模式，知道"这不是用户说的，是 harness 告诉我的系统状态/提示"。

跟 `<user>...</user>` vs `<assistant>...</assistant>` 的 role 标签同精神——结构化标记让 model 区分语义来源。教学版用同样的字面标签是为了让学生看 messages 流时知道哪些是 reminder。

## §8 — 第五次架构正交性验证的物理证据

v11 完成后，5 个 sub-system 在 SkillTool 这个新加 tool 上"零修改自动覆盖"：

| 子系统 | v11 对它的改动 | 自动覆盖证据 |
|---|---|---|
| §1-§3 mode matrix + permission | 0 行 | `auto-allow tool=Skill mode=bypassPermissions` |
| §5 dispatch + hook emit | +5 行（只是加 SkillTool 分支） | PreToolUse/PostToolUse 自动触发 |
| §6-§7 compact | 0 行 | maybeCompact 在含 Skill tool_result 的 messages 上正常工作 |
| §11-§13 hook system | 0 行 | obs hooks 自动收到 Skill 的 PreToolUse/PostToolUse event |
| §14-§15 streaming | 0 行 | StreamingToolExecutor 把 Skill 当普通 tool enqueue（未在 run-log 中演示但代码路径走通） |
| §16-§18 MCP | 0 行 | SkillTool 与 MCP tool 在 dispatch 中没有交叉分支 |
| §19-§21 system prompt | 0 行 | 5 段 prompt 不知道 SKILL.md 存在；skill_listing 走另一条 attachment 通道 |

`run-log-git-summary.txt` 的 OBS METRIC dump 是第五次验证的字面证据：

```
harness.PreToolUse{event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=Skill} = 1
harness.PostToolUse{event=PostToolUse,is_error=false,mode=bypassPermissions,role=interactive,tool_name=Skill} = 1
```

v7 obs 系统（task 07）完全不知道 v11 会加 Skill tool，但它给 Skill 自动打了完整 cardinality 标签——mode + role + tool_name + event + is_error 五维全齐。**这就是"架构正交性"的物理含义：新组件接入老 sub-system，老 sub-system 一行代码不改，新组件自动获得 sub-system 的全部能力。**
