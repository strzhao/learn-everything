# promo-card-renderer

> 内部电商促销卡片 React 组件库 / 跨多个营销活动复用 / 8 人小组维护 / 集成 NCM + ksched 后端。

本文件由人类工程师维护 / 收录"删掉这条 Claude 会犯错的具体行为"。每条规则附判例 + How to apply。每条都已通过 *every-line-test*（Would removing this cause Claude to make mistakes? If no, cut it.）。

---

## 1. 改 .tsx 前必须 Read / 不能凭文件名推断内容

**判例**：上个迭代有人把 `Card.tsx` 的 className 从 `"promo-card"` 改成 `"PromoCard"`（kebab→Pascal）。Claude 凭文件名以为 className 没变，连续两次 Edit 失败 oldString 不匹配 / 我们才发现真相。
**How to apply**：动任何 `.tsx` 之前必须 Read 一遍 / 即使你"觉得"自己知道内容。文件名跟实现的关系比想象中弱。

## 2. 改 promotion 类型字段必同步更新 fixtures

**判例**：q3 改 `price: number` → `price: { amount: number; currency: string }` / 没动 `__fixtures__/promotion-list.json` / 测试用旧 fixture **假绿** / 上线后报"price.toFixed is not a function"挂 30 分钟。
**How to apply**：动 `src/types/promotion.ts` 任何字段时必 grep `__fixtures__/` 同步更新所有 fixture 文件。fixture 跟类型 drift 是测试假绿的最大来源。

## 3. CI failing 不允许 push --force

**判例**：上季发版抢点有人 `push --force` 跳过 CI 红 / lint 真有问题 / 上线 build 步骤再次跑 lint 直接挂 / 线上回滚 + 全员晚饭推迟 1.5 小时。
**How to apply**：CI 红时绝不 `--force` / 先修复让 CI 绿了再提交。即使你"觉得" lint 错是误报，也要修。

## 4. 新组件优先复用 `src/ui/` 基础组件

**判例**：上一季存在 **4 个不同的 Button 组件**（每个 PR 各搞一份）/ 用户跨页面看到 7 套 hover 状态 / 设计审查打回重做整个 q4 sprint。
**How to apply**：写新组件前先 `grep -l "export.*Button\|export.*Input" src/ui/` 看现有基础件 / 找不到合适的再 ping 设计师 / **绝不**因为"我自己写一个更快"而平行实现。

## 5. 改 `promotion-banner.tsx` props 必跑 storybook

**判例**：promo-banner 的 hover state 只在 storybook 才能直观看到 / `bun test` 跑不出来 / 上次有人改了 hover 颜色但只跑了单测 / 直接合并 / 一周后用户反馈"卡片像挂了"才发现 hover 没了。
**How to apply**：动 `promotion-banner.tsx` 任一 prop 后必 `bun run storybook` 视觉跑一遍 / 验过 hover/active/disabled 三态再提交。

## 6. catch 块的 logger.error 必含 `{ promotion_id }`

**判例**：q2 排查"某些卡片不渲染"线上问题 / 日志只有 `"render failed: invalid input"` 没有 `promotion_id` / 我们把全平台 800 个 promotion 全灰盘了 30 分钟才二分定位。
**How to apply**：所有 catch 块里 `logger.error(...)` 必 include `{ promotion_id }` 字段（如不在当前作用域 / 想办法传过来 / 不能用 "TODO 后续加" 偷懒）。审查时见到没这个字段的 logger.error 直接 request changes。
