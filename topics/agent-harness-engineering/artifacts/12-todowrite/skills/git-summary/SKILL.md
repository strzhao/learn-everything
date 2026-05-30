---
name: git-summary
description: 总结当前 Git 仓库状态（分支 + 最近 3 次提交），fork 模式跑在独立 worker
context: fork
allowed-tools: [Bash(git:*)]
---

当前仓库状态：

- 分支： !`git branch --show-current`
- 最近 3 次提交：

```!
git log --oneline -3
```

请综合以上信息，用一段中文向用户简要总结今天这个仓库发生了什么（不超过 3 句话）。
如果用户问的内容跟 Git 无关，只需在开头用一行小字提及分支名即可。
