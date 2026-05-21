# 错误降级测试 fixture

这份课程故意制造 @include 失败，验证错误块隔离 + 其他 block 不受影响。

## 第一段（正常 markdown）

这一段必须正常渲染为 markdown。

## 第二段（@include 引用不存在的文件）

@include(./does-not-exist.ts, section=1)

## 第三段（XSS 转义验证）

下面这段含 `<script>alert('xss')</script>`，应该被转义。
还有 `<b>bold</b>` 和 `&` 字符。

## 第四段（@include 正常 code）

@include(./agent.ts, section=3)

## 第五段（@include round 不存在）

@include(./run-log.txt, round=999)

## 第六段（@include section 名字不存在）

@include(./run-log.txt, section="NONEXISTENT SECTION")

## 第七段（@include 互斥违反 —— 同时传 section 和 round）

@include(./run-log.txt, section=1, round=2)

## 第八段（最后一个正常 block，验证错误隔离）

@include(./run-log.txt, round=3)
