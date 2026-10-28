// Explicit wall-clock integration publisher, not a business receiver or a reply poller.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { discoverProject } from "../src/project.ts";
import { identify } from "../src/identity.ts";
import { Store } from "../src/store.ts";
import { requireThat, errorResult } from "../src/errors.ts";
import { readJson, writeJson } from "../src/files.ts";
import { receiver, state } from "../src/runtime.ts";
import { notifyMember } from "../src/notify.ts";

const { values } = parseArgs({ options: { seconds: { type: "string" }, to: { type: "string" } } });
requireThat(values.seconds === "600" || values.seconds === "3600", "E_USAGE", "Use --seconds 600 or 3600 for actual idle acceptance");
const seconds = Number(values.seconds), project = discoverProject(), store = new Store(project.room);
const nonce = randomUUID(), path = join(project.room, "idle-tests", `${nonce}.json`);
try {
  const from = store.actor(identify()); requireThat(from.runtime === "codex", "E_IDENTITY", "Start idle acceptance inside the original Codex session");
  const candidates = store.members().filter(m => m.runtime === "claude");
  const to = values.to ? store.member(values.to) : candidates.length === 1 ? candidates[0]! : null;
  requireThat(to?.runtime === "claude", "E_MEMBER", "Select one exact Claude participant");
  const reception = receiver(project, to), listener = state(project, to)?.listener;
  requireThat(reception.verification === "current_channel" && ["verified", "rate_limited"].includes(String(reception.state)) && listener?.mode === "channel", "E_RECEIVER", "A fresh available real Channel nonce must pass before wall-clock acceptance");
  const baseline = store.db.query("SELECT coalesce(max(seq),0) seq FROM messages").get() as { seq: number };
  const startedAt = Date.now(), notBefore = startedAt + seconds * 1000;
  const evidence = { nonce, seconds, fromId: from.id, toId: to.id, session: to.session_ref, receiverToken: listener.token,
    launchId: listener.launchId, baselineSeq: baseline.seq, startedAt, notBefore, phase: "waiting_for_idle_interval" };
  writeJson(path, evidence); writeJson(join(project.room, "latest-idle-test.json"), { evidencePath: path });
  console.log(JSON.stringify({ ok: true, evidence: path, not_before: notBefore, seconds, note: "Only a local timer is running. Do not type in Claude. No model heartbeat and no waiting for a reply." }));
  while (Date.now() < notBefore) {
    const current = state(project, to)?.listener;
    const currentReception = receiver(project, to);
    requireThat(current?.token === listener.token && current.launchId === listener.launchId && currentReception.transport_alive && !["blocked", "paused", "inactive"].includes(String(currentReception.state)),
      "E_RECEIVER", "Claude receiver stopped or changed during the idle interval; acceptance aborted");
    const activity = store.db.query("SELECT count(*) n FROM messages WHERE from_id=? AND seq>?").get(to.id, baseline.seq) as { n: number };
    requireThat(activity.n === 0, "E_IDLE", "Claude sent another project message during the idle interval; no idle success can be claimed");
    await Bun.sleep(Math.max(1, Math.min(1000, notBefore - Date.now())));
  }
  const current = state(project, to)?.listener;
  requireThat(current?.token === listener.token && receiver(project, to).transport_alive, "E_RECEIVER", "Original Channel is no longer available");
  const requestId = `idle-${nonce}`;
  const sent = store.send({ from: from.id, to: to.id, id: requestId, notify: true,
    body: `Authorized AgentChat wall-clock idle test after ${seconds} seconds, in this exact native session. Read through your project CLI and return the test result by replying to ${requestId}, with stable ID idle-result-${nonce}, --notify, and exact text idle-result:${nonce}. This is the substantive test result that wakes the original Codex session for verification; Codex must not acknowledge it with another notification. Mark only messages actually read. Do not edit code, settings, permissions or other files, and do not wait for another reply. End your turn after sending the result.` });
  writeJson(path, { ...evidence, phase: "request_stored", requestId, sentAt: sent.message.created_at, notification: notifyMember(store, project, to) });
  console.log(JSON.stringify({ ok: true, evidence: path, request_id: requestId, note: "Publisher exits now. Use the passive verifier later; submission alone is not reception proof." }));
} catch (error) {
  const previous = readJson<Record<string, unknown>>(path);
  if (previous) writeJson(path, { ...previous, phase: "failed", diagnostic: errorResult(error) });
  console.error(JSON.stringify(errorResult(error))); process.exitCode = 2;
} finally { store.close(); }
