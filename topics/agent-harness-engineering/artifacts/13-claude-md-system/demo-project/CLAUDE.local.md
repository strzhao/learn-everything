# Demo Project (Local Layer — overrides Project)

Local 层规则：`[ROOT-RULE]` 标签**升级**为 `[LOCAL-OVERRIDE]`。Project 层的 ROOT-RULE 在此被 Local 层覆盖（demo "后加载者优先" 物理证据）。

判例：演示 append-not-override + 字面位置靠后 = 优先级高的隐式合并语义。
How to apply：cwd=demo-project 时，model 第一行只输出 `[LOCAL-OVERRIDE]`，不输出 `[ROOT-RULE]`。
