import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { ChatError, requireThat } from "./errors.ts";
import type { Identity } from "./types.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionId(value: unknown): string {
  requireThat(typeof value === "string" && UUID.test(value), "E_IDENTITY", "The host did not provide a valid native session UUID");
  return value.toLowerCase();
}
function ownClaudeSession(env: NodeJS.ProcessEnv): string | null {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.replace(/^uds:/, "");
  if (!socket || !existsSync(socket)) return null;
  const stat = lstatSync(socket);
  if (!stat.isSocket() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) return null;
  const pid = /^(\d+)\.sock$/.exec(basename(socket))?.[1];
  if (!pid) return null;
  const metadata = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions", `${pid}.json`);
  try {
    const info = lstatSync(metadata);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return null;
    const record = JSON.parse(readFileSync(metadata, "utf8")) as { pid?: number; sessionId?: string };
    if (record.pid !== Number(pid) || !record.sessionId || !UUID.test(record.sessionId)) return null;
    process.kill(Number(pid), 0);
    return record.sessionId.toLowerCase();
  } catch { return null; }
}
export function identify(env: NodeJS.ProcessEnv = process.env): Identity {
  requireThat(!env.CLAUDE_AGENT_ID && !env.AGENTCHAT_SUBAGENT, "E_IDENTITY", "Subagents are not automatically enrolled");
  const claude = env.AGENTCHAT_CLAUDE_SESSION_ID || ownClaudeSession(env);
  const codex = env.CODEX_THREAD_ID;
  requireThat(!(claude && codex), "E_IDENTITY", "Conflicting host identities; do not guess which native session to bind");
  if (claude) return { runtime: "claude", session: sessionId(claude) };
  if (codex) return { runtime: "codex", session: sessionId(codex) };
  throw new ChatError("E_IDENTITY", "No native session identity. In Claude, install the project hooks and reload the session; do not supply a guessed UUID.");
}
export function optionalIdentity(env: NodeJS.ProcessEnv = process.env): Identity | undefined {
  if (!["CODEX_THREAD_ID", "AGENTCHAT_CLAUDE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_AGENT_ID", "AGENTCHAT_SUBAGENT"].some(key => env[key])) return undefined;
  return identify(env);
}
