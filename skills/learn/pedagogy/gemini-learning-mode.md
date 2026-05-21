# Gemini 学习模式（Gemini Learning Mode）

## 方法名

Gemini 学习模式（Gemini Learning Mode），是 Google 在 Gemini AI 助手中针对学习场景推出的专项功能模式。根据 Google 官方面向学生的产品介绍及 Gemini 产品概览，该模式将 AI 角色从"答案提供者"转变为"学习引导者"，核心理念是帮助用户建立真正的理解而非仅获得现成答案。Google 在 2024-2025 年陆续将这些教育功能整合进 Gemini 应用并为学生群体专门优化。

## 核心理念

学习模式开启后，AI 不直接给答案或解题步骤，而是通过提问、提示和分步引导让学生自主思考并得出结论。具体表现：提出启发性问题（"你认为第一步是什么？"）；提供部分线索而非完整答案；对中间推理过程即时反馈；学生卡住时提供"逐渐增加的提示"（escalating hints）而非直接揭示答案。Google 官方将其定位为"教你为什么，而不只是如何"的分步引导工具，参考了认知科学的"生产效应"——自主生成的答案比被动接受的记忆更深、理解更扎实。

## 适用场景

适合有明确学习目标、希望真正掌握知识而非快速完成作业的场景：数学解题、编程概念、科学推导、写作训练、外语语法。特别适合学生做作业或练习题时——直接给答案会剥夺学习机会，引导式提示则强化理解。不适合需要快速查事实的场景，也不适合连问题方向都不明确的零起步阶段。

## 在 learn-everything 中的应用启示

learn-everything 整体设计深度参考 Gemini 学习模式：AI 作为调度者而非答案机，根据 `state.md` 动态切换 `lecture` / `socratic` / `task` 三种角色。Gemini 的"逐渐增加的提示"对应 learn-everything 的 `stuck_count` 机制——卡住时先增加提示深度，达阈值（≥3）才 `stuck->lecture` 切回完整讲解。Gemini 的"验证理解后才推进"流程直接对应 `socratic → accept → task` 流水线：每个新概念须经反问验证后才推进，验证结果写入 `journal.md` 作持久化凭证。Gemini 生成个性化测验的功能也启发了 artifacts 设计——每个 artifact 都是当前学习阶段的"可交付验证"。

## 来源引用

- Google Gemini for Students: https://gemini.google/students/
- Google Gemini overview: https://gemini.google/overview/
- Google Blog, Gemini Features: https://blog.google/products/gemini/
