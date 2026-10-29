// Explicit integration entry point. Never imported by the normal test suite.
import { parseArgs } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverProject } from "../src/project.ts";
import { identify } from "../src/identity.ts";
import { Store } from "../src/store.ts";
import { requireThat } from "../src/errors.ts";
import { writeJson } from "../src/files.ts";
import { notifyMember } from "../src/notify.ts";
import { receiver } from "../src/runtime.ts";

const { values } = parseArgs({ options: { to: { type: "string" } } });
const project = discoverProject(); const store = new Store(project.room);
try {
  const from = store.actor(identify());
  requireThat(from.runtime === "codex", "E_IDENTITY", "Start this test inside the original Codex session");
  const candidates = store.members().filter(member => member.runtime === "claude");
  const to = values.to ? store.member(values.to) : candidates.length === 1 ? candidates[0]! : null;
  requireThat(to?.runtime === "claude", "E_MEMBER", "Select one exact Claude test participant");
  requireThat(["armed_unverified", "verified"].includes(String(receiver(project, to).state)), "E_RECEIVER", "Claude receiver is inactive; no test message has been sent");
  const nonce = randomUUID(), requestId = `native-forward-${nonce}`, reverseId = `native-reverse-${nonce}`;
  const body = `This is the user's authorized AgentChat integration test only. Do not edit code, configuration, business files or permissions.\n1. Reply to ${requestId} with --notify and body claude-ack:${nonce}.\n2. Send a separate directed request to ${from.name}, with --notify and ID ${reverseId}. Ask Codex to reply to ${reverseId} with --notify and exact body codex-ack:${nonce}. Include this final instruction in that reverse request: after Claude receives codex-ack:${nonce}, reply to that reply's message ID with exact body done:${nonce}, WITHOUT --notify.\nEnd your turn after sending; never wait in a shell. Reply through your own native identity, without --as overrides.`;
  const sent = store.send({ from: from.id, to: to.id, id: requestId, body, notify: true });
  const evidencePath = join(project.room, "native-tests", `${nonce}.json`);
  writeJson(evidencePath, { nonce, requestId, reverseId, fromId: from.id, toId: to.id, startedAt: Date.now() });
  writeJson(join(project.room, "latest-native-test.json"), { evidencePath });
  console.log(JSON.stringify({ ok: true, evidence: evidencePath, request_id: sent.message.id, notification: await notifyMember(store, project, to), verified: false }));
} finally { store.close(); }
