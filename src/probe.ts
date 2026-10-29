import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { Identity, Member, Message, Project } from "./types.ts";
import { readJson, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { inspectCodex, notifyMember } from "./notify.ts";
import { paused, policy, saveState, state } from "./runtime.ts";
import { canonicalSocketPath, SOCKET_ADAPTER, validatePeer } from "./claude-peer.ts";
import { saveSocketProof, socketBinding } from "./socket-state.ts";
import { memberRoomSelected } from "./rooms.ts";

interface Probe { id: string; nonce: string; memberId: string; session: string; hostVersion: string; adapter: string; createdAt: number; receiverToken?: string; launchId?: string }
export async function startProbe(store: Store, project: Project, member: Member): Promise<Record<string, unknown>> {
  requireThat(member.session_ref, "E_IDENTITY", "A probe needs an exact native session");
  requireThat(memberRoomSelected(project, member), "E_ROOM", "This native session selected another room; select this room before probing");
  const id = `probe-${randomUUID()}`, nonce = randomUUID();
  let hostVersion = "unknown";
  if (member.runtime === "codex") hostVersion = inspectCodex(policy(project).codexBin)?.version ?? "unknown";
  const native = socketBinding(project, member);
  if (member.runtime === "claude" && native?.enabled) {
    validatePeer(project, member, native);
    requireThat(!paused(project, member), "E_RECEIVER", "Resolve the native socket notification pause before probing");
    hostVersion = native.version;
  } else requireThat(member.runtime !== "claude", "E_RECEIVER", "Claude needs its supported native socket before probing; run join and doctor");
  const from = store.join({ runtime: "generic", session: null }, "agentchat-probe");
  const probe: Probe = { id, nonce, memberId: member.id, session: member.session_ref, hostVersion,
    adapter: member.runtime === "codex" ? "codex-queue" : SOCKET_ADAPTER, createdAt: Date.now(),
    ...(native?.enabled ? { receiverToken: native.instance } : {}) };
  writeJson(join(project.room, "probes", `${id}.json`), probe);
  const sent = store.send({ from: from.id, to: member.id, id, notify: true,
    body: `AgentChat connectivity probe only. Reply to this message using send --reply-to ${id} --text ${nonce}. Do not modify business files, change permissions, or start other agents. A successful CLI submission alone is not proof; the reply must come from this original native session.` });
  return { ok: true, stored: true, message_id: sent.message.id, nonce, notification: await notifyMember(store, project, member), reception_verified: false };
}
export function recordProbeReply(store: Store, project: Project, message: Message, identity: Identity, env: NodeJS.ProcessEnv = process.env): void {
  if (!message.reply_to?.startsWith("probe-")) return;
  const probe = readJson<Probe>(join(project.room, "probes", `${message.reply_to}.json`));
  // Notification TTL limits new wake attempts, not an already queued native reply.
  // A long active turn may keep the probe queued for more than 30 minutes.
  if (!probe || message.from_id !== probe.memberId || message.body.trim() !== probe.nonce) return;
  const member = store.member(message.from_id);
  if (identity.runtime !== member.runtime || identity.session !== member.session_ref || member.session_ref !== probe.session || store.message(probe.id).to_id !== member.id) return;
  if (member.runtime === "claude" && probe.adapter !== SOCKET_ADAPTER) return;
  if (probe.adapter === SOCKET_ADAPTER) {
    const binding = socketBinding(project, member), ownSocket = env.CLAUDE_CODE_MESSAGING_SOCKET?.replace(/^uds:/, "");
    if (!binding?.enabled || binding.instance !== probe.receiverToken || !ownSocket) return;
    try { validatePeer(project, member, binding); if (canonicalSocketPath(ownSocket) !== binding.realSocketPath) return; } catch { return; }
    saveSocketProof(project, member, { nonce: probe.nonce, replyId: message.id, verifiedAt: message.created_at,
      hostVersion: probe.hostVersion, adapter: SOCKET_ADAPTER, receiverToken: binding.instance });
    return;
  }
  const previous = state(project, member);
  saveState(project, { ...previous, session: probe.session, active: member.runtime === "codex" ? true : previous?.active ?? false, memberId: member.id,
    proof: { nonce: probe.nonce, replyId: message.id, verifiedAt: message.created_at, hostVersion: probe.hostVersion, adapter: probe.adapter,
      ...(probe.receiverToken ? { receiverToken: probe.receiverToken, launchId: probe.launchId } : {}) } });
}
