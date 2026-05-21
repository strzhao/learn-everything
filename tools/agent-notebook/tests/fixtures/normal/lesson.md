# Task 01 测试课程（fixture：normal）

这是一份用于红队验收测试的最小课程，覆盖 @include 三种主形态。

## 1. 任务说明（纯 markdown）

- 目标：观察 agent loop 的物理形态
- 关键：messages 数组的演化

## 2. 配置代码（code section int）

@include(./agent.ts, section=1)

## 3. 工具定义（code section int）

@include(./agent.ts, section=2)

## 4. 第一轮日志（log round）

@include(./run-log.txt, round=1)

## 5. 第二轮日志（log round）

@include(./run-log.txt, round=2)

## 6. 最终 messages（log section string）

@include(./run-log.txt, section="FINAL MESSAGES")
