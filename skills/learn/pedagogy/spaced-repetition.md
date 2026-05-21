# 间隔重复法（Spaced Repetition）

## 方法名

间隔重复法（Spaced Repetition），又称分散练习（Distributed Practice），是基于人类记忆遗忘规律的系统化学习策略。德国心理学家艾宾浩斯（Hermann Ebbinghaus）1885 年通过实验描绘出记忆衰减曲线，奠定其科学基础。塞巴斯蒂安·莱特纳（Sebastian Leitner）20 世纪 70 年代将其实践为"莱特纳卡片盒系统"，现代软件 Anki 与 SuperMemo 将间隔算法精确化为 SM-2 等公式。

## 核心理念

人脑记忆强度随时间指数衰减，但每次成功回忆都会重置并延长下一次遗忘的时间跨度。策略是：在记忆即将消退的临界点复习，效率最高，能以最少次数实现最长保留。"集中学习"（cramming）短期有效但遗忘极快。间隔重复必须配合"主动回忆"——主动提取本身就是强化记忆痕迹的关键，这被称为测试效应（testing effect）。研究显示间隔提取练习比同等时间重读效果高 50% 以上。复习间隔通常按指数增长：1 天→3 天→8 天→更长。

## 适用场景

适合需要长期记忆的内容：外语词汇、解剖学名词、API 签名、历史时间线、数学公式。任何需要"记住"且量大的知识单元都适合。不适合深度理解型任务——理解原理靠推演与应用，不靠重复。最佳实践：闪卡形式自主回忆后翻看答案，并诚实评分决定下次间隔。

## 在 learn-everything 中的应用启示

`journal.md` 为间隔重复提供天然时间序列基础。AI 在每轮调度时读取最新 N 条 journal，可识别哪些概念已较长时间未被提及——这正是间隔复习的触发信号。在 `socratic` 反问中，AI 可刻意混入对早期概念的回忆性问题（"还记得第一节我们讨论的 X 吗？"），实现轻量级间隔复习。`state.md` 的 `## 卡点记录` 段落记录历史困难点，AI 应优先对这些卡点做间隔回顾，确保薄弱环节充分强化而非总是向前推新。

## 来源引用

- Ebbinghaus, H. (1885). *Über das Gedächtnis*. Duncker & Humblot.
- Cepeda, N.J. et al. (2006). "Distributed Practice in Verbal Recall Tasks." *Psychological Bulletin*, 132(3).
- Roediger, H.L. & Karpicke, J.D. (2006). "Test-Enhanced Learning." *Psychological Science*, 17(3).
