// Passive correlation only. Native-session observation remains part of acceptance.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { discoverProject } from "../src/project.ts";
import { readJson } from "../src/files.ts";
import { Store } from "../src/store.ts";
import { requireThat } from "../src/errors.ts";
import type { Message } from "../src/types.ts";
import { receiver } from "../src/runtime.ts";

const { values } = parseArgs({ options: { evidence: { type: "string" } } });
const project = discoverProject();
const path = values.evidence ?? readJson<{ evidencePath: string }>(join(project.room, "latest-idle-test.json"))?.evidencePath;
requireThat(path, "E_PROBE", "No idle test evidence exists");
const evidence = readJson<{ phase: string; nonce: string; seconds: number; fromId: string; toId: string; requestId?: string;
  startedAt: number; notBefore: number; sentAt?: number; baselineSeq: number; receiverToken: string; adapter: string }>(path);
requireThat(evidence, "E_PROBE", "Idle evidence not found");
const store = new Store(project.room, { readonly: true });
try {
  const request = evidence.requestId ? store.message(evidence.requestId) : null;
  const reply = request ? store.db.query("SELECT * FROM messages WHERE reply_to=? AND from_id=? AND to_id=? AND body=? AND notify=1 ORDER BY seq LIMIT 1")
    .get(request.id, evidence.toId, evidence.fromId, `idle-result:${evidence.nonce}`) as Message | null : null;
  const current = receiver(project, store.member(evidence.toId));
  const steps = { publisher_completed: evidence.phase === "request_stored", real_idle_interval: !!request && request.created_at >= evidence.notBefore && request.created_at - evidence.startedAt >= evidence.seconds * 1000,
    original_receiver_present: current.transport_alive === true && current.receiver_instance === evidence.receiverToken && current.mode === evidence.adapter,
    exact_request: request?.from_id === evidence.fromId && request?.to_id === evidence.toId,
    exact_reply: !!reply && reply.created_at >= request!.created_at };
  const complete = Object.values(steps).every(Boolean);
  console.log(JSON.stringify({ ok: complete, evidence: path, phase: evidence.phase, seconds: evidence.seconds, steps,
    reply_id: reply?.id ?? null, note: "Read with the original native-session evidence and observation of no user input. Correlation or a running process alone does not prove automatic processing." }));
  process.exitCode = complete ? 0 : 2;
} finally { store.close(); }
