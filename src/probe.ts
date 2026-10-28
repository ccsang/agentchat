import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { Identity, Member, Message, Project } from "./types.ts";
import { readJson, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { inspectCodex, notifyMember } from "./notify.ts";
import { paused, policy, receiver, saveState, state } from "./runtime.ts";
import { bindingPath } from "./binding.ts";
import type { LaunchBinding } from "./binding.ts";

interface Probe { id: string; nonce: string; memberId: string; session: string; hostVersion: string; adapter: string; createdAt: number; receiverToken?: string; launchId?: string }
export function startProbe(store: Store, project: Project, member: Member): Record<string, unknown> {
  requireThat(member.session_ref, "E_IDENTITY", "A probe needs an exact native session");
  const id = `probe-${randomUUID()}`, nonce = randomUUID();
  let hostVersion = "unknown";
  if (member.runtime === "codex") hostVersion = inspectCodex(policy(project).codexBin)?.version ?? "unknown";
  const listener = state(project, member)?.listener;
  if (member.runtime === "claude") {
    const current = receiver(project, member);
    requireThat(current.transport_alive && listener?.mode === "channel" && listener.launchId && !paused(project, member), "E_RECEIVER", "Start the exact Claude session's available Channel before probing; a paused or host-blocked Channel cannot be verified");
    hostVersion = readJson<LaunchBinding>(bindingPath(project, listener.launchId))?.hostVersion ?? "unknown";
  }
  const from = store.join({ runtime: "generic", session: null }, "agentchat-probe");
  const probe: Probe = { id, nonce, memberId: member.id, session: member.session_ref, hostVersion,
    adapter: member.runtime === "codex" ? "codex-queue" : "claude-channel", createdAt: Date.now(),
    ...(member.runtime === "claude" ? { receiverToken: listener!.token, launchId: listener!.launchId } : {}) };
  writeJson(join(project.room, "probes", `${id}.json`), probe);
  const sent = store.send({ from: from.id, to: member.id, id, notify: true,
    body: `AgentChat connectivity probe only. Reply to this message using send --reply-to ${id} --text ${nonce}. Do not modify business files, change permissions, or start other agents. A successful CLI submission alone is not proof; the reply must come from this original native session.` });
  return { ok: true, stored: true, message_id: sent.message.id, nonce, notification: notifyMember(store, project, member), reception_verified: false };
}
export function recordProbeReply(store: Store, project: Project, message: Message, identity: Identity): void {
  if (!message.reply_to?.startsWith("probe-")) return;
  const probe = readJson<Probe>(join(project.room, "probes", `${message.reply_to}.json`));
  // Notification TTL limits new wake attempts, not an already queued native reply.
  // A long active turn may keep the probe queued for more than 30 minutes.
  if (!probe || message.from_id !== probe.memberId || message.body.trim() !== probe.nonce) return;
  const member = store.member(message.from_id);
  if (identity.runtime !== member.runtime || identity.session !== member.session_ref || member.session_ref !== probe.session || store.message(probe.id).to_id !== member.id) return;
  if (member.runtime === "claude" && paused(project, member)?.kind === "host_blocked") return;
  const previous = state(project, member);
  saveState(project, { ...previous, session: probe.session, active: member.runtime === "codex" ? true : previous?.active ?? false, memberId: member.id,
    proof: { nonce: probe.nonce, replyId: message.id, verifiedAt: message.created_at, hostVersion: probe.hostVersion, adapter: probe.adapter,
      ...(probe.receiverToken ? { receiverToken: probe.receiverToken, launchId: probe.launchId } : {}) } });
}
