// Explicit wall-clock integration publisher, not a business receiver or a reply poller.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { discoverProject } from "../src/project.ts";
import { identify } from "../src/identity.ts";
import { Store } from "../src/store.ts";
import { requireThat, errorResult } from "../src/errors.ts";
import { readJson, writeJson } from "../src/files.ts";
import { receiver } from "../src/runtime.ts";
import { notifyMember } from "../src/notify.ts";
import { socketBinding } from "../src/socket-state.ts";
import { peerActivity } from "../src/claude-peer.ts";
import type { Member } from "../src/types.ts";
import { resolveRoom } from "../src/rooms.ts";

const { values } = parseArgs({ options: { seconds: { type: "string" }, to: { type: "string" }, room: { type: "string" } } });
requireThat(values.seconds === "600" || values.seconds === "3600", "E_USAGE", "Use --seconds 600 or 3600 for actual idle acceptance");
const seconds = Number(values.seconds), project = resolveRoom(discoverProject(), values.room, identify()), store = new Store(project.room);
const nonce = randomUUID(), path = join(project.room, "idle-tests", `${nonce}.json`);
let coordinator: Member | undefined;
try {
  const from = store.actor(identify()); requireThat(from.runtime === "codex", "E_IDENTITY", "Start idle acceptance inside the original Codex session");
  coordinator = from;
  const candidates = store.members().filter(m => m.runtime === "claude");
  const to = values.to ? store.member(values.to) : candidates.length === 1 ? candidates[0]! : null;
  requireThat(to?.runtime === "claude", "E_MEMBER", "Select one exact Claude participant");
  const reception = receiver(project, to), instance = reception.receiver_instance;
  requireThat(["current_channel", "current_socket"].includes(String(reception.verification)) && ["verified", "rate_limited"].includes(String(reception.state)) && typeof instance === "string", "E_RECEIVER", "A fresh available real receiver nonce must pass before wall-clock acceptance");
  const baseline = store.db.query("SELECT coalesce(max(seq),0) seq FROM messages").get() as { seq: number };
  const native = socketBinding(project, to);
  const nativeBaseline = native?.enabled ? peerActivity(native) : null;
  if (nativeBaseline) requireThat(nativeBaseline.status === "idle" && Number.isFinite(nativeBaseline.updatedAt), "E_IDLE", "Wait until the exact native Claude session is idle before starting acceptance");
  const startedAt = Date.now(), notBefore = startedAt + seconds * 1000;
  const evidence = { nonce, seconds, fromId: from.id, toId: to.id, session: to.session_ref, receiverToken: instance,
    adapter: reception.mode, nativeStatusUpdatedAt: nativeBaseline?.updatedAt ?? null, baselineSeq: baseline.seq, startedAt, notBefore, phase: "waiting_for_idle_interval" };
  writeJson(path, evidence); writeJson(join(project.room, "latest-idle-test.json"), { evidencePath: path });
  console.log(JSON.stringify({ ok: true, evidence: path, not_before: notBefore, seconds, note: "Only a local timer is running. Do not type in Claude. No model heartbeat and no waiting for a reply." }));
  while (Date.now() < notBefore) {
    const currentReception = receiver(project, to);
    requireThat(currentReception.receiver_instance === instance && currentReception.mode === reception.mode && currentReception.transport_alive && !["blocked", "paused", "inactive"].includes(String(currentReception.state)),
      "E_RECEIVER", "Claude receiver stopped or changed during the idle interval; acceptance aborted");
    const activity = store.db.query("SELECT count(*) n FROM messages WHERE from_id=? AND seq>?").get(to.id, baseline.seq) as { n: number };
    requireThat(activity.n === 0, "E_IDLE", "Claude sent another project message during the idle interval; no idle success can be claimed");
    if (nativeBaseline && native) {
      const status = peerActivity(native);
      requireThat(status.status === "idle" && status.updatedAt === nativeBaseline.updatedAt, "E_IDLE", "Native Claude activity changed during the idle interval; do not claim an uninterrupted idle test");
    }
    await Bun.sleep(Math.max(1, Math.min(10000, notBefore - Date.now())));
  }
  const current = receiver(project, to);
  requireThat(current.receiver_instance === instance && current.transport_alive, "E_RECEIVER", "Original receiver is no longer available");
  if (nativeBaseline && native) { const status = peerActivity(native); requireThat(status.status === "idle" && status.updatedAt === nativeBaseline.updatedAt, "E_IDLE", "Native idle evidence changed at submission"); }
  const requestId = `idle-${nonce}`;
  const sent = store.send({ from: from.id, to: to.id, id: requestId, notify: true,
    body: `Authorized AgentChat wall-clock idle test after ${seconds} seconds, in this exact native session. Read through your project CLI and return the test result by replying to ${requestId}, with stable ID idle-result-${nonce}, --notify, and exact text idle-result:${nonce}. This is the substantive test result that wakes the original Codex session for verification; Codex must not acknowledge it with another notification. Mark only messages actually read. Do not edit code, settings, permissions or other files, and do not wait for another reply. End your turn after sending the result.` });
  writeJson(path, { ...evidence, phase: "request_stored", requestId, sentAt: sent.message.created_at, notification: await notifyMember(store, project, to) });
  console.log(JSON.stringify({ ok: true, evidence: path, request_id: requestId, note: "Publisher exits now. Use the passive verifier later; submission alone is not reception proof." }));
} catch (error) {
  const previous = readJson<Record<string, unknown>>(path);
  if (previous) writeJson(path, { ...previous, phase: "failed", diagnostic: errorResult(error) });
  if (coordinator && previous) {
    try {
      const reporter = store.join({ runtime: "generic", session: null }, "agentchat-probe");
      store.send({ from: reporter.id, to: coordinator.id, id: `idle-failed-${nonce}`, notify: true,
        body: `Authorized AgentChat idle acceptance stopped without success. Nonce: ${nonce}. Read the existing private evidence at ${path}; do not retry or advance to another stage automatically. ${JSON.stringify(errorResult(error))}` });
      await notifyMember(store, project, coordinator);
    } catch { /* Failure evidence remains durable if the coordinator cannot be notified. */ }
  }
  console.error(JSON.stringify(errorResult(error))); process.exitCode = 2;
} finally { store.close(); }
