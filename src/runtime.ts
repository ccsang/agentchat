import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "./types.ts";
import type { Member, Policy, Project } from "./types.ts";
import { readJson, regularFile, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { Store } from "./store.ts";
import { SOCKET_ADAPTER, validatePeer } from "./claude-peer.ts";
import { socketBinding, socketDisabled, socketProof } from "./socket-state.ts";
import { integrationDir } from "./project.ts";
import { installation } from "./workspace.ts";
import { legacyMember, memberRoomSelected, resolveRoom, roomName } from "./rooms.ts";
import { sessionId } from "./identity.ts";

export interface SessionState {
  session: string; active: boolean; memberId?: string;
  listener?: { pid: number; token: string; expiresAt: number; mode: "hook" | "channel"; launchId?: string;
    startedAt?: number; routingVersion?: number; retry?: { reason: string; retryAt: number } };
  proof?: { nonce: string; replyId: string; verifiedAt: number; hostVersion: string; adapter: string; receiverToken?: string; launchId?: string };
  error?: { reason: string; at: number };
}
export function policy(project: Project): Policy {
  const old = readJson<Partial<Policy>>(join(integrationDir(project), "config.json"));
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
  if (!memberRoomSelected(project, member)) return { mode: member.runtime === "codex" ? "codex-queue" : SOCKET_ADAPTER,
    state: "room_not_selected", transport_alive: false, verification: "unverified", manual_read_available: true, reason: "This native session selected another room; messages remain readable" };
  const value = state(project, member);
  if (member.runtime === "codex") return { mode: "codex-queue", state: value?.proof ? "verified" : "unverified", evidence: value?.proof ?? null };
  const native = socketBinding(project, member), stopped = paused(project, member), disabled = socketDisabled(project, member) || !!native && !native.enabled;
  let alive = false, reason = value?.error?.reason;
  if (native?.enabled && !disabled) {
    try {
      requireThat(!uninstalled(project), "E_CONFIG", "Project integration was uninstalled");
      requireThat(value?.active !== false, "E_RECEIVER", "The native session ended");
      validatePeer(project, member, native); alive = true;
    } catch (error) { reason = (error as Error).message; }
  }
  let limits: unknown = null, limitReason = "ready", degraded = false;
  if (alive) {
    let store: Store | undefined;
    try {
      store = new Store(project.room, { readonly: true }); const config = policy(project);
      const limit = store.notificationLimit(member.id, config.budget, now, config.windowSeconds * 1000); limits = limit; limitReason = limit.reason;
    } catch { degraded = true; } finally { store?.close(); }
  }
  const proof = native?.enabled ? socketProof(project, member, native.instance) : null;
  const verified = proof?.adapter === SOCKET_ADAPTER && proof.receiverToken === native?.instance;
  return { mode: SOCKET_ADAPTER, experimental: true,
    state: stopped ? "paused" : !alive ? disabled ? "disabled" : "inactive" : degraded ? "degraded" : limitReason !== "ready" ? "rate_limited" : verified ? "verified" : "armed_unverified",
    transport_alive: alive, verification: verified && alive ? "current_socket" : "unverified", manual_read_available: true,
    receiver_instance: native?.instance ?? null, lease_expires_at: null,
    reason: stopped?.reason ?? (!alive ? disabled ? "Native socket reception was explicitly disabled" : reason ?? "Run join to bind this session's supported native socket; Channel is retired" : degraded ? "Database temporarily unavailable" : limitReason !== "ready" ? limitReason : verified ? "This exact native receiver returned its nonce" : "Native inbox is present; model processing still requires a nonce reply"),
    limits, evidence: verified && alive ? proof : null, historical_evidence: value?.proof ?? null };
}
function pausePath(project: Project, member: Member, adapter?: string): string {
  requireThat(/^m_[0-9a-f-]{36}$/.test(member.id), "E_MEMBER", "Invalid member identifier");
  return join(project.room, "notifications", `${member.id}${adapter === SOCKET_ADAPTER ? ".socket" : ""}.paused.json`);
}
interface NotificationPause { reason: string; at: number; kind?: "host_blocked"; launchId?: string; source?: string; adapter?: string; roomName?: string; memberId?: string }
function sharedPausePath(project: Project, member: Member, adapter?: string): string {
  if (!member.session_ref) return pausePath(project, member, adapter);
  return join(integrationDir(project), "notification-sessions", `${member.runtime}-${sessionId(member.session_ref)}.${adapter === SOCKET_ADAPTER ? "socket" : "channel"}.json`);
}
function oldPause(project: Project, member: Member, adapter?: string): NotificationPause | null {
  const local = readJson<NotificationPause>(pausePath(project, member, adapter));
  if (local) return local;
  const old = legacyMember(project, member);
  return old ? readJson<NotificationPause>(pausePath({ ...project, room: integrationDir(project) }, old, adapter)) : null;
}
export function pause(project: Project, member: Member, reason: string, details: Omit<Partial<NotificationPause>, "reason" | "at"> = {}): void {
  const value = { ...details, reason, at: Date.now(), roomName: roomName(project), memberId: member.id };
  writeJson(sharedPausePath(project, member, details.adapter), value);
  writeJson(pausePath(project, member, details.adapter), value);
}
export function paused(project: Project, member: Member, adapter?: string): NotificationPause | null {
  const selected = adapter ?? (member.runtime === "claude" ? SOCKET_ADAPTER : "claude-channel");
  if (selected === SOCKET_ADAPTER) {
    const scoped = readJson<NotificationPause>(sharedPausePath(project, member, SOCKET_ADAPTER)) ?? oldPause(project, member, SOCKET_ADAPTER);
    if (scoped) return scoped;
    const old = readJson<NotificationPause>(sharedPausePath(project, member)) ?? oldPause(project, member);
    return old?.kind === "host_blocked" || old?.adapter === "claude-channel" ? null : old;
  }
  const value = readJson<NotificationPause>(sharedPausePath(project, member)) ?? oldPause(project, member);
  const launchId = state(project, member)?.listener?.launchId;
  if (value?.kind === "host_blocked" && launchId && value.launchId !== launchId) return null;
  return value;
}
export function resume(project: Project, member: Member): void {
  const adapter = socketBinding(project, member)?.enabled ? SOCKET_ADAPTER : undefined;
  const shared = sharedPausePath(project, member, adapter), value = readJson<NotificationPause>(shared);
  const paths = new Set([shared, pausePath(project, member, adapter)]);
  if (value?.roomName && value.memberId && /^m_[0-9a-f-]{36}$/.test(value.memberId)) paths.add(pausePath(resolveRoom(project, value.roomName), { ...member, id: value.memberId }, adapter));
  const old = legacyMember(project, member);
  if (old) paths.add(pausePath({ ...project, room: integrationDir(project) }, old, adapter));
  for (const path of paths) if (existsSync(path)) { regularFile(path); unlinkSync(path); }
}
export function uninstalled(project: Project): boolean {
  return installation(project)?.installed === false;
}
