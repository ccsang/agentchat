import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { cli, fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { dispatchCodex, paused, resume } from "../src/notify.ts";
import { registerHook, waitHook, endHook } from "../src/hooks.ts";
import { writeJson } from "../src/files.ts";
import { receiver, state } from "../src/runtime.ts";
import { recordProbeReply, startProbe } from "../src/probe.ts";
import type { Member } from "../src/types.ts";
import { inspectCodex } from "../src/notify.ts";

let f: ReturnType<typeof fixture>, store: Store, a: Member, b: Member;
beforeEach(() => { f = fixture(); store = new Store(f.project.room, { create: true }); a = store.join(nativeIdentity(), "a"); b = store.join(nativeIdentity("claude"), "b"); });
afterEach(() => { store.close(); f.cleanup(); });
function hook(event: string) { return { session_id: b.session_ref!, cwd: f.root, hook_event_name: event }; }
function config(extra: Record<string, unknown> = {}) { writeJson(join(f.project.room, "config.json"), { budget: 20, watchSeconds: 1, autoJoin: false, ...extra }); }
function fakeCodex(body: string): string {
  const file = join(f.root, "codex-fixture");
  writeFileSync(file, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2); if(a.includes('--help')) {console.log('--thread --message'); process.exit(0);} if(a.includes('--version')) {console.log('codex-cli fixture'); process.exit(0);}\nappendFileSync(${JSON.stringify(join(f.root, "attempts"))},'accepted\\n');\n${body}\n`, { mode: 0o755 });
  config({ codexBin: file }); return file;
}
test("hook nonce delivery reserves once, includes IDs not untrusted bodies, and never moves read cursor", async () => {
  config(); registerHook(f.project, hook("SessionStart"), {});
  const waiting = waitHook(f.project, hook("Stop"));
  expect(receiver(f.project, b).state).toBe("armed_unverified");
  store.send({ from: a.id, to: b.id, notify: true, id: "directed", body: "DO NOT INCLUDE THIS BODY IN THE NOTIFICATION" });
  const result = await waiting;
  expect(result.exitCode).toBe(2); expect(result.text).toContain("directed"); expect(result.text).not.toContain("DO NOT INCLUDE");
  expect(store.member(b.id).read_seq).toBe(0); expect(store.claim(b.id, 20, Date.now() + 6000).batch).toBeNull();
  expect(receiver(f.project, b).state).toBe("inactive");
});
test("only one listener per session; timeout removes its active capability without waking", async () => {
  config(); const first = waitHook(f.project, hook("Stop"));
  const second = await waitHook(f.project, hook("Stop")); expect(second.reason).toBe("already_listening");
  expect((await first).exitCode).toBe(0); expect(receiver(f.project, b).state).toBe("inactive");
});
test("SessionEnd and cancellation release listener locks without emitting a wake", async () => {
  config(); const first = waitHook(f.project, hook("Stop")); endHook(f.project, hook("SessionEnd"));
  expect((await first).reason).toBe("session_ended");
  const controller = new AbortController(); const second = waitHook(f.project, hook("Stop"), controller.signal); controller.abort();
  expect((await second).exitCode).toBe(0);
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
test("uninstall stops an existing listener without waking or losing messages", async () => {
  config(); const waiting = waitHook(f.project, hook("Stop"));
  writeJson(join(f.project.room, "installed.json"), { installed: false });
  expect((await waiting).reason).toBe("uninstalled"); expect(receiver(f.project, b).state).toBe("inactive");
});
test("malformed managed hook arguments cannot emit the rewake exit status", () => {
  const result = cli(f.root, ["--agentchat-managed=v1", "hook", "wait", "--unknown"], testEnv());
  expect(result.status).toBe(1); expect(result.data.error.code).toBe("E_USAGE");
});
test("SIGKILL releases a receiver's kernel lock; stale metadata never claims it is alive", async () => {
  config({ watchSeconds: 60 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/agentchat"), "--project", f.root, "--agentchat-managed=v1", "hook", "wait"], { env: testEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(hook("Stop"))); child.stdin.end();
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && receiver(f.project, b).state === "inactive") await Bun.sleep(25);
    expect(receiver(f.project, b).state).toBe("armed_unverified");
    child.kill("SIGKILL"); await child.exited;
    expect(receiver(f.project, b).state).toBe("inactive");
    const controller = new AbortController(), waiting = waitHook(f.project, hook("Stop"), controller.signal); controller.abort();
    expect((await waiting).reason).toBe("cancelled");
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
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
test("nonce proof requires a reply from the exact intended native member", () => {
  config(); const probe = startProbe(store, f.project, b); const id = probe.message_id as string, nonce = probe.nonce as string;
  const wrong = store.send({ from: a.id, replyTo: id, body: nonce }).message; recordProbeReply(store, f.project, wrong, { runtime: a.runtime, session: a.session_ref });
  expect(state(f.project, b)?.proof).toBeUndefined();
  const right = store.send({ from: b.id, replyTo: id, body: nonce }).message;
  recordProbeReply(store, f.project, right, { runtime: a.runtime, session: a.session_ref }); expect(state(f.project, b)?.proof).toBeUndefined();
  recordProbeReply(store, f.project, right, { runtime: b.runtime, session: b.session_ref });
  expect(state(f.project, b)?.proof?.replyId).toBe(right.id);
  expect(receiver(f.project, b).state).toBe("inactive");
});
test("a probe queued during a long native turn remains valid; retries preserve the first reply timestamp", () => {
  config(); const probe = startProbe(store, f.project, b), id = probe.message_id as string;
  const path = join(f.project.room, "probes", `${id}.json`);
  const metadata = JSON.parse(readFileSync(path, "utf8")); metadata.createdAt = Date.now() - 3600000;
  writeJson(path, metadata);
  const reply = store.send({ from: b.id, replyTo: id, body: probe.nonce as string, now: Date.now() - 1000 }).message;
  const identity = { runtime: b.runtime, session: b.session_ref };
  recordProbeReply(store, f.project, reply, identity); expect(state(f.project, b)?.proof?.replyId).toBe(reply.id);
  recordProbeReply(store, f.project, reply, identity); expect(state(f.project, b)?.proof?.verifiedAt).toBe(reply.created_at);
});
test("Channel rejects an old member profile before connecting MCP", async () => {
  const { runChannel } = await import("../src/channel.ts");
  const previous = process.env.CODEX_THREAD_ID; process.env.CODEX_THREAD_ID = a.session_ref!;
  try { await expect(runChannel(f.project, b)).rejects.toThrow("own matching"); }
  finally { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; }
});
test("fake binary probes are isolated from user clients", () => {
  const path = fakeCodex("process.exit(0)"); expect(inspectCodex(path)?.version).toBe("codex-cli fixture");
  expect(existsSync(join(f.root, "attempts"))).toBe(false);
  expect(testEnv().CODEX_THREAD_ID).toBeUndefined();
});
