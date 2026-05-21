# 项目知识索引

> 索引：每条知识一行，按主题分组。详情查对应文件。

## Patterns

- [契约规约必须用字面量化表达](patterns.md#契约规约字面量化) — 避免语义描述，让 contract-checker 能字面比对
- [测试脚本必须先备份再覆盖用户环境](patterns.md#测试脚本备份用户环境) — trap EXIT + mv 备份策略

## Decisions

- [字数验收用 wc -m 而非 wc -w](decisions.md#中文-markdown-字数检查) — 中文连续段被 wc -w 算作 1 word，不准
