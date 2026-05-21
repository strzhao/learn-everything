# 苏格拉底教学法（Socratic Method）

## 方法名

苏格拉底教学法（Socratic Method），又称苏格拉底反问法（elenchus），由古希腊哲学家苏格拉底创立。其弟子柏拉图在《对话录》中详细记录。核心精神浓缩于苏格拉底自述："我知道我什么都不知道。"

## 核心理念

知识不能被"灌输"，只能通过精心设计的问题（guided questioning）引导学生自己发现。教师扮演"助产士"（maieutics），通过持续追问让学生意识到自己的认知矛盾（aporia），从而修正与深化理解。典型问题类型有六种：澄清、假设探究、证据追问、反例构建、视角变换、元认知问题。每个回答触发下一个更深的问题，最终学生自主构建完整的认知框架。

## 适用场景

最适合概念理解深度需求高的领域：哲学、数学证明、编程思维、法律推理。学生具备基础知识但尚未内化时效果最佳。不适合零基础、纯记忆任务、或时间紧迫场景——反问需要充裕思考空间。在 AI 驱动场景下，大语言模型的实时分析能力恰好填补"教师必须深刻理解主题"这一传统门槛。

## 在 learn-everything 中的应用启示

`socratic` 动作类型直接实现此法。AI 判断学生已理解上一轮 `lecture` 后，下一轮自动切到 `socratic`，提出能检验深度的问题。`stuck_count` 是反问失效的安全网——连续 3 次无法推进则自动 `stuck->lecture` 退出反问，避免挫败循环。`journal.md` 记录每次问答便于 AI 避免重复同维度提问。`## 卡点记录` 段落追踪反问持续触发 stuck 的概念，识别真正薄弱点专项强化。

## 来源引用

- Plato, *The Dialogues*, trans. Benjamin Jowett (1871).
- Paul, R. & Elder, L. (2007). *The Thinker's Guide to the Art of Socratic Questioning*.
- Hattie, J. (2009). *Visible Learning*. Routledge.
