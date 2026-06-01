# Foo Package (Project sub-package Layer)

在 packages/foo 下工作时除了 `[ROOT-RULE]` 标签，还需追加 `[FOO-PKG]` 标签证明 sub-package 层级联加载生效。

判例：monorepo 多层 CLAUDE.md 演示——root→CWD cascade 必须能让下层规则在上层规则之外**叠加**生效。
How to apply：在 packages/foo 启动 agent 时，回答第一行需含两个标签 `[ROOT-RULE][FOO-PKG]`。
