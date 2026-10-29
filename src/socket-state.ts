import { join } from "node:path";
import { readJson, writeJson } from "./files.ts";
import { discoverPeer } from "./claude-peer.ts";
import type { PeerBinding } from "./claude-peer.ts";
import { requireThat } from "./errors.ts";
import type { Member, Project } from "./types.ts";
import { integrationDir } from "./project.ts";
import { sessionId } from "./identity.ts";
import { legacyMember } from "./rooms.ts";
import { paused } from "./runtime.ts";

function memberId(member: Member): string {
  requireThat(/^m_[0-9a-f-]{36}$/.test(member.id), "E_MEMBER", "Invalid member identifier"); return member.id;
}
function bindingPath(project: Project, member: Member): string { return join(project.room, "socket-bindings", `${memberId(member)}.json`); }
function sessionBindingPath(project: Project, member: Member): string {
  return join(integrationDir(project), "socket-sessions", `${sessionId(member.session_ref)}.json`);
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
export function configureSocket(project: Project, member: Member, apply: boolean, disable = false): Record<string, unknown> {
  requireThat(member.runtime === "claude", "E_IDENTITY", "Native socket experiments require an exact registered Claude member");
  const previous = socketBinding(project, member);
  if (disable) {
    if (apply && previous) { writeJson(sessionBindingPath(project, member), { ...previous, enabled: false }); writeJson(bindingPath(project, member), { ...previous, enabled: false }); }
    return { ok: true, experimental: true, applied: apply, enabled: false, member_id: member.id, history_preserved: true, fallback_started: false };
  }
  const binding = discoverPeer(project, member);
  if (previous?.instance === binding.instance) binding.configuredAt = previous.configuredAt;
  const pausePath = join(project.room, "notifications", `${memberId(member)}.paused.json`);
  const stopped = paused(project, member, "claude-channel");
  requireThat(!stopped || stopped.kind === "host_blocked" || stopped.reason === "explicit_socket_selection", "E_PAUSED", "Resolve the existing uncertain notification pause before selecting another adapter; old attempts will never be reset");
  if (apply) {
    // Old already-running Channel builds also observe this pause. It is kept independently of socket pauses.
    if (!stopped) writeJson(pausePath, { reason: "explicit_socket_selection", adapter: "claude-channel", at: Date.now() });
    writeJson(bindingPath(project, member), binding);
    writeJson(sessionBindingPath(project, member), binding);
  }
  return { ok: true, applied: apply, experimental: true, member_id: member.id, binding,
    reception_verified: false, old_reservations_preserved: true,
    note: "Explicit native socket experiment. Only new unreserved notifications use this adapter. Native inbound policy and tool approval remain in force; a nonce reply is still required." };
}
