# excerpts.md — claude-code 工业版关键源码摘录

> 0 假设原则：所有 file:line 经过 Read 工具核实，可在 `claude-code/src/...` 路径直接验证。

## §1 — `createSkillCommand.getPromptForCommand` 五步流水线

**文件**：`claude-code/src/skills/loadSkillsDir.ts:344-401`

```ts
async getPromptForCommand(args, toolUseContext) {
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  finalContent = substituteArguments(
    finalContent,
    args,
    true,
    argumentNames,
  )

  // Replace ${CLAUDE_SKILL_DIR} with the skill's own directory so bash
  // injection (!`...`) can reference bundled scripts.
  if (baseDir) {
    const skillDir =
      process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
    finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  }

  finalContent = finalContent.replace(
    /\$\{CLAUDE_SESSION_ID\}/g,
    getSessionId(),
  )

  // Security: MCP skills are remote and untrusted — never execute inline
  // shell commands (!`…` / ```! … ```) from their markdown body.
  if (loadedFrom !== 'mcp') {
    finalContent = await executeShellCommandsInPrompt(
      finalContent,
      {
        ...toolUseContext,
        getAppState() {
          const appState = toolUseContext.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: allowedTools,  // ← 第一层 alwaysAllow merge
              },
            },
          }
        },
      },
      `/${skillName}`,
      shell,
    )
  }

  return [{ type: 'text', text: finalContent }]
}
```

**v11 对应**：§24 `getPromptForCommand`。教学版砍掉 `substituteArguments` 的命名参数功能（只支持 `$ARGUMENTS`）和 `${CLAUDE_SESSION_ID}` 替换；MCP 安全边界没实现但 lesson + notes 明确说明。

## §2 — `executeShellCommandsInPrompt` 引擎

**文件**：`claude-code/src/utils/promptShellExecution.ts:49-143`

```ts
// Pattern for code blocks: ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// Pattern for inline: !`command`
// Uses a positive lookbehind to require whitespace or start-of-line before !
// This prevents false matches inside markdown inline code spans like `!!` or
// adjacent spans like `foo`!`bar`, and shell variables like $!
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
): Promise<string> {
  // ... shell tool 选择 ...

  // INLINE_PATTERN's lookbehind is ~100x slower than BLOCK_PATTERN on large
  // skill content (265µs vs 2µs @ 17KB). 93% of skills have no !` at all,
  // so gate the expensive scan on a cheap substring check.
  const blockMatches = text.matchAll(BLOCK_PATTERN)
  const inlineMatches = text.includes('!`') ? text.matchAll(INLINE_PATTERN) : []

  await Promise.all(
    [...blockMatches, ...inlineMatches].map(async match => {
      const command = match[1]?.trim()
      if (command) {
        // Check permissions before executing
        const permissionResult = await hasPermissionsToUseTool(
          shellTool,
          { command },
          context,
          createAssistantMessage({ content: [] }),
          '',
        )

        if (permissionResult.behavior !== 'allow') {
          throw new MalformedCommandError(...)
        }

        const { data } = await shellTool.call({ command }, context)
        // ... toolResultBlock ...
        // Function replacer — String.replace interprets $$, $&, $`, $' in
        // the replacement string even with a string search pattern. Shell
        // output (especially PowerShell: $env:PATH, $$, $PSVersionTable)
        // is arbitrary user data; a bare string arg would corrupt it.
        result = result.replace(match[0], () => output)  // ← function replacer
      }
    }),
  )
  return result
}
```

**v11 对应**：§26 `executeShellInSkill`。教学版省略了 PowerShell 路由 + BashTool.call 完整 ToolUseContext + 性能优化（`text.includes('!\`')` 短路检查我们保留了），核心逻辑（pattern + Promise.all + permission check + function replacer）字面保留。

## §3 — `executeForkedSkill` fork 入口

**文件**：`claude-code/src/tools/SkillTool/SkillTool.ts:122-289`

```ts
async function executeForkedSkill(
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  // ...
): Promise<ToolResult<Output>> {
  // ... logging + skill_name analytics ...

  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // ... agentDefinition + effort merge ...

  try {
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      agentMessages.push(message)
      // ... progress reporting ...
    }

    const resultText = extractResultText(agentMessages, 'Skill execution completed')
    agentMessages.length = 0

    return {
      data: {
        success: true,
        commandName,
        status: 'forked',
        agentId,
        result: resultText,
      },
    }
  } finally {
    clearInvokedSkillsForAgent(agentId)
  }
}
```

**v11 对应**：§24 `executeSkillTool` 的 `context === "fork"` 分支调用 `spawnFn(finalContent, mode)`。工业版用 `runAgent` 启动独立 sub-agent；教学版复用 `spawn_swarm` → `runSwarm` —— **同精神不同物理路径**。两者都把"最后一条 assistant text"提取为 fork 返回值。

## §4 — `prepareForkedCommandContext` 第二层 alwaysAllow merge

**文件**：`claude-code/src/utils/forkedAgent.ts:147-232`

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
              ...allowedTools,
            ]),
          ],
        },
      },
    }
  }
}

export async function prepareForkedCommandContext(
  command: PromptCommand,
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  const skillPrompt = await command.getPromptForCommand(args, context)
  const skillContent = skillPrompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')

  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])
  const modifiedGetAppState = createGetAppStateWithAllowedTools(
    context.getAppState,
    allowedTools,
  )

  const agentTypeName = command.agent ?? 'general-purpose'
  const baseAgent =
    agents.find(a => a.agentType === agentTypeName) ??
    agents.find(a => a.agentType === 'general-purpose') ??
    agents[0]

  const promptMessages = [createUserMessage({ content: skillContent })]

  return { skillContent, modifiedGetAppState, baseAgent, promptMessages }
}
```

**v11 对应**：教学版**不实现**这一层（详见 notes.md §3）。fork 进去的 `swarm-worker` 工具集没有 Bash，因此不需要继承 allowed-tools。

## §5 — `SkillTool` inline 模式（newMessages 通道）

**文件**：`claude-code/src/tools/SkillTool/SkillTool.ts:1095-1108`

```ts
// Direct injection — wrap SKILL.md content in a meta user message. Matches
// the shape of what processPromptSlashCommand produces for simple skills.
const toolUseID = getToolUseIDFromParentMessage(
  parentMessage,
  SKILL_TOOL_NAME,
)
return {
  data: { success: true, commandName, status: 'inline' },
  newMessages: tagMessagesWithToolUseID(
    [createUserMessage({ content: finalContent, isMeta: true })],
    toolUseID,
  ),
}
```

**v11 对应**：§24 `executeSkillTool` 的 inline 分支直接 `return { content: finalContent, is_error: false }`，让 dispatch 把它当成普通 tool_result 拼进 messages。

工业用 `newMessages` 通道 + `isMeta: true` 标志是为了在 transcript UI 上**不渲染**这条 user message（它不是用户真发的）；教学版用 tool_result 通道也达到同样的"user-role content 注入 messages 流"效果，省了 `isMeta` UI 区分（教学版本来就 dump JSON 不渲染）。

## §6 — `getSkillListingAttachments` listing 注入

**文件**：`claude-code/src/utils/attachments.ts:2661-2751`

```ts
async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // ... skip if agent doesn't have Skill tool ...

  const allCommands = mcpSkills.length > 0
    ? uniqBy([...localCommands, ...mcpSkills], 'name')
    : localCommands

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  // Resume path: prior process already injected a listing
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) sent.add(cmd.name)
    return []
  }

  // Find skills we haven't sent yet
  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))
  if (newSkills.length === 0) return []

  const isInitial = sent.size === 0
  for (const cmd of newSkills) sent.add(cmd.name)

  const contextWindowTokens = getContextWindowForModel(...)
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)

  return [
    {
      type: 'skill_listing',
      content,
      skillCount: newSkills.length,
      isInitial,
    },
  ]
}
```

**v11 对应**：§25 `buildSkillListingReminder`。教学版砍掉 `sentSkillNames` per-agent Map + `suppressNext` resume 逻辑 + token budget formatting，只保留"format skill list 拼字符串"的核心。

## §7 — `wrapInSystemReminder` 文本包装

**文件**：`claude-code/src/utils/messages.ts:3097-3099`

```ts
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
```

**v11 对应**：§25 `buildSkillListingReminder` 直接在字符串里写 `<system-reminder>\n[Available Skills]\n...\n</system-reminder>` —— 字面 1:1。这是 claude-code 全系统的通用约定 wrapper。

## §8 — `loadSkillsFromSkillsDir` 目录扫描

**文件**：`claude-code/src/skills/loadSkillsDir.ts:407-480`

```ts
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
): Promise<SkillWithPath[]> {
  const fs = getFsImplementation()

  let entries
  try {
    entries = await fs.readdir(basePath)
  } catch (e: unknown) {
    if (!isFsInaccessible(e)) logError(e)
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<SkillWithPath | null> => {
      try {
        // Only support directory format: skill-name/SKILL.md
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          return null
        }

        const skillDirPath = join(basePath, entry.name)
        const skillFilePath = join(skillDirPath, 'SKILL.md')

        let content: string
        try {
          content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
        } catch (e: unknown) {
          if (!isENOENT(e)) {
            logForDebugging(`[skills] failed to read ${skillFilePath}: ${e}`, ...)
          }
          return null
        }

        const { frontmatter, content: markdownContent } = parseFrontmatter(...)
        const skillName = entry.name
        const parsed = parseSkillFrontmatterFields(...)
        const paths = parseSkillPaths(frontmatter)

        return {
          skill: createSkillCommand({
            ...parsed,
            skillName,
            markdownContent,
            source,
            baseDir: skillDirPath,
            loadedFrom: 'skills',
            paths,
          }),
          filePath: skillFilePath,
        }
      } catch (error) { logError(error); return null }
    }),
  )

  return results.filter((r): r is SkillWithPath => r !== null)
}
```

**v11 对应**：§23 `loadSkillsFromDir`。教学版砍掉 SettingSource 区分 + symlink 支持 + 错误日志精细化 + `parseSkillPaths` conditional skills。核心结构（readdir → 遍历 directories → 读 SKILL.md → 解析 frontmatter → 构造 SkillDef）字面对齐。
