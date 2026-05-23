// agent-notebook server: 把 lesson.md 渲染成 notebook 单页
// 启动: bun run server.ts <task-dir>
// v1.3: 顶部 banner 可切换同 root 下其他任务（/api/tasks + /api/lesson?task= + /api/file?task=）
import { resolve, basename, dirname, join, extname } from "node:path";
import { existsSync, statSync, readdirSync } from "node:fs";
import { parseLesson } from "./lib/parse-lesson";
import { buildRuns } from "./lib/messages-replay";
import {
  validateFilePath,
  inferLang,
  readFileWithSizeLimit,
  errToResponse,
} from "./lib/file-server";

const PORT = Number(process.env.PORT ?? 3737);

function die(msg: string): never {
  console.error(`[agent-notebook] ${msg}`);
  process.exit(1);
}

const rawDir = process.argv[2];
if (!rawDir) die("usage: bun run server.ts <task-dir>");
const initialTaskDir = resolve(rawDir);
if (!existsSync(initialTaskDir) || !statSync(initialTaskDir).isDirectory()) {
  die(`task-dir not a directory: ${initialTaskDir}`);
}
if (!existsSync(join(initialTaskDir, "lesson.md"))) {
  die(`lesson.md not found at: ${join(initialTaskDir, "lesson.md")}`);
}
// task root = 启动时 task 目录的父目录；其他 sibling 目录中含 lesson.md 的可被切换
const taskRoot = dirname(initialTaskDir.replace(/\/+$/, ""));
const defaultTaskName = basename(initialTaskDir.replace(/\/+$/, ""));

// task name 校验：只允许字母数字 + . _ -，禁止路径穿越
const TASK_NAME_RE = /^[A-Za-z0-9._-]+$/;
function resolveTask(name: string | null): { taskDir: string; lessonPath: string; taskName: string } | null {
  const t = name && TASK_NAME_RE.test(name) ? name : defaultTaskName;
  const taskDir = join(taskRoot, t);
  if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) return null;
  const lessonPath = join(taskDir, "lesson.md");
  if (!existsSync(lessonPath)) return null;
  return { taskDir, lessonPath, taskName: t };
}

const STATIC_DIR = join(import.meta.dir, "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(name: string): Promise<Response> {
  if (name.includes("..") || name.startsWith("/")) {
    return new Response("forbidden", { status: 403 });
  }
  const filePath = join(STATIC_DIR, name);
  if (!existsSync(filePath)) return new Response("not found", { status: 404 });
  const ext = extname(filePath).toLowerCase();
  const ct = MIME[ext] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), { headers: { "content-type": ct } });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleApiLesson(url: URL): Promise<Response> {
  const t = resolveTask(url.searchParams.get("task"));
  if (!t) return jsonResp({ error: `task not found or missing lesson.md` }, 404);
  try {
    const blocks = await parseLesson(t.lessonPath);
    const runs = buildRuns(blocks);
    return jsonResp({ task: t.taskName, blocks, runs });
  } catch (e: any) {
    return jsonResp({ error: String(e?.message ?? e) }, 500);
  }
}

async function handleApiFile(url: URL): Promise<Response> {
  const t = resolveTask(url.searchParams.get("task"));
  if (!t) return jsonResp({ error: `task not found` }, 404);
  const rel = url.searchParams.get("path");
  const v = validateFilePath(t.taskDir, rel);
  if (!v.ok) {
    const r = errToResponse(v.err);
    return jsonResp(r.body, r.status);
  }
  const r = await readFileWithSizeLimit(v.absPath);
  if (!r.ok) {
    const er = errToResponse(r.err);
    return jsonResp(er.body, er.status);
  }
  const lang = inferLang(v.absPath);
  return jsonResp({ content: r.content, totalLines: r.totalLines, lang });
}

// 列出 task root 下所有含 lesson.md 的 sibling 目录
async function handleApiTasks(url: URL): Promise<Response> {
  const current = resolveTask(url.searchParams.get("task"))?.taskName ?? defaultTaskName;
  let entries: string[] = [];
  try { entries = readdirSync(taskRoot); }
  catch (e: any) { return jsonResp({ error: String(e?.message ?? e) }, 500); }
  const tasks = entries
    .filter((n) => TASK_NAME_RE.test(n))
    .filter((n) => {
      const p = join(taskRoot, n);
      try { return statSync(p).isDirectory() && existsSync(join(p, "lesson.md")); }
      catch { return false; }
    })
    .sort()
    .map((n) => ({ name: n, active: n === current }));
  return jsonResp({ root: taskRoot, current, tasks });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/" || path === "/index.html") return serveStatic("index.html");
    if (path === "/api/lesson") return handleApiLesson(url);
    if (path === "/api/file") return handleApiFile(url);
    if (path === "/api/tasks") return handleApiTasks(url);
    if (path.startsWith("/static/")) return serveStatic(path.slice("/static/".length));
    return new Response("not found", { status: 404 });
  },
});

console.log(`[agent-notebook] task-root=${taskRoot}`);
console.log(`[agent-notebook] default-task=${defaultTaskName}`);
console.log(`[agent-notebook] listening on http://localhost:${server.port}/`);
