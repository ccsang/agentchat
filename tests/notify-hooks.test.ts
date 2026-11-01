import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { cli, fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { dispatchCodex, paused, resume } from "../src/notify.ts";
import { registerHook, waitHook } from "../src/hooks.ts";
import { writeJson } from "../src/files.ts";
import { receiver, state, sessionPath } from "../src/runtime.ts";
import { recordProbeReply, startProbe } from "../src/probe.ts";
import type { Member } from "../src/types.ts";
import { inspectCodex } from "../src/notify.ts";

let cleanups: (() => void)[];
let f: ReturnType<typeof fixture>, store: Store, a: Member, b: Member;
beforeEach(() => { cleanups = []; f = fixture(); store = new Store(f.project.room, { create: true }); a = store.join(nativeIdentity(), "a"); b = store.join(nativeIdentity("claude"), "b"); });
afterEach(() => { for (const close of cleanups.reverse()) close(); store.close(); f.cleanup(); });
function hook(event: string) { return { session_id: b.session_ref!, cwd: f.root, hook_event_name: event }; }
function config(extra: Record<string, unknown> = {}) { writeJson(join(f.project.room, "config.json"), { budget: 20, windowSeconds: 600, autoJoin: false, ...extra }); }
function fakeCodex(body: string): string {
  const file = join(f.root, "codex-fixture");
  writeFileSync(file, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2); if(a.includes('--help')) {console.log('--thread --message'); process.exit(0);} if(a.includes('--version')) {console.log('codex-cli fixture'); process.exit(0);}\nappendFileSync(${JSON.stringify(join(f.root, "attempts"))},'accepted\\n');\n${body}\n`, { mode: 0o755 });
  config({ codexBin: file }); return file;
}
test("already loaded Stop hooks retire immediately without reserving messages or waking the model", async () => {
  config(); store.send({ from: a.id, to: b.id, notify: true, body: "keep pending" });
  expect(await waitHook(f.project, hook("Stop"))).toEqual({ exitCode: 0, reason: "hook_receiver_retired" });
  expect(store.message(store.read(0).messages[0]!.id).notify_batch_id).toBeNull();
  expect(receiver(f.project, b).state).toBe("inactive");
});
test("wrong project and subagent hook contexts are rejected", () => {
  expect(() => registerHook(f.project, { ...hook("SessionStart"), cwd: "/" }, {})).toThrow();
  expect(() => registerHook(f.project, { ...hook("SessionStart"), agent_id: "subagent" }, {})).toThrow("Subagent");
});
test("default SessionStart records context but does not enroll every session", () => {
  config(); const unknown = nativeIdentity("claude").session;
  registerHook(f.project, { ...hook("SessionStart"), session_id: unknown }, {});
  expect(store.members()).toHaveLength(2);
});
test("malformed managed hook arguments cannot emit the rewake exit status", () => {
  const result = cli(f.root, ["--agentchat-managed=v1", "hook", "wait", "--unknown"], testEnv());
  expect(result.status).toBe(1); expect(result.data.error.code).toBe("E_USAGE");
});
test("Codex accepted receipt records submission only and never sends body", () => {
  fakeCodex("console.log('Queued message accepted123 for thread '+a[a.indexOf('--thread')+1]+'.');");
  store.send({ from: b.id, to: a.id, notify: true, body: "untrusted body" });
  const result = dispatchCodex(store, f.project, a); expect(result.state).toBe("submitted"); expect(result.processed).toBe(false);
  expect(dispatchCodex(store, f.project, a).state).toBe("held");
});
test("Codex doctor separates queue capability from a missing reverse nonce proof without sending a notification", () => {
  fakeCodex("console.log('Queued message accepted123 for thread '+a[a.indexOf('--thread')+1]+'.');");
  const before = readFileSync(join(f.project.room, "chat.db"));
  const first = cli(f.root, ["doctor", "--as", a.id]);
  expect(first.status).toBe(0);
  expect(first.data.reception).toMatchObject({ state: "unverified", verification: "unverified", reason_code: "no_nonce_proof", transport_alive: null,
    transport: { state: "available", scope: "command_capability", exact_session_reachable: null }, evidence: null });
  expect(first.data.reception.reason).toContain("nonce"); expect(first.data.reception.verification_action.hint).toContain("reverse");
  expect(first.data.reception.verification_action.argv).toEqual([join(f.project.room, "run"), "--project", f.root, "--room", "default", "probe", "--to", a.id]);
  expect(existsSync(join(f.root, "attempts"))).toBe(false); expect(readFileSync(join(f.project.room, "chat.db"))).toEqual(before);
  store.send({ from: b.id, to: a.id, id: "queue-receipt-only", body: "fixture", notify: true });
  expect(dispatchCodex(store, f.project, a).state).toBe("submitted");
  const after = cli(f.root, ["doctor", "--as", a.id]);
  expect(after.data.reception.reason_code).toBe("no_nonce_proof"); expect(after.data.reception.evidence).toBeNull();
  expect(readFileSync(join(f.root, "attempts"), "utf8")).toBe("accepted\n"); expect(store.member(a.id).read_seq).toBe(0);
});
test("Codex doctor reports a missing queue separately from missing nonce proof", () => {
  config({ codexBin: join(f.root, "absent") });
  const result = cli(f.root, ["doctor", "--as", a.id]);
  expect(result.data.reception).toMatchObject({ state: "unverified", reason_code: "no_nonce_proof", transport_alive: null,
    transport: { state: "unavailable", scope: "command_capability", exact_session_reachable: null } });
  expect(existsSync(join(f.root, "attempts"))).toBe(false);
});
test("Codex cannot inherit another adapter or session's stored nonce proof", () => {
  const proof = { nonce: "fixture", replyId: "fixture", verifiedAt: Date.now(), hostVersion: "fixture", adapter: "codex-queue" };
  for (const extra of [{ session: b.session_ref! }, { memberId: b.id }, { proof: { ...proof, adapter: "claude-channel" } }, { proof: { ...proof, nonce: "" } }]) {
    writeJson(sessionPath(f.project, a.session_ref!), { session: a.session_ref!, memberId: a.id, active: true, proof, ...extra });
    expect(receiver(f.project, a)).toMatchObject({ state: "unverified", reason_code: "no_nonce_proof", evidence: null });
  }
});
test("post-accept CLI error is unknown and pauses future notifications persistently", () => {
  fakeCodex("process.exit(1);"); store.send({ from: b.id, to: a.id, notify: true, body: "first" });
  expect(dispatchCodex(store, f.project, a).state).toBe("unknown"); expect(paused(f.project, a)?.reason).toBe("queue_outcome_unknown");
  store.send({ from: b.id, to: a.id, notify: true, body: "second" });
  store.close(); store = new Store(f.project.room); expect(dispatchCodex(store, f.project, a).state).toBe("paused");
  resume(f.project, a); expect(paused(f.project, a)).toBeNull();
  expect(store.db.query("SELECT count(*) n FROM messages WHERE notify_batch_id IS NOT NULL").get()).toEqual({ n: 1 });
});
test("exit zero without an exact valid receipt is still unknown", () => {
  fakeCodex("console.log('success');"); store.send({ from: b.id, to: a.id, notify: true, body: "first" });
  expect(dispatchCodex(store, f.project, a).state).toBe("unknown");
});
test("unavailable CLI does not consume a notification reservation", () => {
  config({ codexBin: join(f.root, "absent") }); store.send({ from: b.id, to: a.id, notify: true, body: "first" });
  expect(dispatchCodex(store, f.project, a).state).toBe("unavailable");
  expect(store.db.query("SELECT count(*) n FROM messages WHERE notify_batch_id IS NOT NULL").get()).toEqual({ n: 0 });
});
test("timeout after attempting submission is unknown and never automatically retried", () => {
  fakeCodex("setInterval(()=>{},1000); await new Promise(()=>{});");
  store.send({ from: b.id, to: a.id, notify: true, body: "first" });
  expect(dispatchCodex(store, f.project, a).state).toBe("unknown"); expect(paused(f.project, a)).not.toBeNull();
}, 10000);
test("nonce proof requires a reply from the exact intended native member", async () => {
  fakeCodex("console.log('Queued message accepted123 for thread '+a[a.indexOf('--thread')+1]+'.');"); const probe = await startProbe(store, f.project, a); const id = probe.message_id as string, nonce = probe.nonce as string;
  const wrong = store.send({ from: b.id, replyTo: id, body: nonce }).message; recordProbeReply(store, f.project, wrong, { runtime: a.runtime, session: a.session_ref });
  expect(state(f.project, a)?.proof).toBeUndefined();
  const right = store.send({ from: a.id, replyTo: id, body: nonce }).message;
  recordProbeReply(store, f.project, right, { runtime: b.runtime, session: b.session_ref }); expect(state(f.project, a)?.proof).toBeUndefined();
  recordProbeReply(store, f.project, right, { runtime: a.runtime, session: a.session_ref });
  expect(state(f.project, a)?.proof?.replyId).toBe(right.id);
  expect(receiver(f.project, a).state).toBe("verified");
});
test("a probe queued during a long native turn remains valid; retries preserve the first reply timestamp", async () => {
  fakeCodex("console.log('Queued message accepted123 for thread '+a[a.indexOf('--thread')+1]+'.');"); const probe = await startProbe(store, f.project, a), id = probe.message_id as string;
  const path = join(f.project.room, "probes", `${id}.json`);
  const metadata = JSON.parse(readFileSync(path, "utf8")); metadata.createdAt = Date.now() - 3600000;
  writeJson(path, metadata);
  const reply = store.send({ from: a.id, replyTo: id, body: probe.nonce as string, now: Date.now() - 1000 }).message;
  const identity = { runtime: a.runtime, session: a.session_ref };
  recordProbeReply(store, f.project, reply, identity); expect(state(f.project, a)?.proof?.replyId).toBe(reply.id);
  recordProbeReply(store, f.project, reply, identity); expect(state(f.project, a)?.proof?.verifiedAt).toBe(reply.created_at);
});
test("inactive Claude cannot claim a native probe", async () => {
  config(); await expect(startProbe(store, f.project, b)).rejects.toThrow("supported native socket");
});
test("fake binary probes are isolated from user clients", () => {
  const path = fakeCodex("process.exit(0)"); expect(inspectCodex(path)?.version).toBe("codex-cli fixture");
  expect(existsSync(join(f.root, "attempts"))).toBe(false);
  expect(testEnv().CODEX_THREAD_ID).toBeUndefined();
});
