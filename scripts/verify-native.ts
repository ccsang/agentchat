// Passive verifier: reads recorded messages only; never contacts a native client.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { discoverProject } from "../src/project.ts";
import { readJson } from "../src/files.ts";
import { Store } from "../src/store.ts";
import { requireThat } from "../src/errors.ts";
import type { Message } from "../src/types.ts";

const { values } = parseArgs({ options: { evidence: { type: "string" } } });
const project = discoverProject();
const path = values.evidence ?? readJson<{ evidencePath: string }>(join(project.room, "latest-native-test.json"))?.evidencePath;
requireThat(path, "E_PROBE", "No native integration test has been started");
const evidence = readJson<{ nonce: string; requestId: string; reverseId: string; fromId: string; toId: string }>(path);
requireThat(evidence, "E_PROBE", "Native evidence not found");
const store = new Store(project.room, { readonly: true });
try {
  const all = store.db.query("SELECT * FROM messages ORDER BY seq").all() as Message[];
  const forward = all.find(m => m.id === evidence.requestId && m.from_id === evidence.fromId && m.to_id === evidence.toId);
  const ack = all.find(m => m.reply_to === evidence.requestId && m.from_id === evidence.toId && m.to_id === evidence.fromId && m.body === `claude-ack:${evidence.nonce}`);
  const reverse = all.find(m => m.id === evidence.reverseId && m.from_id === evidence.toId && m.to_id === evidence.fromId);
  const reply = all.find(m => m.reply_to === evidence.reverseId && m.from_id === evidence.fromId && m.to_id === evidence.toId && m.body === `codex-ack:${evidence.nonce}`);
  const done = reply && all.find(m => m.reply_to === reply.id && m.from_id === evidence.toId && m.to_id === evidence.fromId && m.body === `done:${evidence.nonce}` && !m.notify);
  const steps = { codex_request: !!forward, claude_reply: !!ack, claude_request: !!reverse, codex_reply: !!reply, claude_final_confirmation: !!done };
  const complete = Object.values(steps).every(Boolean);
  console.log(JSON.stringify({ ok: complete, evidence: path, nonce: evidence.nonce, steps, message_ids: [forward, ack, reverse, reply, done].filter(Boolean).map(m => m!.id),
    note: "Message correlation evidence must be read with native-session transcript/queue evidence; database rows alone do not prove automatic reception." }));
  process.exitCode = complete ? 0 : 2;
} finally { store.close(); }
