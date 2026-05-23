// 测试通用工具：启动 server 子进程 + 等待端口就绪 + 优雅关闭
// 红队黑盒测试，绝不 import 任何 server.ts/lib/*.ts 实现代码

import type { Subprocess } from "bun";

const SERVER_ENTRY =
  "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/tools/agent-notebook/server.ts";

export type ServerHandle = {
  proc: Subprocess;
  port: number;
  baseUrl: string;
};

function pickRandomPort(): number {
  // 3700-3799 范围，避免与 3737 默认端口冲突
  return 3700 + Math.floor(Math.random() * 100);
}

async function waitForReady(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(baseUrl + "/api/lesson", {
        signal: AbortSignal.timeout(500),
      });
      // Bun fetch 对未绑定 localhost 端口会返回 502（不抛错），需排除掉避免把"还没起来"误判为"已起来"
      // 即便 server 返回 500（lesson.md 解析问题）也算 ready
      if (res.status >= 200 && res.status < 600 && res.status !== 502) {
        // 消费 body 以释放连接
        await res.text().catch(() => {});
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(120);
  }
  throw new Error(
    `Server at ${baseUrl} did not become ready within ${timeoutMs}ms. Last error: ${String(
      lastErr,
    )}`,
  );
}

export async function startServer(taskDir: string): Promise<ServerHandle> {
  const port = pickRandomPort();
  const baseUrl = `http://localhost:${port}`;

  const proc = Bun.spawn(["bun", "run", SERVER_ENTRY, taskDir], {
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForReady(baseUrl);
  return { proc, port, baseUrl };
}

export async function stopServer(handle: ServerHandle | null): Promise<void> {
  if (!handle) return;
  try {
    handle.proc.kill();
    await handle.proc.exited;
  } catch {
    // 进程可能已经退出
  }
}

export const FIXTURES = {
  normal:
    "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/tools/agent-notebook/tests/fixtures/normal",
  errors:
    "/Users/stringzhao/workspace_sync/personal_projects/learn-everything/tools/agent-notebook/tests/fixtures/errors",
};
