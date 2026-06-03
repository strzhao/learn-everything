## 它做什么

v14 给 mini harness 加了最后一层个人记忆：agent 自己学着记住用户偏好、项目状态、外部资源指针。跟 v13 的 CLAUDE.md（团队硬约束 / 人手维护 / git 追踪）不同，auto-memory 是 AI 自主维护的个人画像——用户说"记住 X"时主动写，没明说时 background agent 补漏。

核心机制是**双轨并发互斥**：主 agent 通过 prompt 协议直接用 FileWriteTool 写 `.claude-memory/`（主路径），stop hook 在 query loop 结束后 fork 一个 extraction agent 扫 messages 提取隐式信号（兜底路径）。两者互斥——主 agent 写了，background 就跳过。

## 怎么用

```bash
cd topics/agent-harness-engineering/artifacts/14-auto-memory/

# 基本运行（用户显式说"记住"→ 主路径写 memory → extraction 跳过）
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="记住我喜欢简洁回复"

# 隐式信号场景（主 agent 不写 → extraction agent 触发）
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="帮我读一下 demo-project/CLAUDE.md"

# 验证双层 dedup（先 read_file memory → Layer 1 拦截 / 多轮同文件 → Layer 2 拦截）
bun run agent-v14-auto-memory.ts --mode=bypassPermissions --hooks=all \
  --prompt="先读 demo-project/.claude-memory/project_release.md 然后告诉我发布日"
```

关键审计日志：
- `[BOOT v14] auto-memory extraction hook registered` — Stop hook 注册
- `[RELEVANT] surfaced N memory: ...` — 下轨 attachment 注入
- `[FileWrite] ./demo-project/.claude-memory/xxx.md` — 主路径写入
- `[EXTRACT] skipping — main agent already wrote memory in this turn` — 互斥命中
- `[EXTRACT] triggering background agent` — 兜底路径触发
- `[DEDUP] xxx already in readFileState — skipping surface` — Layer 1
- `[DEDUP] xxx already surfaced earlier — skipping` — Layer 2

## 与其他组件的关系

v14 是 mini harness 的最后一个子系统，它不新建任何通道，完全复用已有基础设施：
- 复用 v4 `spawn_swarm` → background extraction agent fork
- 复用 v6 hook engine → Stop event fire-and-forget
- 复用 v7 obs → FileWriteTool 自动 cardinality 控制
- 复用 v10 `systemPromptSection` → MEMORY.md 索引上轨
- 复用 v11 `wrapMessagesInSystemReminder` 通道精神 → relevant_memories attachment 下轨
- 复用 v13 `readFileStateLRU` → dedup Layer 1

这是架构正交性第 8 次验证：整个 auto-memory 子系统 ~195 行新增代码，v13 §1-31 字面不动（仅 5 处最小侵入共 ~20 行）。
