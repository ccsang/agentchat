import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "./types.ts";
import type { Member, Policy, Project } from "./types.ts";
import { readJson, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { tryLock } from "./lock.ts";

export interface SessionState {
  session: string; active: boolean; memberId?: string;
  listener?: { pid: number; token: string; expiresAt: number; mode: "hook" | "channel" };
  proof?: { nonce: string; replyId: string; verifiedAt: number; hostVersion: string; adapter: string };
}
export function policy(project: Project): Policy {
  const saved = readJson<Policy>(join(project.room, "config.json")) ?? DEFAULT_POLICY;
  requireThat(Number.isInteger(saved.budget) && saved.budget >= 1 && saved.budget <= 10000, "E_CONFIG", "Invalid notification budget");
  requireThat(Number.isInteger(saved.watchSeconds) && saved.watchSeconds >= 1 && saved.watchSeconds <= 3600 && typeof saved.autoJoin === "boolean", "E_CONFIG", "Invalid receiver configuration");
  requireThat(saved.codexBin === undefined || (typeof saved.codexBin === "string" && saved.codexBin.startsWith("/")), "E_CONFIG", "codexBin must be an absolute executable path");
  return saved;
}
export function sessionPath(project: Project, session: string): string {
  requireThat(/^[0-9a-f-]{36}$/.test(session), "E_IDENTITY", "Invalid native session identifier");
  return join(project.room, "sessions", `${session}.json`);
}
export function state(project: Project, member: Member): SessionState | null {
  if (!member.session_ref) return null;
  return readJson<SessionState>(sessionPath(project, member.session_ref));
}
export function saveState(project: Project, value: SessionState): void { writeJson(sessionPath(project, value.session), value); }
export function listenerLock(project: Project, member: Member): string {
  requireThat(/^m_[0-9a-f-]{36}$/.test(member.id), "E_MEMBER", "Invalid member identifier");
  return join(project.room, "listeners", `${member.id}.lock`);
}
export function receiver(project: Project, member: Member): Record<string, unknown> {
  if (member.runtime === "generic") return { mode: "manual", state: "manual", reason: "No native wake adapter" };
  const value = state(project, member);
  if (member.runtime === "codex") return { mode: "codex-queue", state: value?.proof ? "verified" : "unverified", evidence: value?.proof ?? null };
  const lock = listenerLock(project, member);
  let alive = false;
  if (value?.active && value.listener && value.listener.expiresAt > Date.now() && existsSync(lock)) {
    const release = tryLock(lock, false);
    alive = release === null; release?.();
  }
  return {
    mode: value?.listener?.mode ?? "hook", state: alive ? (value?.proof ? "verified" : "armed_unverified") : "inactive",
    expires_at: alive ? value?.listener?.expiresAt : null,
    reason: alive ? "Listener is running; transport alone is not proof of model processing" : "No active receiver; hook reload or another user turn may be needed",
    evidence: value?.proof ?? null,
  };
}
export function uninstalled(project: Project): boolean {
  return readJson<{ installed: boolean }>(join(project.room, "installed.json"))?.installed === false;
}
