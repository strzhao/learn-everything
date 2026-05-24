// 解析 lesson.md, 拼出 Block[]
// 识别独占一行的 @include(...) 占位符, 其它行按 markdown 渲染
import { dirname, resolve, extname } from "node:path";
import { renderMarkdown } from "./render-markdown";
import { sliceCodeSection, sliceLogRound, sliceLogSection, SliceError } from "./slice";

export type Block =
  | { type: "markdown"; html: string }
  | { type: "code"; lang: string; content: string;
      source: { file: string; section: number | string;
        startLine: number; endLine: number; totalLines: number } }
  | { type: "log"; content: string;
      source: { file: string; round?: number; section?: string;
        startLine: number; endLine: number; totalLines: number };
      stopReason?: string }
  | { type: "error"; message: string; raw: string };

const INCLUDE_RE = /^\s*@include\s*\(\s*([^,]+?)\s*,\s*(.+?)\s*\)\s*$/;

interface ParsedArg {
  key: "section" | "round";
  value: number | string;
  isInt: boolean;
}

function parseArg(rawArgs: string): ParsedArg | { error: string } {
  // 支持单参数: section=4 / round=2 / section="FINAL MESSAGES"
  // 互斥违反: section=1, round=2 → 错误（契约 1）
  // 简单分割（quoted 字符串内不含逗号假设）
  const parts: string[] = [];
  let cur = "";
  let inQuote: string | null = null;
  for (const ch of rawArgs) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) parts.push(cur.trim());

  if (parts.length === 0) return { error: "no args" };
  if (parts.length > 1) {
    return { error: `mutually exclusive: only one of section/round allowed, got ${parts.length}` };
  }
  const m = parts[0].match(/^(\w+)\s*=\s*(.+)$/);
  if (!m) return { error: `cannot parse args: ${rawArgs}` };
  const key = m[1];
  let raw = m[2].trim();
  if (key !== "section" && key !== "round") {
    return { error: `unsupported key: ${key}` };
  }
  // 去引号
  let isQuoted = false;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
    isQuoted = true;
  }
  if (key === "round") {
    const n = Number(raw);
    if (!Number.isFinite(n) || isQuoted) return { error: `round must be int: ${raw}` };
    return { key, value: n, isInt: true };
  }
  // section: 数字 → int, 否则 string
  if (!isQuoted && /^\d+$/.test(raw)) {
    return { key, value: Number(raw), isInt: true };
  }
  return { key, value: raw, isInt: false };
}

function langFromExt(ext: string): string {
  const m: Record<string, string> = {
    ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx",
    ".json": "json", ".md": "markdown", ".sh": "bash", ".py": "python",
  };
  return m[ext.toLowerCase()] ?? "text";
}

async function resolveInclude(
  baseDir: string,
  relPath: string,
  arg: ParsedArg,
  rawLine: string,
): Promise<Block> {
  const filePath = resolve(baseDir, relPath);
  const ext = extname(filePath).toLowerCase();
  try {
    if (arg.key === "round") {
      const { content, stopReason, startLine, endLine, totalLines } =
        await sliceLogRound(filePath, arg.value as number);
      return {
        type: "log",
        content,
        source: { file: relPath, round: arg.value as number, startLine, endLine, totalLines },
        stopReason,
      };
    }
    // arg.key === 'section'
    if (arg.isInt) {
      // int section: 默认看作 code（如果是 .txt 也允许，因为 log 文件没有数字 section）
      if (ext === ".txt" || ext === ".log") {
        // log 文件的数字 section 不存在 → 走 SliceError 路径，但更可能是误用
        return {
          type: "error",
          message: `int section= on .txt log file is unsupported (use round= or quoted section=)`,
          raw: rawLine,
        };
      }
      const sliced = await sliceCodeSection(filePath, arg.value as number);
      return {
        type: "code",
        lang: langFromExt(ext),
        content: sliced.content,
        source: {
          file: relPath,
          section: arg.value as number,
          startLine: sliced.startLine,
          endLine: sliced.endLine,
          totalLines: sliced.totalLines,
        },
      };
    }
    // 引号 section: 字符串名 → 通常用于 log 命名段
    const { content, startLine, endLine, totalLines } =
      await sliceLogSection(filePath, arg.value as string);
    return {
      type: "log",
      content,
      source: { file: relPath, section: arg.value as string, startLine, endLine, totalLines },
    };
  } catch (e: any) {
    if (e instanceof SliceError) {
      return { type: "error", message: e.message, raw: rawLine };
    }
    return { type: "error", message: String(e?.message ?? e), raw: rawLine };
  }
}

/**
 * 解析 lesson.md → Block[]
 * - 独占一行的 @include(...) → 切片 block
 * - 其它行（连续段）→ markdown block
 */
export async function parseLesson(lessonPath: string): Promise<Block[]> {
  const md = await Bun.file(lessonPath).text();
  const baseDir = dirname(lessonPath);
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let buf: string[] = [];

  const flushMarkdown = () => {
    if (buf.length === 0) return;
    const text = buf.join("\n").trim();
    if (text !== "") {
      blocks.push({ type: "markdown", html: renderMarkdown(text) });
    }
    buf = [];
  };

  for (const line of lines) {
    const incMatch = line.match(INCLUDE_RE);
    if (incMatch) {
      flushMarkdown();
      const relPath = incMatch[1].trim();
      const argsRaw = incMatch[2].trim();
      const parsed = parseArg(argsRaw);
      if ("error" in parsed) {
        blocks.push({ type: "error", message: parsed.error, raw: line });
        continue;
      }
      const block = await resolveInclude(baseDir, relPath, parsed, line);
      blocks.push(block);
      continue;
    }
    buf.push(line);
  }
  flushMarkdown();
  return blocks;
}
