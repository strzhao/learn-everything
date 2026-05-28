# v11: Mini Skill System

> ~165 行新增代码让 agent 的行为从源码里"解耦"出来——丢一个 SKILL.md 文件到 `./skills/<name>/` 目录，重启 agent，新行为就生效。v10 的 6 个子系统全部字面不动，只是多了一个 Skill tool、一个 system-reminder 注入点和一个 shell 模板引擎。

## 是什么

v10 收官时，我们已经有了**完整的 system prompt 子系统**——6 段注册、按变化频率 memoize、cache 边界切分。但 v10 的 system prompt 仍然是**在源码里写死的**：要想让 agent 多一句"每次回复前问候用户"的行为，你得去 `core_instruction` 那段 hardcode 加一行字符串，然后重启。

v11 的解法：让"行为策略"变成**运行时可热插拔的文件包**。你写一个 `skills/greeter/SKILL.md`，里面用 markdown 描述想要的行为；harness 启动时扫这个目录，把每个 skill 都注册成一个可调用的 Skill 工具。model 在每轮看到一段叫 `[Available Skills]` 的清单（这是 `<system-reminder>` 注入到 user message 流的，**不是** system prompt 的一部分），它发现某个 skill 跟当前任务匹配时**自主**调用 `Skill(skill="greeter")`，拿到 SKILL.md 的正文当作指令，遵循它接续工作。

这就是 v11 的**单一目标**：把"agent 能做什么"的边界从源码移到一个目录里。

## 跨领域类比：VSCode extension

VSCode 启动时扫描 `~/.vscode/extensions/<id>/`，每个 extension 文件夹里有 `package.json`（声明：name / activationEvents / contributes / permissions）和代码体。你装一个新插件，重启 VSCode，它就出现在 ctrl+shift+P 命令面板里——VSCode 内核没改一行代码。

v11 同结构：

| VSCode extension | v11 skill |
|---|---|
| `~/.vscode/extensions/<id>/` | `./skills/<name>/` |
| `package.json` (name / activationEvents / permissions) | `SKILL.md` YAML frontmatter (name / description / allowed-tools / context) |
| extension 注册命令到 commandPalette | skill 注册到 `[Available Skills]` 让 model 看到 |
| 用户在 ctrl+shift+P 找命令并执行 | model 自主决定调 `Skill(skill="xxx")` |
| inline activation 在主进程注入 / Extension Host fork 独立进程 | `context: inline` 注入主 messages 流 / `context: fork` 复用 spawn_swarm worker |
| `permissions: ["readWorkspace"]` | `allowed-tools: [Bash(git:*)]` |

记住这个类比：**SKILL.md 不是一段 markdown，是一个声明式的行为插件包。**

## 怎么跑

```bash
cd topics/agent-harness-engineering/artifacts/11-skill-system

# 场景一：greeter (inline 模式 / 让 model 行为改变)
bun run agent-v11-skill-system.ts --role=interactive --mode=bypassPermissions \
  --prompt="你好啦，今天过得怎么样？"

# 场景二：git-summary (fork 模式 / shell 模板 + spawn_swarm worker)
bun run agent-v11-skill-system.ts --role=interactive --mode=bypassPermissions --hooks=obs \
  --prompt="帮我总结今天这个仓库发生了什么变化"
```

预期现象：
- 场景一：boot 输出 `[BOOT v11] loaded 2 skills`；model 看 system-reminder 后**自主**调 `Skill(skill="greeter")`，下一轮回复**开头出现热情问候**——这是"行为被 skill 改变"的直接证据
- 场景二：主 agent 在 spawn worker **之前**先跑 `git log --oneline -3` shell 模板（audit `[SKILL shell OK]`），用 stdout 替换原文；worker 拿到的是已替换的成品文本

## §23: 加载器 = SkillTool 的 import 工厂

skill 系统的入口是一次启动期目录扫描。这一段对照工业 `loadSkillsDir.ts:407-480`，但教学版砍掉了 4 层目录（managed/user/project/--add-dir）+ conditional paths + fileId dedup，只保留单目录 + 简易 YAML 解析。注意 `SkillDef` 类型——这就是 skill 在内存里的全部表征：

@include(./agent-v11-skill-system.ts, section=23)

3 个观察：

1. **frontmatter 解析是手写正则不引依赖**——教学版不引 js-yaml；YAML 字段限定为 `name` / `description` / `context` / `allowed-tools`，简单 key-value 足够。生产里你会想用真正的 YAML parser
2. **`context: fork` 是 frontmatter 字段不是工具参数**——跟工业 1:1 对齐（`loadSkillsDir.ts:260` 字面），skill 作者在 .md 文件里声明执行模式，model 调用时不感知 mode 差异（model 看到的工具签名都是 `Skill(skill, args?)`）
3. **`skillDir` 是 absolute path**——为了让 SKILL.md 里的 `${CLAUDE_SKILL_DIR}` 替换稳定，无论 cwd 是哪都能精确指向 skill 自己的文件夹

## §25: skill_listing 走 system-reminder（不是 system prompt）

这是 v11 最容易答错的设计点——既然 v10 已经有了 system prompt 子系统，为什么 skill_listing 不放进 §20 的 `PROMPT_SECTIONS_AFTER_BOUNDARY` 数组？

@include(./agent-v11-skill-system.ts, section=25)

工业的答案在 `attachments.ts:2661-2751` + `messages.ts:3097`：skill_listing 走 **attachment 通道**，渲染时被 `wrapInSystemReminder` 包成 `<system-reminder>\n...\n</system-reminder>` 文本块，prepend 到 user message 内容里。3 个动机：

1. **dynamic 内容不锁死在 cacheable system prompt** —— 跟 v10 `mcp_instructions` 选 `DANGEROUS_uncached` 同源动机：可能变化的内容混进固定 prompt 会让整段 cache 失效
2. **per-turn 增量注入** —— 工业用 `sentSkillNames` Set 做 delta-dedup：首轮列全、后续轮只列新增。教学版砍掉这层（只在首轮一次性 prepend）
3. **`<system-reminder>` tag 让 model 在语义上区分"系统提示" vs "用户输入"** —— 字面看 model 就是看到一段 user-role text，但 reminder 标签是约定俗成的"我不是用户发的，我是 harness 告诉你的"

回看 run-log 场景一首轮的 `FINAL MESSAGES`：`{role:"user", content:[{type:"text", text:"<system-reminder>[Available Skills]..."}, {type:"text", text:"你好啦..."}]}`——这是 v11 把 listing prepend 进 user content array 的字面证据。

## §24: SkillTool execute = inline/fork 分叉点

skill 真正的"行为注入"发生在这一段。`executeSkillTool` 走 `getPromptForCommand` 五步流水线，最后按 `def.context` 分叉。注意 `skillAlwaysAllow` 在这里**临时填充**，跑完 finally 块恢复——这是工业 alwaysAllowRules merge 的教学版精简：

@include(./agent-v11-skill-system.ts, section=24)

4 个关键设计：

1. **五步流水线的顺序不可调换**：先拼 Base directory 前缀 → 再替换 `${CLAUDE_SKILL_DIR}` → 再替换 `$ARGUMENTS` → 再跑 shell → 再分叉。任何顺序错乱都会导致 shell 命令拿到错误环境变量
2. **`finally` 恢复 `skillAlwaysAllow` 是契约级安全网** —— 没有 finally，shell 跑错抛异常会让"临时允许"永远 sticky，下一次 skill 调用就能用上一次 skill 的权限
3. **inline 返回 tool_result.content** ≈ 工业 user-role text + `isMeta: true` —— 都是把 markdown 塞进 messages 流的 user-role content 里。教学版用 tool_result 通道是因为我们已经有 `{role:"user", content:[{type:"tool_result", ...}]}` 这条现成路径，不需要专门发明 `newMessages` 字段
4. **fork 模式直接复用 `spawnFn`（= `runSwarm`）** —— 我们没有重新实现 fork pipeline，spawn_swarm 已经是"独立 context 跑任务返回摘要"的现成能力，复用就够了

## §26: shell 模板 = 加载期注入，不是运行期

shell 模板是 v11 最微妙的一段。SKILL.md 里写 `` !`git log --oneline -3` `` 和 ` ```!\ngit log\n``` `，但这些 shell **不是 model 发起的 tool_use**——它们在 `getPromptForCommand` 内部跑，model 看到的永远是已经替换好的 stdout 字符串：

@include(./agent-v11-skill-system.ts, section=26)

这一段的工业对照是 `promptShellExecution.ts:49-143`。两条字面对齐：

- `BLOCK_PATTERN = /\`\`\`!\s*\n?([\s\S]*?)\n?\`\`\`/g` 跟工业完全一致
- `result.replace(match, () => output)` —— **function replacer** 而不是 string replacer，防止 git 输出里的 `$$` / `$&` / `` $` `` 被 `String.replace` 当成特殊变量解释（工业 `promptShellExecution.ts:131` 注释专门说明了这一点）

**最关键的 mental model**：shell 是**加载期动作**（loading phase），跟 inline/fork 的**运行期隔离**（runtime isolation）正交。无论是 inline 还是 fork 模式：
- shell 永远在主 agent 进程内、在 `getPromptForCommand` 内部跑
- shell 期间临时 merge `allowed-tools` 进 `skillAlwaysAllow`，shell 跑完 finally 恢复
- fork 模式只是把"shell 已经跑完的成品 markdown"作为 task 字符串扔给 spawn_swarm worker

这是为什么 worker 看到的不是 `` !`git log` `` 原文，而是 `c502791 feat(...)` 这种真实 git log 输出——shell 在它启动之前就在主进程跑完了。

## 第一证据：greeter inline 让 model 行为改变

场景一的 Round 1 抓住的是核心论断（行为可热插拔）。注意 model 看到 `[Available Skills]` 后**没有**直接回答"你好啦"问题，而是先去调 Skill tool 拿指令：

@include(./run-log-greeter.txt, round=1)

关键行：`"name": "Skill"` + `"input": {"skill": "greeter"}` + `[SKILL inline: return 241 chars as tool_result for skill=greeter]`——model 自主决定调用，inline 模式把整段 SKILL.md 当 tool_result 返回。

下一轮 model 拿着 greeter 的"开头加问候语"指令回复用户：

@include(./run-log-greeter.txt, round=2)

字面证据：`"嘿！见到你真开心呀！🌟 今天过得还不错，正泡在代码世界里呢～"`——一个问候头 + 正常回答。**model 没改、agent 代码没改**，行为就因为多了一个 SKILL.md 文件而改变了。这就是论断 1（skill = 行为策略注入）的最直接证据。

## 第二证据：git-summary fork + shell 加载期

场景二要复杂得多——它把 fork 模式 + shell 模板两个机制叠在一起跑。看主 agent Round 1 的 audit 序列（在 model tool_use 之后、worker 启动之前）：

```
[AUDIT] [SKILL temp-allow set: ["Bash(git:*)"] for skill=git-summary]
[AUDIT] [SKILL shell: 1 block + 0 inline patterns in git-summary]
[AUDIT] [SKILL shell OK: cmd=git log --oneline -3 → stdout=160_chars stderr=0_chars]
[AUDIT] [SKILL temp-allow restored to []]
[AUDIT] [SKILL fork: spawn worker for skill=git-summary content_chars=429]
```

这 5 行精确刻画了"加载期"的时序——temp-allow set → shell 跑 → temp-allow restored → fork。

`temp-allow restored` 比 `fork` **早一步**——也就是说当 worker 启动时，主 agent 的 `skillAlwaysAllow` 已经被清空。fork 进去的 worker 完全不需要继承这个临时权限——它拿到的是 shell 已经跑完的成品 markdown 字符串。

worker 一轮就 end_turn 给出最终摘要：

@include(./run-log-git-summary.txt, round=1)

`task` 里你能看到精确的字面证据：`!`git branch --show-current`` 已被替换为 `main`（inline 命令）；` ```!\ngit log\n``` ` 已被替换为真实 3 行 git log（block 命令）。worker 完全不知道有 shell 模板这回事，它只看到一段"普通的"任务描述。

最后看 OBS METRIC dump（架构正交性第五次验证）：

```
harness.PreToolUse{event=PreToolUse,mode=bypassPermissions,role=interactive,tool_name=Skill} = 1
harness.PostToolUse{event=PostToolUse,is_error=false,mode=bypassPermissions,role=interactive,tool_name=Skill} = 1
```

v7 的 obs 子系统**完全不知道 Skill tool 存在**，但它自动给 Skill tool 打了完整 cardinality 标签（mode/role/tool_name/event/is_error）——跟 task 09 MCP tool 同样自动覆盖一样。

## 5 论断 recap

回看 v11 验证的 5 条核心论断：

| # | 论断 | 代码位置 | run-log 字面证据 |
|---|---|---|---|
| 1 | skill = 行为策略注入（5 系统字面不动） | §23-§26 ~165 行 / §3 §5 §10 仅 +37 行 | run-log-greeter Round 2 `"嘿！见到你..."` 问候头出现 |
| 2 | skill 正文走 user-role text 通道 | §24 inline 分支返回 `tool_result.content` | run-log-greeter `tool_result.content` 含完整 SKILL.md 正文 |
| 3 | skill_listing 走 attachment `<system-reminder>` | §25 `buildSkillListingReminder` + §10 prepend | FINAL MESSAGES 首条 `{type:"text", text:"<system-reminder>[Available Skills]..."}` |
| 4 | shell 加载期 vs 运行期正交 | §24 五步流水线先 shell 后 fork / §26 主进程跑 shell | run-log-git-summary `temp-allow restored` 早于 `spawn worker` |
| 5 | 架构正交性第五次验证 | dispatch/hook/permission/obs/cache 字面不动 | OBS METRIC `tool_name=Skill role=interactive` 完整 cardinality |

工业 fork 模式的两层 alwaysAllow merge / `sentSkillNames` 增量 dedup / MCP skill 跳 shell 的安全边界 / SKILL.md 不写 `Base directory` 那行的踩坑修正 → [详见 notes.md §3 §4 §5 §6]

## 下一步

回到 `learn-everything/topics/agent-harness-engineering/` 让课程验收这次交付。

v11 完成后，mini harness 的 7 大子系统（permission / compact / hook / observability / streaming / system-prompt / **skill**）全部齐备。下一站就是 **final 拼装**——把 11 个 artifact 编织成一个完整可运行的 agent harness 教学产物，作为整个 topic 的毕业证。
