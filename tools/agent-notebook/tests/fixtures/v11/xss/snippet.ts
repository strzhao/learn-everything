// xss fixture snippet —— 用于红队 v1.1 XSS acceptance test
// 内容必须在 hljs 着色后保持安全（不能产出可执行 <script>）

// ---------- 1. xss block ----------
// 下一行是 XSS 攻击载荷字面值，作为代码注释嵌入：
// <script>alert(1)</script>
const payload = "<script>alert('also-as-string')</script>";
const safe = payload.length > 0;
export { safe };
// ---------- 2. tail ----------
// 末尾哨兵段，确认 slice 不越界
