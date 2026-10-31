import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Project } from "../src/types.ts";
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentchat-test-")));
  const project: Project = { root, room: join(root, ".agentchat"), gitCommonDir: null };
  return { root, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CODEX_THREAD_ID", "AGENTCHAT_CLAUDE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_ENV_FILE", "CLAUDE_AGENT_ID", "AGENTCHAT_SUBAGENT", "AGENTCHAT_CODEX_BIN", "AGENTCHAT_GIT_BIN", "AGENTCHAT_LAUNCH_ID", "AGENTCHAT_LAUNCH_TOKEN", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE"]) delete env[key];
  return { ...env, ...extra };
}
export function cli(root: string, args: string[], env = testEnv(), input?: string) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../bin/agentchat"), "--project", root, ...args], { env: { ...env, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? join(root, "isolated-claude") }, input, encoding: "utf8", timeout: 15000 });
  const text = result.stdout.trim() || result.stderr.trim();
  return { ...result, data: text ? JSON.parse(text) : null };
}
export function git(root: string, args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: testEnv({ GIT_CONFIG_NOSYSTEM: "1" }) });
  if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
export function nativeIdentity(runtime: "codex" | "claude" = "codex") { return { runtime, session: randomUUID() }; }
