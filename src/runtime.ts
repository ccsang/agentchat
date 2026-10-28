import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "./types.ts";
import type { Member, Policy, Project } from "./types.ts";
import { readJson, regularFile, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { tryLock } from "./lock.ts";
import { Store } from "./store.ts";
import { SOCKET_ADAPTER, validatePeer } from "./claude-peer.ts";
import { socketBinding, socketProof } from "./socket-state.ts";

export interface SessionState {
  session: string; active: boolean; memberId?: string;
  listener?: { pid: number; token: string; expiresAt: number; mode: "hook" | "channel"; launchId?: string;
    startedAt?: number; retry?: { reason: string; retryAt: number } };
  proof?: { nonce: string; replyId: string; verifiedAt: number; hostVersion: string; adapter: string; receiverToken?: string; launchId?: string };
  error?: { reason: string; at: number };
}
export function policy(project: Project): Policy {
  const old = readJson<Partial<Policy>>(join(project.room, "config.json"));
  const saved = { ...DEFAULT_POLICY, ...old };
  requireThat(Number.isInteger(saved.budget) && saved.budget >= 1 && saved.budget <= 10000, "E_CONFIG", "Invalid notification budget");
  requireThat(Number.isInteger(saved.windowSeconds) && saved.windowSeconds >= 5 && saved.windowSeconds <= 86400 && typeof saved.autoJoin === "boolean", "E_CONFIG", "Invalid receiver configuration");
  requireThat(saved.codexBin === undefined || (typeof saved.codexBin === "string" && saved.codexBin.startsWith("/")), "E_CONFIG", "codexBin must be an absolute executable path");
  return { budget: saved.budget, windowSeconds: saved.windowSeconds, autoJoin: saved.autoJoin, ...(saved.codexBin ? { codexBin: saved.codexBin } : {}) };
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
export function receiver(project: Project, member: Member, now = Date.now()): Record<string, unknown> {
  if (member.runtime === "generic") return { mode: "manual", state: "manual", reason: "No native wake adapter" };
  const value = state(project, member);
  if (member.runtime === "codex") return { mode: "codex-queue", state: value?.proof ? "verified" : "unverified", evidence: value?.proof ?? null };
  const lock = listenerLock(project, member);
  const native = socketBinding(project, member);
  const mode = native?.enabled ? SOCKET_ADAPTER : "channel";
  let alive = false;
  let nativeError: string | null = null;
  if (native?.enabled) {
    try { requireThat(!uninstalled(project), "E_CONFIG", "Project integration was uninstalled"); validatePeer(project, member, native); alive = true; } catch (error) { nativeError = (error as Error).message; }
  } else if (value?.active && value.listener?.mode === "channel" && value.listener.expiresAt > now && existsSync(lock)) {
    const release = tryLock(lock, false);
    alive = release === null; release?.();
  }
  const stopped = paused(project, member);
  let limit: unknown = null, limitReason = "ready";
  let databaseError = false;
  if (alive) {
    let store: Store | undefined;
    try { store = new Store(project.room, { readonly: true }); const config = policy(project);
      const current = store.notificationLimit(member.id, config.budget, now, config.windowSeconds * 1000); limit = current; limitReason = current.reason;
    } catch { databaseError = true; }
    finally { store?.close(); }
  }
  const currentProof = native?.enabled ? socketProof(project, member, native.instance) : value?.proof;
  const verified = native?.enabled ? currentProof?.adapter === SOCKET_ADAPTER && currentProof.receiverToken === native.instance :
    value?.proof?.adapter === "claude-channel" && value.proof.receiverToken === value.listener?.token && value.proof.launchId === value.listener?.launchId;
  const retrying = databaseError || (!native?.enabled && !!value?.listener?.retry);
  return {
    mode, experimental: !!native?.enabled, state: stopped?.kind === "host_blocked" ? "blocked" : !alive ? "inactive" : stopped ? "paused" : retrying ? "degraded" : limitReason !== "ready" ? "rate_limited" : verified ? "verified" : "armed_unverified",
    transport_alive: alive, verification: verified && alive ? native?.enabled ? "current_socket" : "current_channel" : "unverified", manual_read_available: true,
    receiver_instance: native?.enabled ? native.instance : value?.listener?.token ?? null,
    lease_expires_at: alive && !native?.enabled ? value?.listener?.expiresAt : null,
    reason: !alive ? nativeError ?? stopped?.reason ?? value?.error?.reason ?? "Use the prepared Claude launcher to enable this session's Channel; no periodic user message is needed" :
      stopped?.reason ?? (retrying ? "Database temporarily unavailable" : limitReason !== "ready" ? limitReason : verified ? "This exact receiver instance returned its nonce; future message processing still requires its own reply" : native?.enabled ? "Native inbox is present; socket submission and model processing require separate evidence" : "Channel connected; nonce evidence is required separately"),
    limits: limit, retry_at: !native?.enabled ? value?.listener?.retry?.retryAt ?? null : null, host_diagnostic: stopped?.kind === "host_blocked" ? stopped : null,
    evidence: verified && alive ? currentProof : null, historical_evidence: value?.proof ?? null,
  };
}
function pausePath(project: Project, member: Member, adapter?: string): string {
  requireThat(/^m_[0-9a-f-]{36}$/.test(member.id), "E_MEMBER", "Invalid member identifier");
  return join(project.room, "notifications", `${member.id}${adapter === SOCKET_ADAPTER ? ".socket" : ""}.paused.json`);
}
interface NotificationPause { reason: string; at: number; kind?: "host_blocked"; launchId?: string; source?: string; adapter?: string }
export function pause(project: Project, member: Member, reason: string, details: Omit<Partial<NotificationPause>, "reason" | "at"> = {}): void {
  writeJson(pausePath(project, member, details.adapter), { ...details, reason, at: Date.now() });
}
export function paused(project: Project, member: Member, adapter?: string): NotificationPause | null {
  const selected = adapter ?? (socketBinding(project, member)?.enabled ? SOCKET_ADAPTER : "claude-channel");
  if (selected === SOCKET_ADAPTER) {
    const scoped = readJson<NotificationPause>(pausePath(project, member, SOCKET_ADAPTER));
    if (scoped) return scoped;
    const old = readJson<NotificationPause>(pausePath(project, member));
    return old?.kind === "host_blocked" || old?.adapter === "claude-channel" ? null : old;
  }
  const value = readJson<NotificationPause>(pausePath(project, member));
  const launchId = state(project, member)?.listener?.launchId;
  if (value?.kind === "host_blocked" && launchId && value.launchId !== launchId) return null;
  return value;
}
export function reportChannelUnavailable(project: Project, member: Member): void {
  const listener = state(project, member)?.listener;
  requireThat(member.runtime === "claude" && listener?.mode === "channel" && listener.launchId, "E_RECEIVER", "Report the native status for one exact running Claude Channel");
  pause(project, member, "Claude /status reports Channel configured but not active (not currently available); MCP connection alone does not enable reception",
    { kind: "host_blocked", launchId: listener.launchId, source: "user_observed_native_status" });
}
export function resume(project: Project, member: Member): void {
  const path = pausePath(project, member, socketBinding(project, member)?.enabled ? SOCKET_ADAPTER : undefined);
  if (existsSync(path)) { regularFile(path); unlinkSync(path); }
}
export function uninstalled(project: Project): boolean {
  return readJson<{ installed: boolean }>(join(project.room, "installed.json"))?.installed === false;
}
