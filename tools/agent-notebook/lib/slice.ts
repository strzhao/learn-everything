// 切片函数：从代码 / 日志文件中按区段或 round 提取片段
// 契约见 state.md #3/#4/#5

export class SliceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SliceError";
  }
}

/**
 * 从 .ts/.js 文件提取按 `// ---------- N. ... ----------` 标记的区段。
 * 含起始注释行本身；不含末尾的下一段标题。
 *
 * v1.1: 返回 { content, startLine, endLine, totalLines } —— startLine/endLine 1-based inclusive。
 */
export async function sliceCodeSection(
  filePath: string,
  section: number,
): Promise<{ content: string; startLine: number; endLine: number; totalLines: number }> {
  const text = await Bun.file(filePath).text();
  const lines = text.split("\n");
  const headerRe = /^\/\/\s*-{3,}\s*(\d+)\.\s.*?-{3,}\s*$/;
  let startIdx = -1;
  let endIdx = lines.length; // EOF
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    const n = Number(m[1]);
    if (startIdx === -1 && n === section) {
      startIdx = i;
    } else if (startIdx !== -1) {
      endIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    throw new SliceError(`section ${section} not found in ${filePath}`);
  }
  // 去掉尾部多余空行（不含标题行所属内容）
  let end = endIdx;
  while (end > startIdx + 1 && lines[end - 1].trim() === "") end--;
  return {
    content: lines.slice(startIdx, end).join("\n"),
    startLine: startIdx + 1,
    endLine: end,
    totalLines: lines.length,
  };
}

/**
 * 从日志文件提取 `========== ROUND N  stop_reason=X ==========` 起的一轮。
 * 含起始分隔符行；到下一个 `==========` 分隔符或 EOF 止。
 */
export async function sliceLogRound(
  filePath: string,
  round: number,
): Promise<{ content: string; stopReason: string }> {
  const text = await Bun.file(filePath).text();
  const lines = text.split("\n");
  const roundRe = /^={5,}\s*ROUND\s+(\d+)\s+stop_reason=(\w+)\s*={5,}\s*$/;
  const dividerRe = /^={5,}\s+.*={5,}\s*$/;
  let startIdx = -1;
  let stopReason = "";
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(roundRe);
    if (m && Number(m[1]) === round) {
      startIdx = i;
      stopReason = m[2];
      // 找下一分隔符
      for (let j = i + 1; j < lines.length; j++) {
        if (dividerRe.test(lines[j])) {
          endIdx = j;
          break;
        }
      }
      break;
    }
  }
  if (startIdx === -1) {
    throw new SliceError(`round ${round} not found in ${filePath}`);
  }
  let end = endIdx;
  while (end > startIdx + 1 && lines[end - 1].trim() === "") end--;
  return { content: lines.slice(startIdx, end).join("\n"), stopReason };
}

/**
 * 从日志文件提取 `========== <SECTION> ==========` 起的命名段。
 * 用于 "FINAL MESSAGES" 等。
 */
export async function sliceLogSection(
  filePath: string,
  section: string,
): Promise<string> {
  const text = await Bun.file(filePath).text();
  const lines = text.split("\n");
  const target = section.trim();
  const namedRe = /^={5,}\s+(.+?)\s+={5,}\s*$/;
  const dividerRe = /^={5,}\s+.*={5,}\s*$/;
  let startIdx = -1;
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(namedRe);
    if (m && m[1].trim() === target) {
      startIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (dividerRe.test(lines[j])) {
          endIdx = j;
          break;
        }
      }
      break;
    }
  }
  if (startIdx === -1) {
    throw new SliceError(`section "${section}" not found in ${filePath}`);
  }
  let end = endIdx;
  while (end > startIdx + 1 && lines[end - 1].trim() === "") end--;
  return lines.slice(startIdx, end).join("\n");
}
