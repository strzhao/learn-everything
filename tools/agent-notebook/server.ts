// agent-notebook server: 把 lesson.md 渲染成 notebook 单页
// 启动: bun run server.ts <task-dir>
import { resolve, basename, join, extname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { parseLesson } from "./lib/parse-lesson";
import { buildMessagesSnapshots } from "./lib/messages-replay";
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
const taskDir = resolve(rawDir);
if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
  die(`task-dir not a directory: ${taskDir}`);
}
const lessonPath = join(taskDir, "lesson.md");
if (!existsSync(lessonPath)) die(`lesson.md not found at: ${lessonPath}`);
const taskName = basename(taskDir.replace(/\/+$/, ""));

const STATIC_DIR = join(import.meta.dir, "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(name: string): Promise<Response> {
  // 防止路径穿越
  if (name.includes("..") || name.startsWith("/")) {
    return new Response("forbidden", { status: 403 });
  }
  const filePath = join(STATIC_DIR, name);
  if (!existsSync(filePath)) return new Response("not found", { status: 404 });
  const ext = extname(filePath).toLowerCase();
  const ct = MIME[ext] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), { headers: { "content-type": ct } });
}

async function handleApiLesson(): Promise<Response> {
  try {
    const blocks = await parseLesson(lessonPath);
    const messagesSnapshots = buildMessagesSnapshots(blocks);
    return new Response(
      JSON.stringify({ task: taskName, blocks, messagesSnapshots }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: String(e?.message ?? e) }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
}

async function handleApiFile(url: URL): Promise<Response> {
  const rel = url.searchParams.get("path");
  const v = validateFilePath(taskDir, rel);
  if (!v.ok) {
    const r = errToResponse(v.err);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const r = await readFileWithSizeLimit(v.absPath);
  if (!r.ok) {
    const er = errToResponse(r.err);
    return new Response(JSON.stringify(er.body), {
      status: er.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const lang = inferLang(v.absPath);
  return new Response(
    JSON.stringify({ content: r.content, totalLines: r.totalLines, lang }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/" || path === "/index.html") return serveStatic("index.html");
    if (path === "/api/lesson") return handleApiLesson();
    if (path === "/api/file") return handleApiFile(url);
    if (path.startsWith("/static/")) return serveStatic(path.slice("/static/".length));
    return new Response("not found", { status: 404 });
  },
});

console.log(`[agent-notebook] task=${taskName}`);
console.log(`[agent-notebook] task-dir=${taskDir}`);
console.log(`[agent-notebook] listening on http://localhost:${server.port}/`);
