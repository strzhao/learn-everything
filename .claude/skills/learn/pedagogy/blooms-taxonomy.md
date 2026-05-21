# 布鲁姆教育目标分类学（Bloom's Taxonomy）

## 方法名

布鲁姆教育目标分类学（Bloom's Taxonomy），由 Benjamin Bloom 1956 年首次提出，2001 年经 Lorin Anderson 与 David Krathwohl 修订为现行版本。修订版将认知层级从低到高分为六级：记忆（Remember）、理解（Understand）、应用（Apply）、分析（Analyze）、评估（Evaluate）、创造（Create）。每级对应一组可量化的认知动词，使学习目标可被明确评估。

## 核心理念

提供可操作的认知层级框架，明确"学会"不仅是"能复述"，而是要达到更高的认知操作（higher-order thinking）。六个层级构成连续谱，每级以下面层级为前提：记忆要求回忆事实；理解要求解释含义；应用要求新情境使用；分析要求拆解结构；评估要求基于标准做判断；创造要求综合产生新产物。还区分四类知识维度（事实/概念/程序/元认知），与认知层级形成二维矩阵。

## 适用场景

适用于课程设计与学习评估全过程。在编程教育中的具体映射：读懂代码是 Understand；按需求写出可运行代码是 Apply；发现缺陷并提出改进是 Analyze + Evaluate；从零设计新架构是 Create。这套框架使教育者能诊断"学生卡在哪一层"，针对性设计突破练习而非盲目重复或跨级跳推。

## 在 learn-everything 中的应用启示

learn-everything 的进度追踪隐式使用布鲁姆框架。`state.md` 的 `## 当前位置` 应记录学生当前所在认知层级。`task` 动作对应 Apply 及以上层级；`artifacts/` 实证 Apply 能力；`final/` 拼装对应 Create——从知识消费到知识生产的跃迁。AI 决定下一步动作时判断学生当前层级，选能推动升层的介入：只能复述则出 Understand 反问；能解释但未实践则出 Apply 任务；多个 artifacts 完成则引导向 Create 拼装。验收 `socratic` 回答时区分 Remember 复述与 Understand 真理解，只有真理解才触发 `accept`。

## 来源引用

- Bloom, B.S. et al. (1956). *Taxonomy of Educational Objectives*. McKay.
- Anderson, L.W. & Krathwohl, D.R. (2001). *A Taxonomy for Learning, Teaching, and Assessing*. Longman.
- Vanderbilt CFT. "Bloom's Taxonomy." https://cft.vanderbilt.edu/guides-sub-pages/blooms-taxonomy/
