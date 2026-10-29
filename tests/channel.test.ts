import { expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.ts";
import { fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { fixtureLaunch as createLaunch } from "./helpers.ts";
import { registerHook, endHook } from "../src/hooks.ts";
import { runChannel } from "../src/channel.ts";
import { paused, receiver, resume, state } from "../src/runtime.ts";
import { writeJson } from "../src/files.ts";

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() >= end) throw new Error("test condition timed out"); await Bun.sleep(10); }
}
async function setup(pending = false) {
  const f = fixture(), store = new Store(f.project.room, { create: true });
  const a = store.join(nativeIdentity()), b = store.join(nativeIdentity("claude"));
  const launch = createLaunch(f.project, b.session_ref, "Claude fixture");
  const env = testEnv(launch.env), hook = { session_id: b.session_ref!, cwd: f.root, hook_event_name: "SessionStart" };
  if (!pending) registerHook(f.project, hook, env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agentchat-test", version: "1" }), events: Record<string, unknown>[] = [];
  client.fallbackNotificationHandler = async n => { if (n.method === "notifications/claude/channel") events.push(n.params ?? {}); };
  let clock = Date.now();
  const task = runChannel(f.project, { env, transport: serverTransport, pollMs: 10, retryBaseMs: 10, now: () => clock }).then(() => null, error => error as Error);
  await client.connect(clientTransport);
  if (!pending) await until(() => !!state(f.project, b)?.listener);
  return { ...f, store, a, b, launch, env, hook, client, serverTransport, events, task,
    advance(ms: number) { clock += ms; }, now: () => clock,
    async close() { await client.close(); await task; launch.close(); store.close(); f.cleanup(); } };
}

test("Channel emits IDs after initialization, without tools, permission relay or implicit reading", async () => {
  const h = await setup();
  try {
    h.store.send({ from: h.a.id, to: h.b.id, notify: true, id: "mcp-message", body: "UNTRUSTED BODY MUST STAY IN SQLITE", now: h.now() });
    await until(() => h.events.length === 1);
    expect(h.events[0]!.content).toContain("mcp-message"); expect(h.events[0]!.content).not.toContain("UNTRUSTED BODY");
    const capabilities = h.client.getServerCapabilities();
    expect(capabilities?.tools).toBeUndefined(); expect(capabilities?.experimental?.["claude/channel"]).toEqual({});
    expect(capabilities?.experimental?.["claude/channel/permission"]).toBeUndefined();
    expect(h.store.member(h.b.id).read_seq).toBe(0);
    expect(h.store.claim(h.b.id, 20, h.now() + 6000).batch).toBeNull();
  } finally { await h.close(); }
});
test("MCP can initialize before SessionStart; no member is guessed or message reserved before binding", async () => {
  const h = await setup(true);
  try {
    h.store.send({ from: h.a.id, to: h.b.id, notify: true, id: "pending", body: "read after bind", now: h.now() });
    await Bun.sleep(40); expect(h.events).toHaveLength(0); expect(h.store.message("pending").notify_batch_id).toBeNull();
    registerHook(h.project, h.hook, h.env); await until(() => h.events.length === 1);
    expect(h.events[0]!.content).toContain("pending");
  } finally { await h.close(); }
});
test("accelerated 10-minute and 1-hour idle periods need no renewal message or model heartbeat", async () => {
  const h = await setup();
  try {
    for (const elapsed of [600000, 3600000]) {
      const before = h.events.length; h.advance(elapsed); await Bun.sleep(30);
      expect(h.events).toHaveLength(before); expect(h.store.read(0).messages).toHaveLength(before);
      h.store.send({ from: h.a.id, to: h.b.id, notify: true, body: `after ${elapsed}`, now: h.now() });
      await until(() => h.events.length === before + 1);
      expect(receiver(h.project, h.b, h.now()).transport_alive).toBe(true);
    }
  } finally { await h.close(); }
});
test("temporary SQLite contention backs off then resumes the same receiver", async () => {
  const h = await setup(); let failures = 2;
  const original = Store.prototype.claim;
  const mock = spyOn(Store.prototype, "claim").mockImplementation(function(this: Store, ...args: Parameters<Store["claim"]>) {
    if (failures-- > 0) throw Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
    return original.apply(this, args);
  });
  try {
    h.store.send({ from: h.a.id, to: h.b.id, notify: true, body: "after contention", now: h.now() });
    await until(() => !!state(h.project, h.b)?.listener?.retry);
    expect(receiver(h.project, h.b, h.now()).state).toBe("degraded");
    await until(() => h.events.length === 1);
    expect(state(h.project, h.b)?.listener?.retry).toBeUndefined(); expect(paused(h.project, h.b)).toBeNull();
  } finally { mock.mockRestore(); await h.close(); }
});
test("an uncertain Channel write pauses future notifications and never retries its reservation", async () => {
  const h = await setup(); const original = h.serverTransport.send.bind(h.serverTransport);
  const mock = spyOn(h.serverTransport, "send").mockImplementation(async (message, options) => {
    await original(message, options);
    if ("method" in message && message.method === "notifications/claude/channel") throw new Error("write completed, receipt lost");
  });
  try {
    h.store.send({ from: h.a.id, to: h.b.id, notify: true, id: "unknown", body: "one attempt", now: h.now() });
    await until(() => !!paused(h.project, h.b)); expect(h.events).toHaveLength(1);
    h.advance(6000); h.store.send({ from: h.a.id, to: h.b.id, notify: true, id: "future", body: "wait for resume", now: h.now() });
    await Bun.sleep(40); expect(h.events).toHaveLength(1); expect(receiver(h.project, h.b, h.now()).state).toBe("paused");
    mock.mockRestore(); resume(h.project, h.b); await until(() => h.events.length === 2);
    expect(h.events[1]!.content).toContain("future"); expect(h.events[1]!.content).not.toContain("Messages: unknown");
    expect(h.store.message("unknown").notify_batch_id).not.toBeNull();
  } finally { mock.mockRestore(); await h.close(); }
});
test("rolling notification limits are visible and automatically release pending messages", async () => {
  const h = await setup();
  try {
    writeJson(join(h.project.room, "config.json"), { budget: 1, windowSeconds: 5, autoJoin: false });
    h.store.send({ from: h.a.id, to: h.b.id, notify: true, body: "first", now: h.now() }); await until(() => h.events.length === 1);
    h.advance(1000); h.store.send({ from: h.a.id, to: h.b.id, notify: true, body: "second", now: h.now() });
    await Bun.sleep(30); expect(h.events).toHaveLength(1);
    const status = receiver(h.project, h.b, h.now()); expect(status.state).toBe("rate_limited"); expect(status.transport_alive).toBe(true);
    expect((status.limits as { retry_at: number }).retry_at).toBe(h.now() + 4000);
    h.advance(4000); await until(() => h.events.length === 2);
  } finally { await h.close(); }
});
test("SessionEnd and uninstall close receivers without consuming pending messages", async () => {
  for (const end of ["session", "uninstall"]) {
    const h = await setup();
    try {
      if (end === "session") endHook(h.project, { ...h.hook, hook_event_name: "SessionEnd" }, h.env);
      else writeJson(join(h.project.room, "installed.json"), { installed: false });
      expect(await h.task).toBeNull(); expect(receiver(h.project, h.b).state).toBe("inactive");
      expect(h.events).toHaveLength(0);
    } finally { await h.close(); }
  }
});
test("a second live Channel cannot take over the same native session", async () => {
  const h = await setup();
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "duplicate", version: "1" });
  const task = runChannel(h.project, { env: h.env, transport: st, pollMs: 10 }).then(() => null, error => error as Error);
  try { await client.connect(ct); expect((await task)?.message).toContain("already has a Channel"); expect(receiver(h.project, h.b).transport_alive).toBe(true); }
  finally { await client.close(); await h.close(); }
});
test("two live Claude sessions in the same room receive only their own directed notifications", async () => {
  const h = await setup(), identity = nativeIdentity("claude");
  const launch = createLaunch(h.project, identity.session, "second Claude fixture");
  registerHook(h.project, { ...h.hook, session_id: identity.session }, launch.env);
  const second = h.store.actor(identity), [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "second-session", version: "1" }), events: Record<string, unknown>[] = [];
  client.fallbackNotificationHandler = async n => { if (n.method === "notifications/claude/channel") events.push(n.params ?? {}); };
  const task = runChannel(h.project, { env: launch.env, transport: st, pollMs: 10 }).then(() => null, error => error as Error);
  try {
    await client.connect(ct); await until(() => !!state(h.project, second)?.listener);
    h.store.send({ from: h.a.id, to: h.b.id, notify: true, id: "for-first", body: "first", now: h.now() });
    h.store.send({ from: h.a.id, to: second.id, notify: true, id: "for-second", body: "second", now: h.now() });
    await until(() => h.events.length === 1 && events.length === 1);
    expect(h.events[0]!.content).toContain("for-first"); expect(h.events[0]!.content).not.toContain("for-second");
    expect(events[0]!.content).toContain("for-second"); expect(events[0]!.content).not.toContain("for-first");
  } finally { await client.close(); await task; launch.close(); await h.close(); }
});
test("losing the user-owned launcher stops the Channel and releases its current capability", async () => {
  const h = await setup();
  try {
    h.launch.close(); expect((await h.task)?.message).toContain("no longer running");
    expect(receiver(h.project, h.b).state).toBe("inactive");
  } finally { await h.client.close(); h.store.close(); h.cleanup(); }
});
test("stdio Channel uses the launch handshake without inherited native UUIDs; SIGKILL releases its lock", async () => {
  const f = fixture(), store = new Store(f.project.room, { create: true }), identity = nativeIdentity("claude");
  const launch = createLaunch(f.project, identity.session, "Claude stdio fixture", process.pid);
  const hook = { session_id: identity.session, cwd: f.root, hook_event_name: "SessionStart" };
  const registered = (await import("./helpers.ts")).cli(f.root, ["--agentchat-managed=v1", "hook", "session-start"], testEnv(launch.env), JSON.stringify(hook));
  expect(registered.status).toBe(0);
  const member = store.actor(identity);
  const env = Object.fromEntries(Object.entries(testEnv(launch.env)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../bin/agentchat"), "--project", f.root, "notify", "claude-channel"], env, stderr: "pipe" });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport); await until(() => !!state(f.project, member)?.listener);
    expect(receiver(f.project, member).transport_alive).toBe(true);
    process.kill(transport.pid!, "SIGKILL"); await until(() => !receiver(f.project, member).transport_alive);
    expect(receiver(f.project, member).state).toBe("inactive");
  } finally { await client.close(); launch.close(); store.close(); f.cleanup(); }
});
test("missing or stale launch contexts are rejected even if a caller supplies a native UUID", async () => {
  const f = fixture();
  try { await expect(runChannel(f.project, { env: testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: randomUUID() }) })).rejects.toThrow("live AgentChat launch"); }
  finally { f.cleanup(); }
});
