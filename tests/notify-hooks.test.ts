import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { cli, fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { dispatchCodex, paused, resume } from "../src/notify.ts";
import { registerHook, waitHook, endHook } from "../src/hooks.ts";
import { fixtureLaunch as createLaunch } from "./helpers.ts";
import { tryLock } from "../src/lock.ts";
import { privateDirectory, writeJson } from "../src/files.ts";
import { receiver, saveState, state, listenerLock, reportChannelUnavailable } from "../src/runtime.ts";
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
function arm() {
  const launch = createLaunch(f.project, b.session_ref, "Claude fixture"); cleanups.push(launch.close);
  registerHook(f.project, hook("SessionStart"), launch.env);
  privateDirectory(join(f.project.room, "listeners")); const release = tryLock(listenerLock(f.project, b))!; cleanups.push(release);
  saveState(f.project, { ...state(f.project, b), session: b.session_ref!, active: true,
    listener: { pid: process.pid, token: randomUUID(), mode: "channel", launchId: launch.binding.id, expiresAt: Date.now() + 30000 } });
  return launch;
}
test("already loaded Stop hooks retire immediately without reserving messages or waking the model", async () => {
  config(); store.send({ from: a.id, to: b.id, notify: true, body: "keep pending" });
  expect(await waitHook(f.project, hook("Stop"))).toEqual({ exitCode: 0, reason: "hook_receiver_retired" });
  expect(store.message(store.read(0).messages[0]!.id).notify_batch_id).toBeNull();
  expect(receiver(f.project, b).state).toBe("inactive");
});
test("SessionEnd removes the active Channel capability", () => {
  config(); const launch = arm(); expect(receiver(f.project, b).state).toBe("armed_unverified");
  endHook(f.project, hook("SessionEnd"), launch.env); expect(receiver(f.project, b).state).toBe("inactive");
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
  config(); arm(); const probe = await startProbe(store, f.project, b); const id = probe.message_id as string, nonce = probe.nonce as string;
  const wrong = store.send({ from: a.id, replyTo: id, body: nonce }).message; recordProbeReply(store, f.project, wrong, { runtime: a.runtime, session: a.session_ref });
  expect(state(f.project, b)?.proof).toBeUndefined();
  const right = store.send({ from: b.id, replyTo: id, body: nonce }).message;
  recordProbeReply(store, f.project, right, { runtime: a.runtime, session: a.session_ref }); expect(state(f.project, b)?.proof).toBeUndefined();
  recordProbeReply(store, f.project, right, { runtime: b.runtime, session: b.session_ref });
  expect(state(f.project, b)?.proof?.replyId).toBe(right.id);
  expect(receiver(f.project, b).state).toBe("verified");
});
test("a probe queued during a long native turn remains valid; retries preserve the first reply timestamp", async () => {
  config(); arm(); const probe = await startProbe(store, f.project, b), id = probe.message_id as string;
  const path = join(f.project.room, "probes", `${id}.json`);
  const metadata = JSON.parse(readFileSync(path, "utf8")); metadata.createdAt = Date.now() - 3600000;
  writeJson(path, metadata);
  const reply = store.send({ from: b.id, replyTo: id, body: probe.nonce as string, now: Date.now() - 1000 }).message;
  const identity = { runtime: b.runtime, session: b.session_ref };
  recordProbeReply(store, f.project, reply, identity); expect(state(f.project, b)?.proof?.replyId).toBe(reply.id);
  recordProbeReply(store, f.project, reply, identity); expect(state(f.project, b)?.proof?.verifiedAt).toBe(reply.created_at);
});
test("a legacy Hook proof cannot verify a live Channel; restart requires a new Channel proof", async () => {
  config(); arm(); const current = state(f.project, b)!;
  saveState(f.project, { ...current, proof: { nonce: "old", replyId: "old", verifiedAt: Date.now(), hostVersion: "fixture", adapter: "claude-receiver" } });
  expect(receiver(f.project, b).state).toBe("armed_unverified");
  const probe = await startProbe(store, f.project, b);
  const reply = store.send({ from: b.id, replyTo: probe.message_id as string, body: probe.nonce as string }).message;
  recordProbeReply(store, f.project, reply, { runtime: "claude", session: b.session_ref });
  expect(receiver(f.project, b).state).toBe("verified");
  saveState(f.project, { ...state(f.project, b)!, listener: { ...current.listener!, token: randomUUID() } });
  expect(receiver(f.project, b).state).toBe("armed_unverified");
  expect(receiver(f.project, b).evidence).toBeNull();
});
test("inactive Claude cannot claim a new Channel probe", async () => {
  config(); await expect(startProbe(store, f.project, b)).rejects.toThrow("Start the exact Claude session");
});
test("an observed unavailable native Channel is blocked despite a healthy MCP transport", async () => {
  config(); arm(); const probe = await startProbe(store, f.project, b); reportChannelUnavailable(f.project, b);
  const status = receiver(f.project, b);
  expect(status.transport_alive).toBe(true); expect(status.state).toBe("blocked"); expect(status.evidence).toBeNull();
  await expect(startProbe(store, f.project, b)).rejects.toThrow("host-blocked");
  const late = store.send({ from: b.id, replyTo: probe.message_id as string, body: probe.nonce as string }).message;
  recordProbeReply(store, f.project, late, { runtime: "claude", session: b.session_ref });
  expect(receiver(f.project, b).evidence).toBeNull();
});
test("native unavailability is scoped to its launch; uncertain write pauses remain persistent", () => {
  config(); arm(); reportChannelUnavailable(f.project, b);
  saveState(f.project, { ...state(f.project, b)!, listener: { ...state(f.project, b)!.listener!, launchId: randomUUID() } });
  expect(paused(f.project, b)).toBeNull(); expect(receiver(f.project, b).state).toBe("armed_unverified");
});
test("fake binary probes are isolated from user clients", () => {
  const path = fakeCodex("process.exit(0)"); expect(inspectCodex(path)?.version).toBe("codex-cli fixture");
  expect(existsSync(join(f.root, "attempts"))).toBe(false);
  expect(testEnv().CODEX_THREAD_ID).toBeUndefined();
});
