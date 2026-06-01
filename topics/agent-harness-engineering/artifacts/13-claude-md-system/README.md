# 13 · Mini Project-Memory System (CLAUDE.md 子系统)

## 它做什么

给 agent 加一层"项目级长期记忆"：开会时自动加载 CLAUDE.md 文件 / 让 agent 跟项目+用户建立长期关系。

复用 v10 system prompt section（上轨 / 享 prompt cache）+ v11 attachment 通道（下轨 / lazy 触发）双轨注入 / dispatch/hook/permission/obs/cache 字面 0 修改 / 这是 mini harness 第 7 次架构正交性验证。

下半场用 `/init` 的 *every-line-test*（"Would removing this cause Claude to make mistakes?"）重写一份 demo-project/CLAUDE.md 作设计哲学的物理证明 / 6 条规则附判例 / 每条都对应 Claude 真会犯的错。

## 怎么用

```bash
# 1. root→CWD 多层 cascade 加载（5 层 from User to packages/foo）
cd demo-project/packages/foo
bun run ../../../agent-v13-claude-md-system.ts \
  --role=interactive --mode=bypassPermissions --hooks=audit \
  --prompt="按 CLAUDE.md 规则只回复一句话 hello world"

# 2. nested attachment lazy 触发（FileReadTool 读 ./subdir/file.ts → 下一轮注入 subdir/CLAUDE.md）
cd ../..  # back to demo-project
bun run ../agent-v13-claude-md-system.ts \
  --role=interactive --mode=bypassPermissions --hooks=audit \
  --prompt="先用 read_file 工具读 ./subdir/file.ts，然后再回复一句话 task done"

# 3. maybeCompact 触发 cache clear（5 个文件顺序读 → ≥5 轮触发 fullCompact）
bun run ../agent-v13-claude-md-system.ts \
  --role=interactive --mode=bypassPermissions --hooks=audit \
  --prompt="按以下顺序逐个完成任务，每完成一个就用 read_file 工具继续下一个：(1) read_file ./CLAUDE.md (2) read_file ./CLAUDE.local.md (3) read_file ./packages/foo/CLAUDE.md (4) read_file ./subdir/CLAUDE.md (5) read_file ./subdir/file.ts"

# 4. LRU 8 entry 驱逐 + Session-Set 防御（不调 model API / 直接演示双层 dedup）
bun run ../agent-v13-claude-md-system.ts --demo=lru-busy
```

关键观察点（5 份 run-log 字面证据）：
- `[MEMORY LOAD] cwd=... loaded=N layers=[...]` —— 上轨 cascade 加载
- `[NESTED INJECT] ./subdir/CLAUDE.md (triggered by ./subdir/file.ts)` —— 下轨 lazy 注入
- `[CACHE CLEAR] memoryCache + LRU cleared by compact: N entries dropped (session-set retained)` —— compact 后 cache 失效 / Session-Set 保留
- `[LRU EVICT] /fake/dir-1/CLAUDE.md (cap=8)` + `[DEDUP] ... already in session-set, skipping` —— 双层 dedup 工作
- model thinking 字面引用 CLAUDE.md 规则（"Local 层升级 ROOT-RULE 为 LOCAL-OVERRIDE..."）+ 输出 `[LOCAL-OVERRIDE] task done [NESTED-LOADED]` —— 三层规则同时生效

## 与其他组件的关系

v13 是在 [12-todowrite](../12-todowrite/) 之上的最小增量（v12 §1-26 字面 0 修改 / 4 处共 +12 行最小侵入），第 13 个子组件：

- **复用 [10-system-prompt-assembly](../10-system-prompt-assembly/) 的 systemPromptSection 工厂**：上轨 `systemPromptSection('memory', loadMemoryPrompt)` 字面 0 修改
- **复用 [11-skill-system](../11-skill-system/) 的 wrapMessagesInSystemReminder attachment 通道**：下轨 nested_memory 走同一个机制（**架构正交性第 7 次验证**）
- **双重 dedup 跟 [02-permission-gate](../02-permission-gate/) 同源**：sandbox+permission 双层防御 vs Session-Set+LRU 双层 dedup / 都针对不同失效模式 / 不是冗余而是必要互补
- **compact-triggered clear 跟 [05-context-compactor](../05-context-compactor/) + [10-system-prompt-assembly](../10-system-prompt-assembly/) 同精神**：compact 后语义状态变 / cache 必失效 / 但 Session-Set 不清（dedup 承诺不能跨 compact 失效）
- **prompt-as-actionable-constraint 是 [06-hook-engine](../06-hook-engine/) / [10-system-prompt-assembly](../10-system-prompt-assembly/) / [11-skill-system](../11-skill-system/) / [12-todowrite](../12-todowrite/) 软契约线索的最浓密物理载体**：CLAUDE.md 不仅约束写在 prompt，连"什么样的约束值得写"的元约束（every-line-test）也写在 prompt 里

`final/README.md` 拼装时通过相对路径 `../artifacts/13-claude-md-system/` 引用本组件，作为 mini harness "项目级长期记忆 + 设计哲学论证" 能力的证明。它是集齐 13 个 artifact 毕业产物的最后一块积木 / mini harness 7 大子系统全员到位（dispatch / permission / context / hook / obs / streaming / MCP / system-prompt / skill / todo / **memory**）。
