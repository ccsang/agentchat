import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { ChatError, requireThat } from "./errors.ts";
import type { Identity } from "./types.ts";
import { processAncestors } from "./lifecycle.ts";
import type { Ancestor } from "./lifecycle.ts";
import { nearestHost } from "./host-context.ts";

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
export function identify(env: NodeJS.ProcessEnv = process.env, ancestors?: Ancestor[]): Identity {
  requireThat(!env.AGENTCHAT_SUBAGENT, "E_IDENTITY", "Subagents are not automatically enrolled");
  const claude = env.AGENTCHAT_CLAUDE_SESSION_ID || ownClaudeSession(env);
  const codex = env.CODEX_THREAD_ID;
  const agy = env.ANTIGRAVITY_CONVERSATION_ID;
  const agyContext = ["ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_TRAJECTORY_ID", "ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_AGENTAPI_EXE"].some(key => env[key]);
  if (agyContext) {
    const host = nearestHost(ancestors ?? processAncestors());
    requireThat(host, "E_IDENTITY", "Cannot establish the nearest native host; do not borrow an outer conversation identity");
    if (host.runtime === "agy") return { runtime: "agy", session: sessionId(agy) };
    // Nested agents inherit outer variables. Only the nearest host's own
    // identity is usable; never use an outer agy/Claude/Codex identity.
    if (host.runtime === "claude" && claude && !env.CLAUDE_AGENT_ID) return { runtime: "claude", session: sessionId(claude) };
    if (host.runtime === "codex" && codex) return { runtime: "codex", session: sessionId(codex) };
    throw new ChatError("E_IDENTITY", "The nearest native host has no identity; inherited agy context cannot identify it");
  }
  requireThat(!env.CLAUDE_AGENT_ID, "E_IDENTITY", "Subagents are not automatically enrolled");
  requireThat(!(claude && codex), "E_IDENTITY", "Conflicting host identities; do not guess which native session to bind");
  if (claude) return { runtime: "claude", session: sessionId(claude) };
  if (codex) return { runtime: "codex", session: sessionId(codex) };
  throw new ChatError("E_IDENTITY", "No native session identity. Use native session/socket context, or load the AgentChat Claude plugin hooks; never supply a guessed UUID.");
}
export function optionalIdentity(env: NodeJS.ProcessEnv = process.env): Identity | undefined {
  if (!["CODEX_THREAD_ID", "AGENTCHAT_CLAUDE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_AGENT_ID", "AGENTCHAT_SUBAGENT", "ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_TRAJECTORY_ID", "ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_AGENTAPI_EXE"].some(key => env[key])) return undefined;
  return identify(env);
}
