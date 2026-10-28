import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "./store.ts";
import type { Identity, Member, Message, Project } from "./types.ts";
import { readJson, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { inspectCodex, notifyMember } from "./notify.ts";
import { policy, saveState, state } from "./runtime.ts";

interface Probe { id: string; nonce: string; memberId: string; session: string; hostVersion: string; adapter: string; createdAt: number }
export function startProbe(store: Store, project: Project, member: Member): Record<string, unknown> {
  requireThat(member.session_ref, "E_IDENTITY", "A probe needs an exact native session");
  const id = `probe-${randomUUID()}`, nonce = randomUUID();
  let hostVersion = "unknown";
  if (member.runtime === "codex") hostVersion = inspectCodex(policy(project).codexBin)?.version ?? "unknown";
  if (member.runtime === "claude") {
    const result = spawnSync(Bun.which("claude") ?? "claude", ["--version"], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
    if (result.status === 0) hostVersion = result.stdout.trim();
  }
  const from = store.join({ runtime: "generic", session: null }, "agentchat-probe");
  const probe: Probe = { id, nonce, memberId: member.id, session: member.session_ref, hostVersion, adapter: member.runtime === "codex" ? "codex-queue" : "claude-receiver", createdAt: Date.now() };
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
  saveState(project, { ...state(project, member), session: probe.session, active: true, memberId: member.id,
    proof: { nonce: probe.nonce, replyId: message.id, verifiedAt: message.created_at, hostVersion: probe.hostVersion, adapter: probe.adapter } });
}
