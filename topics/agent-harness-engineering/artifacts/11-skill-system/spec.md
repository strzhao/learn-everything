# Task 11 Spec: v11 Mini Skill System

> 把"agent 能做什么"从源码解耦出来，变成可热插拔的行为包。v10 的 system prompt 是编译时写死的 6 段 section；v11 让用户丢一个 SKILL.md 文件进目录，agent 运行时就获得新行为——无需改核心代码。

## 目标

在 v10 ~900 行之上加 ~150-200 行实现 mini skill 系统。验证 4 个核心论断：

1. **Skill = 行为策略注入**——工具层不变、model 不变，变的是 system prompt 区域的指令文本 + allowed-tools 临时权限
2. **Skill 正文通过 tool_result 通道注入**——SkillTool 跟 read_file 并列，skill 内容作为 tool_result 返回，model 在对话历史中读到指令
3. **Shell 模板引擎**——SKILL.md 正文支持 `` !`command` `` 和 ` ```! ``` ` 语法，harness 加载时执行 shell 并用输出替换原文，model 只看到成品
4. **架构正交性第五次验证**——v2 permission / v6 hook / v7 obs 对 SkillTool 零修改自动生效

## 教学复杂度控制（工业砍掉项）

| 工业特性 | v11 决策 | 理由 |
|---|---|---|
| 4 层目录扫描（managed/user/project/add-dir）| 简化为 1 层：`./skills/` 相对目录 | 核心机制一样，多层只是配置问题 |
| skill_listing attachment（system-reminder 注入）| 简化为在 system prompt 末尾追加 skill 清单段 | 教学版重点是"model 能看到清单"，不在于精确注入位置 |
| 条件激活（paths 字段）| 不实现 | 属于优化，不影响核心流程 |
| fork 模式（子 agent 隔离执行）| 不实现 | inline 模式覆盖核心教学点 |
| token 预算控制（1% context window）| 不实现 | 教学版 skill 数量少不会超 |
| 运行时动态发现（discoverSkillDirsForPaths）| 不实现 | 启动扫描覆盖核心加载逻辑 |
| `${CLAUDE_SESSION_ID}` 变量 | 不实现 | `${CLAUDE_SKILL_DIR}` + `$ARGUMENTS` 足够展示机制 |
| PowerShell 路由 | 不实现 | Bash only |

## 设计要点

### §23: Skill 加载器（loadSkillsFromDir）

- 扫描 `./skills/` 目录下的 `<name>/SKILL.md` 格式（目录格式，不支持散文件）
- 解析 YAML frontmatter：`name`、`description`、`allowed-tools`
- 返回 `SkillDef[]` 数组（name + description + allowedTools + markdownContent + skillDir）
- 加载时机：agent 启动前一次性扫描

### §24: SkillTool 定义 + getPromptForCommand

- 注册为标准 tool（跟 read_file / edit_file 并列），tool schema：`{ skill: string, args?: string }`
- `execute()` 内部调用 `getPromptForCommand(skillName, args)`：
  1. 拼接 `"Base directory for this skill: <skillDir>\n\n" + markdownContent`
  2. 替换 `${CLAUDE_SKILL_DIR}` → skillDir 路径
  3. 替换 `$ARGUMENTS` → 用户传入参数
  4. 执行内嵌 shell（`` !`cmd` `` 和 ` ```!\ncmd\n``` `）——每个命令过 permission gate 后执行，输出替换原文
  5. 返回处理后的文本作为 tool_result
- **`allowed-tools` 临时权限注入**：执行期间把 skill 声明的工具加入 `alwaysAllowTools` 临时集合；执行结束后恢复

### §25: Skill 清单注入（skill listing）

- agent 启动时，把所有已加载 skill 的 `name: description` 格式化为一段文本
- 注入方式：在 v10 `assembleSystemPrompt` 返回的 suffix 末尾追加一段 `"\n\n[Available Skills]\n- name: description\n- ..."`
- 目的：让 model 在 system prompt 中看到可用 skill 清单，知道什么时候可以调用 SkillTool

### §26: Shell 模板引擎（executeShellInSkill）

- 两种语法正则：
  - Block: ` ```!\n<command>\n``` ` → `BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g`
  - Inline: `` !`command` `` → `INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm`
- 对每个匹配：先过 permission gate（`modeMatrix("bash", ...) === "auto-allow"` 或在 allowed-tools 白名单中）→ 执行 → 用 stdout 替换原文
- 多个命令 `Promise.all` 并发执行
- 安全边界：如果 skill 来源标记为 "untrusted"（预留 MCP skill 场景），跳过所有 shell 执行

## 交付清单

| 文件 | 内容 |
|---|---|
| `agent-v11-skill-system.ts` | ~1100 行（v10 900 + §23/§24/§25/§26 共 ~200 行）|
| `skills/greeter/SKILL.md` | 简单测试 skill：无 shell，无 allowed-tools，纯指令注入 |
| `skills/git-summary/SKILL.md` | 带 shell 的 skill：`` !`git log --oneline -3` `` + `allowed-tools: Bash(git:*)` |
| `run-log-greeter.txt` | model 调用 SkillTool("greeter") → tool_result 注入 → 行为改变 |
| `run-log-git-summary.txt` | shell 执行 + allowed-tools 临时提升 + permission gate 验证 |
| `notes.md` | 实现笔记（工业对照 + 砍掉项说明）|
| `excerpts.md` | claude-code 源码引用（loadSkillsDir.ts / promptShellExecution.ts / SkillTool.ts / messages.ts）|
| `lesson.md` | 教学叙事（遵循 lesson.md 叙事规范 8 条规则）|
| `README.md` | 三段式 |

## 核心论断工业对照

| # | 论断 | 工业源码位置 | run-log 验证方式 |
|---|---|---|---|
| 1 | skill 正文通过 tool_result 注入 | `loadSkillsDir.ts:398` 返回 `[{ type: 'text', text: finalContent }]` | run-log 中 SkillTool tool_result 包含完整 skill 正文 |
| 2 | shell 模板执行 + 输出替换 | `promptShellExecution.ts:92-140` Promise.all + replace | run-log-git-summary 中 tool_result 包含 git log 真实输出（不是 `` !`git log` `` 原文）|
| 3 | allowed-tools 临时权限覆盖 | `loadSkillsDir.ts:383-388` alwaysAllowRules merge | run-log-git-summary 中 skill 执行期 Bash(git:*) 无需确认 / 执行结束后恢复 |
| 4 | 架构正交性 | SkillTool 走 dispatch 同路径 | OBS METRIC `tool_name=Skill` + PreToolUse/PostToolUse hook 触发 + permission gate 判决 |

## 示例 Skills

### skills/greeter/SKILL.md

```yaml
---
name: greeter
description: 让 agent 用热情的方式打招呼，每次回复开头加一句问候
---

当用户跟你说话时，请在回复的最开头加上一句热情的中文问候语（如"嘿！很高兴见到你！"）。
问候语要每次不同，不要重复。问候之后再正常回答用户的问题。
```

### skills/git-summary/SKILL.md

```yaml
---
name: git-summary
description: 提供当前 Git 仓库状态摘要，在回复中包含分支和最近提交信息
allowed-tools: Bash(git:*)
---

Base directory for this skill: ${CLAUDE_SKILL_DIR}

当前仓库状态：
- 分支：!`git branch --show-current`
- 最近 3 次提交：

```!
git log --oneline -3
```

请在回答用户问题时，先简要提及当前仓库状态（分支名 + 最近活动），然后再正常回答。
如果用户问的内容跟 Git 无关，只需在开头用一行小字提及分支名即可。
```

## v10 改造点（最小侵入）

| v10 位置 | 改动 | 行数 |
|---|---|---|
| §3 TOOLS 数组 | 追加 SkillTool 定义 | +15 |
| §5 dispatch | 加 `case "skill":` 分支调用 getPromptForCommand | +5 |
| §21 assembleSystemPrompt | suffix 末尾追加 skill listing | +8 |
| 新增 §23-§26 | 加载器 + SkillTool execute + listing + shell 引擎 | +170 |
| **总计** | | **~200 行新增** |

## 验收标准

1. `bun run agent-v11-skill-system.ts` 能跑通，model 在无 skill 时正常工作
2. greeter skill 加载后，model 回复开头出现问候语（行为改变的直接证据）
3. git-summary skill 加载后，tool_result 中 `` !`git log` `` 已被替换为真实 git 输出
4. git-summary 执行期间 Bash(git:*) 不弹权限确认；执行结束后 Bash("rm -rf /") 仍被 permission gate 拦截
5. OBS METRIC 输出包含 `tool_name=Skill`；hook 输出包含 PreToolUse/PostToolUse event=Skill
6. v10 §1-22 核心逻辑不动（除上述 3 处最小改造点）
