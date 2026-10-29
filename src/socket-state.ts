import { join } from "node:path";
import { readJson, writeJson } from "./files.ts";
import { discoverPeer, validatePeer } from "./claude-peer.ts";
import type { PeerBinding } from "./claude-peer.ts";
import { requireThat } from "./errors.ts";
import type { Member, Project } from "./types.ts";
import { integrationDir } from "./project.ts";
import { sessionId } from "./identity.ts";
import { legacyMember } from "./rooms.ts";
import { pause, paused } from "./runtime.ts";

function memberId(member: Member): string {
  requireThat(/^m_[0-9a-f-]{36}$/.test(member.id), "E_MEMBER", "Invalid member identifier"); return member.id;
}
function bindingPath(project: Project, member: Member): string { return join(project.room, "socket-bindings", `${memberId(member)}.json`); }
function sessionBindingPath(project: Project, member: Member): string {
  return join(integrationDir(project), "socket-sessions", `${sessionId(member.session_ref)}.json`);
}
function optOutPath(project: Project, member: Member): string {
  return join(integrationDir(project), "socket-sessions", `${sessionId(member.session_ref)}.opt-out.json`);
}
export function socketDisabled(project: Project, member: Member): boolean {
  if (member.runtime !== "claude" || !member.session_ref) return false;
  const value = readJson<{ session: string; disabled: boolean }>(optOutPath(project, member));
  requireThat(!value || value.session === member.session_ref && typeof value.disabled === "boolean", "E_CONFIG", "Invalid native socket opt-out");
  return value?.disabled === true;
}
export function socketBinding(project: Project, member: Member): PeerBinding | null {
  if (member.runtime !== "claude" || !member.session_ref) return null;
  const shared = readJson<PeerBinding>(sessionBindingPath(project, member));
  if (shared) { requireThat(shared.session === member.session_ref, "E_IDENTITY", "Socket binding belongs to another native session"); return shared; }
  const local = readJson<PeerBinding>(bindingPath(project, member));
  if (local) return local;
  const old = legacyMember(project, member);
  return old ? readJson(join(integrationDir(project), "socket-bindings", `${memberId(old)}.json`)) : null;
}
export interface SocketProof { nonce: string; replyId: string; verifiedAt: number; hostVersion: string; adapter: string; receiverToken: string }
function proofPath(project: Project, member: Member, instance: string): string {
  requireThat(/^[0-9a-f]{64}$/.test(instance), "E_PEER", "Invalid socket instance");
  return join(project.room, "socket-proofs", memberId(member), `${instance}.json`);
}
export function socketProof(project: Project, member: Member, instance: string): SocketProof | null { return readJson(proofPath(project, member, instance)); }
export function saveSocketProof(project: Project, member: Member, proof: SocketProof): void { writeJson(proofPath(project, member, proof.receiverToken), proof); }
export function retireChannel(project: Project, member: Member): void {
  if (member.runtime === "claude" && !paused(project, member, "claude-channel"))
    pause(project, member, "channel_retired", { adapter: "claude-channel" });
}
export function automaticSocket(project: Project, member: Member, env: NodeJS.ProcessEnv = process.env, sessionStart = false): Record<string, unknown> {
  retireChannel(project, member);
  const previous = socketBinding(project, member);
  if (socketDisabled(project, member) || previous && !previous.enabled) return { enabled: false, state: "disabled", reason: "Native socket reception was explicitly disabled" };
  try {
    if (previous) {
      try { validatePeer(project, member, previous); return { enabled: true, configured: false }; }
      catch (error) {
        if (!sessionStart) throw error;
        const current = discoverPeer(project, member, env);
        requireThat(current.pid === process.ppid, "E_PEER", "Changed native process requires its own SessionStart hook or explicit socket-config rebind");
      }
    }
    return { ...configureSocket(project, member, true, false, env), enabled: true, configured: true };
  } catch (error) { return { enabled: false, state: "unavailable", reason: (error as Error).message, code: (error as { code?: string }).code }; }
}
export function configureSocket(project: Project, member: Member, apply: boolean, disable = false, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  requireThat(member.runtime === "claude", "E_IDENTITY", "Native socket experiments require an exact registered Claude member");
  const previous = socketBinding(project, member);
  if (disable) {
    if (apply) {
      writeJson(optOutPath(project, member), { session: member.session_ref, disabled: true });
      if (previous) { writeJson(sessionBindingPath(project, member), { ...previous, enabled: false }); writeJson(bindingPath(project, member), { ...previous, enabled: false }); }
    }
    return { ok: true, experimental: true, applied: apply, enabled: false, member_id: member.id, history_preserved: true, fallback_started: false };
  }
  const binding = discoverPeer(project, member, env);
  if (previous?.instance === binding.instance) binding.configuredAt = previous.configuredAt;
  const pausePath = join(project.room, "notifications", `${memberId(member)}.paused.json`);
  const stopped = paused(project, member, "claude-channel");
  requireThat(!stopped || stopped.kind === "host_blocked" || ["explicit_socket_selection", "channel_retired"].includes(stopped.reason), "E_PAUSED", "Resolve the existing uncertain notification pause before enabling socket reception; old attempts will never be reset");
  if (apply) {
    // Old already-running Channel builds also observe this pause. It is kept independently of socket pauses.
    if (!stopped) writeJson(pausePath, { reason: "explicit_socket_selection", adapter: "claude-channel", at: Date.now() });
    writeJson(bindingPath(project, member), binding);
    writeJson(sessionBindingPath(project, member), binding);
    if (socketDisabled(project, member)) writeJson(optOutPath(project, member), { session: member.session_ref, disabled: false });
  }
  return { ok: true, applied: apply, experimental: true, member_id: member.id, binding,
    reception_verified: false, old_reservations_preserved: true,
    note: "Version-checked native socket reception. Only new unreserved notifications use this adapter. Native inbound policy and tool approval remain in force; a nonce reply is still required." };
}
