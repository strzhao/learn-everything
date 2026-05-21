// /api/file 路由的辅助：路径校验、扩展名 → hljs lang 推断、按大小限制读取
// 契约 8: GET /api/file?path=<rel> → 200/400/403/404/413

import { resolve, sep, extname } from "node:path";
import { existsSync, statSync } from "node:fs";

export const MAX_BYTES = 500 * 1024;

export type FileServeError =
  | { kind: "missing-path" }       // 400
  | { kind: "outside-task-dir" }   // 403
  | { kind: "not-found" }          // 404
  | { kind: "too-large" };         // 413

export type FileServeOk = { content: string; totalLines: number; lang: string };

/**
 * 路径校验：resolve(taskDir, rel).startsWith(taskDir + sep)。
 * rel 为空/只含空白 → 'missing-path'；越界 → 'outside-task-dir'。
 * 返回 absPath（经过 resolve），调用方再判断存在性 / 大小。
 */
export function validateFilePath(
  taskDir: string,
  rel: string | null | undefined,
): { ok: true; absPath: string } | { ok: false; err: FileServeError } {
  if (!rel || rel.trim() === "") return { ok: false, err: { kind: "missing-path" } };
  const absPath = resolve(taskDir, rel);
  // 允许 absPath 与 taskDir 完全相等的情况虽然没有意义但不会越界；用 startsWith(taskDir+sep) 严判
  if (absPath !== taskDir && !absPath.startsWith(taskDir + sep)) {
    return { ok: false, err: { kind: "outside-task-dir" } };
  }
  return { ok: true, absPath };
}

/** 扩展名 → hljs language 名（默认 plaintext）。 */
export function inferLang(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const m: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".json": "json",
    ".md": "markdown",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".html": "html",
    ".css": "css",
    ".rs": "rust",
    ".go": "go",
    ".sql": "sql",
    ".txt": "plaintext",
    ".log": "plaintext",
  };
  return m[ext] ?? "plaintext";
}

/**
 * 按大小限制读文件。返回 ok 或对应错误。
 * 顺序：not-found → too-large → 读取并返回 content/totalLines。
 */
export async function readFileWithSizeLimit(
  absPath: string,
  maxBytes: number = MAX_BYTES,
): Promise<{ ok: true; content: string; totalLines: number } | { ok: false; err: FileServeError }> {
  if (!existsSync(absPath)) return { ok: false, err: { kind: "not-found" } };
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return { ok: false, err: { kind: "not-found" } };
  }
  if (!st.isFile()) return { ok: false, err: { kind: "not-found" } };
  if (st.size > maxBytes) return { ok: false, err: { kind: "too-large" } };
  const content = await Bun.file(absPath).text();
  const totalLines = content.split("\n").length;
  return { ok: true, content, totalLines };
}

/** 错误码 → HTTP status + JSON 错误体。 */
export function errToResponse(err: FileServeError): { status: number; body: { error: string } } {
  switch (err.kind) {
    case "missing-path": return { status: 400, body: { error: "path required" } };
    case "outside-task-dir": return { status: 403, body: { error: "path outside task-dir" } };
    case "not-found": return { status: 404, body: { error: "file not found" } };
    case "too-large": return { status: 413, body: { error: "file too large (limit 500KB)" } };
  }
}
