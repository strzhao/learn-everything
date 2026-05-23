# agent-notebook

把 task artifact 的 `lesson.md` 渲染成一个单页 notebook 视图：左侧 lesson 流（讲解 + 代码片段 + 真实运行日志），右侧 messages 状态侧栏跟随单步推进同步更新。

## 用法

```bash
# 进入工具目录
cd learn-everything/tools/agent-notebook

# 启动（参数：artifact 目录绝对路径或相对路径，必须含 lesson.md）
bun run server.ts ../../topics/agent-harness-engineering/artifacts/01-minimal-agent-loop/

# 自定义端口
PORT=3737 bun run server.ts ../../topics/agent-harness-engineering/artifacts/01-minimal-agent-loop/
```

打开 http://localhost:3737/ 即可。

- 顶部：`[← 上一步] [下一步 →]`，按 round 单步推进。
- 左主区：按 `lesson.md` 顺序渲染讲解段落、代码片段、运行日志（默认第一个 round 展开，后续折叠）。
- 右侧：`messages` 数组当前快照；每展开一轮，本轮新增条目高亮 NEW，`tool_use_id` 与对应 `tool_result.tool_use_id` 同色配对。

## lesson.md 引用语法

`lesson.md` 是标准 markdown，外加一条独占一行的特殊指令 `@include(...)`：

```
@include(<rel-path>, <key>=<value>)
```

`<rel-path>` 相对 `lesson.md` 所在目录解析。

支持的键：

| 键 | 类型 | 适用 | 含义 |
|---|---|---|---|
| `section` | int | 代码文件 | 找 `// ---------- N. ... ----------` 的 N |
| `section` | quoted string | 日志文件 | 找 `========== <NAME> ==========` 的命名段（如 `"FINAL MESSAGES"`） |
| `round` | int | 日志文件 | 找 `========== ROUND N stop_reason=X ==========` 的一轮 |

每条 `@include` 必须且只能传一个参数。

示例：

```markdown
看一下 agent loop 主体：

@include(./agent.ts, section=4)

执行结果（第一轮）：

@include(./run-log.txt, round=1)

完整 messages 数组：

@include(./run-log.txt, section="FINAL MESSAGES")
```

普通 markdown 语法仅支持极小子集：H1-H3 标题、段落、无序列表、`inline code`、`**bold**`。所有内容会做 HTML 实体转义防 XSS。

## 跨任务复用

每个 task 在自己目录下放一个 `lesson.md`，启动时把目录传给 `server.ts` 即可。v1 不做多 task UI 切换，重启进程指向另一个目录就行。

## 错误降级

如果 `lesson.md` 引用了不存在的文件、找不到的 section/round，渲染为红色错误块，标注原 `@include` 行内容，其它 block 不受影响。

## 设计原则

- 自身依赖：无（纯 bun runtime + 原生 Web API），呼应 Otter "从 0 到 1" 精神。
- v1 不做：现场调用 API 重跑、代码语法高亮、多 task UI 切换、文件浏览器、热重载、暗色模式、移动端适配、markdown 全语法（表格 / 链接 / 图片）。
