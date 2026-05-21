# v1.1 测试课程（fixture：v11/normal）

这是一份用于红队 v1.1 验收测试的最小课程，主要验证 `/api/file` 路由 + `Block.code.source` 新字段。

## 1. 配置（section=1）

@include(./agent.ts, section=1)

## 2. 工具定义（section=2）

@include(./agent.ts, section=2)

## 3. Agent Loop（section=4，关键片段）

@include(./agent.ts, section=4)

## 4. 第一轮日志

@include(./run-log.txt, round=1)
