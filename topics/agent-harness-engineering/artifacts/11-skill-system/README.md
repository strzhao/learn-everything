# v11: Mini Skill System

## 它做什么

让 agent 的"行为策略"从源码里解耦出来——你想给 agent 加一个新能力（比如"每次回复前打招呼""自动总结 git 状态"），不需要改任何代码：写一个 `skills/<name>/SKILL.md` 文件，重启 agent，新行为就生效。

类比 VSCode extension：你装一个新插件，VSCode 内核不改一行代码，但插件出现在命令面板里、按需激活、有自己的权限声明。SKILL.md 是同样的"声明式行为插件包"。

## 怎么用

```bash
# 启动 agent（启动时自动扫 ./skills/ 加载所有 SKILL.md）
bun run agent-v11-skill-system.ts --role=interactive --mode=bypassPermissions \
  --prompt="你好啦，今天过得怎么样？"

# 启动 + obs hook 看架构正交性
bun run agent-v11-skill-system.ts --role=interactive --mode=bypassPermissions \
  --hooks=obs --prompt="帮我总结今天这个仓库发生了什么变化"
```

写一个新 skill：在 `skills/<name>/SKILL.md` 里加 YAML frontmatter + markdown 正文：

```markdown
---
name: my-skill
description: 描述给 model 看的，决定 model 何时调用本 skill
context: inline       # 或 fork（独立 worker 跑）
allowed-tools: [Bash(git:*)]  # shell 模板允许的命令前缀
---

skill 正文。可以含 ${CLAUDE_SKILL_DIR} 引用 skill 自己的目录。
可以含 !`echo hello` 单行 shell 模板，或者多行块：
```!
date +%Y-%m-%d
```

请在回答用户时遵循以上指令。
```

## 与其他组件的关系

v11 是 mini harness 7 大子系统的最后一块。它**对前 6 个子系统字面零修改**——这是"架构正交性"第五次验证：

- **§1-§3 mode matrix + permission**（task 02/03）：SkillTool 走标准 `dispatch → modeMatrix("Skill", ...) → auto-allow` 路径
- **§5 dispatch + hook emit**（task 06）：PreToolUse/PostToolUse 自动覆盖 Skill 工具
- **§6-§7 compact**（task 05）：含 Skill tool_result 的 messages 走 microCompact/fullCompact 路径
- **§11-§13 observability**（task 07）：OBS METRIC 自动给 Skill tool 打 `tool_name=Skill` cardinality 标签
- **§14-§15 streaming**（task 08）：StreamingToolExecutor 把 Skill 当普通 tool enqueue
- **§16-§18 MCP**（task 09）：与 MCP tool 在 dispatch 中无交叉分支
- **§19-§21 system prompt**（task 10）：5 段 prompt 不知道 SKILL.md 存在；skill_listing 走另一条 attachment 通道注入 user message 流

下一站是 **final 拼装**——把 11 个 artifact 编织成完整可运行的 mini agent harness，作为整个 `agent-harness-engineering` topic 的毕业证。final/README.md 会通过相对路径 `../artifacts/<NN-name>/` 引用全部 11 个组件。

## 教学要点

详见 lesson.md（认知流叙事 + 5 论断 + 2 份 run-log 字面证据）和 notes.md（工业对照 + 砍掉项说明 + 踩坑记录）。

5 条核心论断 recap：

1. **skill = 行为策略注入** —— 工具/model/pipeline 不变，行为可改
2. **skill 正文走 user-role text 通道** —— inline 模式 ≈ 工业 `isMeta: true` user message
3. **skill_listing 走 attachment `<system-reminder>`** —— dynamic 内容不锁死在 cacheable system prompt
4. **shell 加载期 vs 运行期正交** —— shell 永远在主 agent 跑 / fork 只隔离运行期
5. **架构正交性第五次验证** —— 5 个 sub-system 对 SkillTool 字面 0 修改自动覆盖
