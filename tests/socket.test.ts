import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { cli, fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { Store } from "../src/store.ts";
import * as peer from "../src/claude-peer.ts";
import { automaticSocket, configureSocket, saveSocketProof, socketBinding, socketProof } from "../src/socket-state.ts";
import { dispatchSocket } from "../src/socket-adapter.ts";
import { pause, paused, receiver, resume } from "../src/runtime.ts";
import { recordProbeReply, startProbe } from "../src/probe.ts";
import { writeJson } from "../src/files.ts";
import { endHook } from "../src/hooks.ts";
import { spawnSync } from "node:child_process";
import { createRoom, roomProject, selectRoom } from "../src/rooms.ts";

let f: ReturnType<typeof fixture>, store: Store, server: ReturnType<typeof createServer>, directory: string;
let a: ReturnType<Store["join"]>, b: ReturnType<Store["join"]>, metaPath: string, socketPath: string, token: string;
let metadata: Record<string, unknown>, frames: Record<string, unknown>[], oldConfig: string | undefined;
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error("socket fixture timed out"); await Bun.sleep(10); } }
beforeEach(async () => {
  f = fixture(); store = new Store(f.project.room, { create: true }); a = store.join(nativeIdentity()); b = store.join(nativeIdentity("claude"));
  oldConfig = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = join(f.root, "claude");
  const sessions = join(process.env.CLAUDE_CONFIG_DIR, "sessions"); mkdirSync(sessions, { recursive: true, mode: 0o700 });
  directory = mkdtempSync("/tmp/acp-"); chmodSync(directory, 0o700); socketPath = join(directory, `${process.pid}.sock`); frames = [];
  server = createServer(socket => { let buffer = ""; socket.on("data", data => {
    buffer += data.toString(); while (buffer.includes("\n")) { const at = buffer.indexOf("\n"); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) frames.push(JSON.parse(line)); }
  }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  metadata = { pid: process.pid, sessionId: b.session_ref, cwd: f.root, procStart: peer.processStart(process.pid), version: "2.1.312", peerProtocol: 1, kind: "interactive", entrypoint: "cli", messagingSocketPath: socketPath };
  metaPath = join(sessions, `${process.pid}.json`); writeFileSync(metaPath, JSON.stringify(metadata), { mode: 0o644 });
  token = randomBytes(16).toString("hex");
  writeFileSync(join(sessions, `${process.pid}.${createHash("sha256").update(socketPath).digest("hex")}.key`), JSON.stringify({ peerToken: token, procStart: metadata.procStart }), { mode: 0o600 });
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
  store.close(); rmSync(directory, { recursive: true, force: true }); f.cleanup();
});
test("join automatically binds its exact native socket without consuming or submitting any notification", () => {
  store.send({ from: a.id, to: b.id, id: "pending-auto", body: "pending", notify: true });
  const env = testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: b.session_ref! });
  const first = cli(f.root, ["join"], env);
  expect(first.status).toBe(0); expect(first.data.automatic_reception.enabled).toBe(true);
  expect(first.data.reception.mode).toBe(peer.SOCKET_ADAPTER); expect(first.data.reception.state).toBe("armed_unverified");
  expect(socketBinding(f.project, b)?.pid).toBe(process.pid);
  expect(store.message("pending-auto").notify_batch_id).toBeNull(); expect(frames).toEqual([]);
  expect(cli(f.root, ["join"], env).data.automatic_reception.configured).toBe(false);
});
test("unsupported Claude versions remain joined with a concrete error and no Channel fallback", () => {
  metadata.version = "2.1.313"; writeFileSync(metaPath, JSON.stringify(metadata));
  const result = cli(f.root, ["join"], testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: b.session_ref! }));
  expect(result.status).toBe(0); expect(result.data.automatic_reception.reason).toContain("Unverified Claude socket");
  expect(result.data.reception.mode).toBe(peer.SOCKET_ADAPTER); expect(result.data.reception.transport_alive).toBe(false);
  expect(socketBinding(f.project, b)).toBeNull(); expect(frames).toEqual([]);
});
test("only the new native process's SessionStart can automatically replace a stale instance, without replaying messages or proof", () => {
  const env = testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: b.session_ref! });
  expect(cli(f.root, ["join"], env).status).toBe(0);
  expect(cli(f.root, ["install", "--auto-join", "--apply"], env).status).toBe(0);
  const stale = { ...socketBinding(f.project, b)!, instance: "a".repeat(64) };
  writeJson(join(f.project.room, "socket-sessions", `${b.session_ref}.json`), stale);
  saveSocketProof(f.project, b, { nonce: "old", replyId: "old", verifiedAt: Date.now(), hostVersion: stale.version, adapter: peer.SOCKET_ADAPTER, receiverToken: stale.instance });
  store.send({ from: a.id, to: b.id, id: "old-reservation", body: "keep", notify: true });
  store.claim(b.id, 20);
  const batch = store.message("old-reservation").notify_batch_id;
  expect(automaticSocket(f.project, b).state).toBe("unavailable");
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../bin/agentchat"), "hook", "plugin-session-start"],
    { cwd: f.root, env, input: JSON.stringify({ session_id: b.session_ref, cwd: f.root, hook_event_name: "SessionStart" }), encoding: "utf8" });
  expect(result.status).toBe(0); expect(socketBinding(f.project, b)?.instance).not.toBe(stale.instance);
  expect(receiver(f.project, b).verification).toBe("unverified"); expect(socketProof(f.project, b, stale.instance)?.nonce).toBe("old");
  expect(store.message("old-reservation").notify_batch_id).toBe(batch); expect(frames).toEqual([]);
});
test("explicit socket opt-out survives later automatic joining", () => {
  configureSocket(f.project, b, true); configureSocket(f.project, b, true, true);
  expect(automaticSocket(f.project, b).state).toBe("disabled"); expect(socketBinding(f.project, b)?.enabled).toBe(false);
});
test("socket opt-out before any binding survives join and room changes until explicitly enabled", () => {
  configureSocket(f.project, b, true, true);
  const env = testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: b.session_ref! });
  expect(cli(f.root, ["join"], env).data.automatic_reception.state).toBe("disabled");
  expect(receiver(f.project, b).state).toBe("disabled"); expect(socketBinding(f.project, b)).toBeNull();
  createRoom(f.project, "review");
  expect(cli(f.root, ["room", "use", "review"], env).data.automatic_reception.state).toBe("disabled");
  configureSocket(f.project, b, true); expect(automaticSocket(f.project, b).enabled).toBe(true); expect(frames).toEqual([]);
});
test("SessionEnd removes socket capability before the native process exits and preserves pending rows", async () => {
  cli(f.root, ["join"], testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: b.session_ref! }));
  endHook(f.project, { session_id: b.session_ref!, cwd: f.root, hook_event_name: "SessionEnd" });
  expect(receiver(f.project, b).transport_alive).toBe(false);
  store.send({ from: a.id, to: b.id, id: "after-end", body: "keep", notify: true });
  expect((await dispatchSocket(store, f.project, b)).reason).toBe("native_session_ended");
  expect(store.message("after-end").notify_batch_id).toBeNull();
});
test("automatic migration cannot clear an uncertain old Channel submission", () => {
  pause(f.project, b, "channel_outcome_unknown");
  const result = automaticSocket(f.project, b);
  expect(result.state).toBe("unavailable"); expect(result.reason).toContain("uncertain notification pause");
  expect(paused(f.project, b, "claude-channel")?.reason).toBe("channel_outcome_unknown"); expect(socketBinding(f.project, b)).toBeNull();
});
test("socket selection previews without writes; explicit selection pins the exact peer and never stores its credential", () => {
  const preview = configureSocket(f.project, b, false); expect(preview.experimental).toBe(true); expect(socketBinding(f.project, b)).toBeNull();
  const applied = configureSocket(f.project, b, true); expect(applied.member_id).toBe(b.id);
  const binding = socketBinding(f.project, b)!; expect(binding.session).toBe(b.session_ref!); expect(binding.pid).toBe(process.pid);
  expect(JSON.stringify(applied)).not.toContain(token); expect(readFileSync(join(f.project.room, "socket-bindings", `${b.id}.json`), "utf8")).not.toContain(token);
  expect(receiver(f.project, b).mode).toBe(peer.SOCKET_ADAPTER); expect(receiver(f.project, b).state).toBe("armed_unverified");
  expect(configureSocket(f.project, b, true).binding).toEqual(binding);
});
test("named rooms reuse the explicitly chosen native socket but require their own nonce proof", async () => {
  configureSocket(f.project, b, true); const binding = socketBinding(f.project, b)!;
  saveSocketProof(f.project, b, { nonce: "fixture-only", replyId: "fixture-only", verifiedAt: Date.now(), hostVersion: binding.version, adapter: peer.SOCKET_ADAPTER, receiverToken: binding.instance });
  expect(receiver(f.project, b).verification).toBe("current_socket");
  createRoom(f.project, "review"); const target = roomProject(f.project, "review"), other = new Store(target.room);
  try {
    const next = other.join({ runtime: b.runtime, session: b.session_ref }), sender = other.join({ runtime: a.runtime, session: a.session_ref });
    selectRoom(target, { runtime: b.runtime, session: b.session_ref });
    expect(socketBinding(target, next)?.instance).toBe(binding.instance);
    expect(receiver(target, next).transport_alive).toBe(true); expect(receiver(target, next).verification).toBe("unverified");
    other.send({ from: sender.id, to: next.id, id: "review-only", body: "fixture", notify: true });
    expect((await dispatchSocket(other, target, next)).state).toBe("submitted");
    await until(() => frames.length === 2);
    const content = (frames[1]!.message as { content: string }).content;
    const read = JSON.parse(content.split("\n").find(line => line.startsWith("Read argv: "))!.slice("Read argv: ".length));
    expect(read).toEqual([join(f.project.room, "run"), "--project", f.root, "--room", "review", "read", "--new"]);
    expect(receiver(f.project, b).state).toBe("room_not_selected");
  } finally { other.close(); }
});
test("unknown native socket writes remain paused when the native session changes rooms", async () => {
  configureSocket(f.project, b, true); pause(f.project, b, "socket_outcome_unknown", { adapter: peer.SOCKET_ADAPTER });
  createRoom(f.project, "review"); const target = roomProject(f.project, "review"), other = new Store(target.room);
  try {
    const next = other.join({ runtime: b.runtime, session: b.session_ref }); selectRoom(target, { runtime: b.runtime, session: b.session_ref });
    expect((await dispatchSocket(other, target, next)).state).toBe("paused"); expect(frames).toHaveLength(0);
    resume(target, next); expect(paused(f.project, b)).toBeNull();
  } finally { other.close(); }
});
test("a copied native socket binding cannot skip project validation using its saved cwd", () => {
  configureSocket(f.project, b, true); const foreign = fixture(), other = new Store(foreign.project.room, { create: true });
  try { const copied = other.join({ runtime: b.runtime, session: b.session_ref }); expect(() => peer.validatePeer(foreign.project, copied, socketBinding(f.project, b)!)).toThrow("another project"); }
  finally { other.close(); foreign.cleanup(); }
});
test("native notification uses peer authentication and a one-way next-priority frame, with no child or permission-class impersonation", async () => {
  configureSocket(f.project, b, true);
  store.send({ from: a.id, to: b.id, notify: true, id: "direct", body: "UNTRUSTED BUSINESS CONTENT" });
  const result = await dispatchSocket(store, f.project, b); await until(() => frames.length === 2);
  expect(result.state).toBe("submitted"); expect(result.processed).toBe(false); expect(JSON.stringify(result)).not.toContain(token);
  expect(frames[0]).toEqual({ type: "auth", token });
  expect(frames[1]!.priority).toBe("next"); expect(frames[1]!.msgV).toBe(1); expect(frames[1]!.from).toBeUndefined();
  const content = (frames[1]!.message as { content: string }).content;
  expect(content).toContain("direct"); expect(content).not.toContain("UNTRUSTED BUSINESS CONTENT"); expect(content).not.toContain("from-mode");
  expect(store.member(b.id).read_seq).toBe(0);
});
test("unsupported native versions fail before opt-in or notification reservation", async () => {
  metadata.version = "2.1.313"; writeFileSync(metaPath, JSON.stringify(metadata));
  expect(() => configureSocket(f.project, b, true)).toThrow("Unverified Claude socket"); expect(socketBinding(f.project, b)).toBeNull();
});
test("stale process identity is rejected without guessing a replacement or consuming a notification", async () => {
  configureSocket(f.project, b, true); store.send({ from: a.id, to: b.id, id: "stale", notify: true, body: "do not route elsewhere" });
  metadata.procStart = "stale process"; writeFileSync(metaPath, JSON.stringify(metadata));
  expect((await dispatchSocket(store, f.project, b)).state).toBe("unavailable"); expect(store.message("stale").notify_batch_id).toBeNull();
  expect(receiver(f.project, b).state).toBe("inactive");
});
test("exact session metadata in a different project cannot be enrolled", () => {
  const other = fixture();
  try { metadata.cwd = other.root; writeFileSync(metaPath, JSON.stringify(metadata)); expect(() => configureSocket(f.project, b, true)).toThrow("another project"); }
  finally { other.cleanup(); }
});
test("permissive socket directories, socket files and key files are rejected", () => {
  chmodSync(metaPath, 0o666); expect(() => configureSocket(f.project, b, true)).toThrow(); chmodSync(metaPath, 0o644);
  chmodSync(directory, 0o755); expect(() => configureSocket(f.project, b, true)).toThrow("owner-only"); chmodSync(directory, 0o700);
  chmodSync(socketPath, 0o666); expect(() => configureSocket(f.project, b, true)).toThrow("private socket"); chmodSync(socketPath, 0o600);
  const key = join(dirname(metaPath), `${process.pid}.${createHash("sha256").update(socketPath).digest("hex")}.key`);
  chmodSync(key, 0o644); expect(() => configureSocket(f.project, b, true)).toThrow("owner-only");
});
test("metadata and key symlinks cannot redirect native enrollment", () => {
  const key = join(dirname(metaPath), `${process.pid}.${createHash("sha256").update(socketPath).digest("hex")}.key`);
  renameSync(key, key + ".saved"); symlinkSync(key + ".saved", key);
  expect(() => configureSocket(f.project, b, true)).toThrow(); unlinkSync(key); renameSync(key + ".saved", key);
  renameSync(metaPath, metaPath + ".saved"); symlinkSync(metaPath + ".saved", metaPath);
  expect(() => configureSocket(f.project, b, true)).toThrow();
});
test("a pre-submission connection failure consumes no reservation", async () => {
  configureSocket(f.project, b, true); store.send({ from: a.id, to: b.id, id: "refused", notify: true, body: "keep" });
  const mock = spyOn(peer, "connectPeer").mockRejectedValue(new Error("connection refused"));
  try { expect((await dispatchSocket(store, f.project, b)).state).toBe("unavailable"); expect(store.message("refused").notify_batch_id).toBeNull(); }
  finally { mock.mockRestore(); }
});
test("uncertain native writes pause only socket notifications and keep old reservations across resume", async () => {
  configureSocket(f.project, b, true); store.send({ from: a.id, to: b.id, id: "unknown", notify: true, body: "keep" });
  const original = peer.connectPeer;
  const mock = spyOn(peer, "connectPeer").mockImplementation(async (...args) => {
    const connection = await original(...args); return { ...connection, send: async (...sendArgs: Parameters<typeof connection.send>) => { await connection.send(...sendArgs); throw new Error("already sent, outcome unknown"); } };
  });
  try {
    expect((await dispatchSocket(store, f.project, b)).state).toBe("unknown"); expect(paused(f.project, b)?.reason).toBe("socket_outcome_unknown");
    expect((await dispatchSocket(store, f.project, b)).state).toBe("paused");
    resume(f.project, b); expect(paused(f.project, b)).toBeNull(); expect(store.message("unknown").notify_batch_id).not.toBeNull();
    expect(paused(f.project, b, "claude-channel")?.reason).toBe("explicit_socket_selection");
  } finally { mock.mockRestore(); }
});
test("a native socket probe requires the reply's actual native socket context, not only a reused session UUID", async () => {
  configureSocket(f.project, b, true); const probe = await startProbe(store, f.project, b);
  const message = store.send({ from: b.id, replyTo: probe.message_id as string, body: probe.nonce as string }).message;
  const identity = { runtime: b.runtime, session: b.session_ref }, binding = socketBinding(f.project, b)!;
  recordProbeReply(store, f.project, message, identity, testEnv()); expect(socketProof(f.project, b, binding.instance)).toBeNull();
  recordProbeReply(store, f.project, message, identity, testEnv({ CLAUDE_CODE_MESSAGING_SOCKET: socketPath }));
  expect(socketProof(f.project, b, binding.instance)?.replyId).toBe(message.id);
  recordProbeReply(store, f.project, message, identity, testEnv({ CLAUDE_CODE_MESSAGING_SOCKET: socketPath }));
  expect(socketProof(f.project, b, binding.instance)?.verifiedAt).toBe(message.created_at);
  expect(receiver(f.project, b, Date.now() + 3600000).verification).toBe("current_socket");
});
test("unknown pauses from another adapter cannot be silently cleared by opting into the experiment", () => {
  pause(f.project, b, "channel_outcome_unknown"); expect(() => configureSocket(f.project, b, true)).toThrow("Resolve the existing uncertain");
  expect(socketBinding(f.project, b)).toBeNull();
});
test("disabling the experiment retains history and does not start a fallback receiver", () => {
  configureSocket(f.project, b, true); const before = readFileSync(join(f.project.room, "chat.db"));
  expect(configureSocket(f.project, b, true, true).fallback_started).toBe(false);
  expect(socketBinding(f.project, b)?.enabled).toBe(false); expect(readFileSync(join(f.project.room, "chat.db"))).toEqual(before);
});
test("uninstall disables socket dispatch and its active capability without discarding messages", async () => {
  configureSocket(f.project, b, true); store.send({ from: a.id, to: b.id, id: "uninstalled", notify: true, body: "keep" });
  writeJson(join(f.project.room, "installed.json"), { installed: false });
  expect(receiver(f.project, b).transport_alive).toBe(false); expect((await dispatchSocket(store, f.project, b)).state).toBe("unavailable");
  expect(store.message("uninstalled").notify_batch_id).toBeNull();
});
test("reading an old Channel nonce during socket activity cannot verify the earlier adapter", async () => {
  configureSocket(f.project, b, true); const probe = await startProbe(store, f.project, b), path = join(f.project.room, "probes", `${probe.message_id}.json`);
  const saved = JSON.parse(readFileSync(path, "utf8")); writeJson(path, { ...saved, adapter: "claude-channel" });
  const message = store.send({ from: b.id, replyTo: probe.message_id as string, body: probe.nonce as string }).message;
  recordProbeReply(store, f.project, message, { runtime: b.runtime, session: b.session_ref }, testEnv({ CLAUDE_CODE_MESSAGING_SOCKET: socketPath }));
  expect(socketProof(f.project, b, socketBinding(f.project, b)!.instance)).toBeNull(); expect(receiver(f.project, b).verification).toBe("unverified");
});

async function extraPeer(session: string) {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { env: testEnv(), stdout: "ignore", stderr: "ignore" });
  const path = join(directory, `${child.pid}.sock`), extraFrames: Record<string, unknown>[] = [];
  const extraServer = createServer(socket => { let text = ""; socket.on("data", data => { text += data.toString(); while (text.includes("\n")) { const at = text.indexOf("\n"); const line = text.slice(0, at); text = text.slice(at + 1); if (line) extraFrames.push(JSON.parse(line)); } }); });
  await new Promise<void>(resolve => extraServer.listen(path, resolve)); chmodSync(path, 0o600);
  const info = { ...metadata, pid: child.pid, sessionId: session, procStart: peer.processStart(child.pid), messagingSocketPath: path };
  const extraMetaPath = join(dirname(metaPath), `${child.pid}.json`);
  writeFileSync(extraMetaPath, JSON.stringify(info), { mode: 0o644 });
  writeFileSync(join(dirname(metaPath), `${child.pid}.${createHash("sha256").update(path).digest("hex")}.key`), JSON.stringify({ peerToken: randomBytes(16).toString("hex"), procStart: info.procStart }), { mode: 0o600 });
  return { frames: extraFrames, metadataPath: extraMetaPath, close: async () => { await new Promise<void>(resolve => extraServer.close(() => resolve())); child.kill("SIGTERM"); await child.exited; } };
}
test("two native peers in one project receive only their own member's directed frames", async () => {
  const c = store.join(nativeIdentity("claude")), other = await extraPeer(c.session_ref!);
  try {
    configureSocket(f.project, b, true); configureSocket(f.project, c, true);
    store.send({ from: a.id, to: b.id, id: "first-peer", notify: true, body: "first" });
    store.send({ from: a.id, to: c.id, id: "second-peer", notify: true, body: "second" });
    expect((await dispatchSocket(store, f.project, b)).state).toBe("submitted"); expect((await dispatchSocket(store, f.project, c)).state).toBe("submitted");
    await until(() => frames.length === 2 && other.frames.length === 2);
    expect(JSON.stringify(frames[1])).toContain("first-peer"); expect(JSON.stringify(frames[1])).not.toContain("second-peer");
    expect(JSON.stringify(other.frames[1])).toContain("second-peer"); expect(JSON.stringify(other.frames[1])).not.toContain("first-peer");
  } finally { await other.close(); }
});
test("two live peers advertising the same native session are ambiguous and cannot be selected", async () => {
  const other = await extraPeer(b.session_ref!);
  try {
    expect(() => configureSocket(f.project, b, true)).toThrow("More than one live"); expect(socketBinding(f.project, b)).toBeNull();
    const alternate = JSON.parse(readFileSync(other.metadataPath, "utf8")); alternate.version = "2.1.313"; writeFileSync(other.metadataPath, JSON.stringify(alternate));
    expect(() => configureSocket(f.project, b, true)).toThrow("More than one live");
  }
  finally { await other.close(); }
});
test("a replaced socket inode cannot inherit the earlier process instance or its proof", async () => {
  configureSocket(f.project, b, true); store.send({ from: a.id, to: b.id, id: "replaced", notify: true, body: "do not reroute" });
  renameSync(socketPath, socketPath + ".old");
  const replacement = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => replacement.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  try {
    expect((await dispatchSocket(store, f.project, b)).state).toBe("unavailable"); expect(store.message("replaced").notify_batch_id).toBeNull();
    expect(receiver(f.project, b).state).toBe("inactive");
  } finally { await new Promise<void>(resolve => replacement.close(() => resolve())); }
});
test("passive idle verification cannot certify replies after the original receiver was replaced", () => {
  configureSocket(f.project, b, true); const binding = socketBinding(f.project, b)!, nonce = "simulated-idle-correlation", now = Date.now();
  store.send({ from: a.id, to: b.id, id: "simulated-idle", body: "fixture only", notify: true, now });
  store.send({ from: b.id, replyTo: "simulated-idle", body: `idle-result:${nonce}`, notify: true, now });
  const path = join(f.project.room, "simulated-idle-evidence.json");
  writeJson(path, { phase: "request_stored", nonce, seconds: 600, fromId: a.id, toId: b.id, requestId: "simulated-idle", startedAt: now - 600000, notBefore: now,
    baselineSeq: 0, receiverToken: binding.instance, adapter: peer.SOCKET_ADAPTER });
  const verify = () => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../scripts/verify-idle-test.ts"), "--evidence", path], { cwd: f.root, env: testEnv(), encoding: "utf8" });
    return JSON.parse(result.stdout);
  };
  expect(verify().ok).toBe(true);
  metadata.procStart = "replaced process"; writeFileSync(metaPath, JSON.stringify(metadata));
  const changed = verify(); expect(changed.ok).toBe(false); expect(changed.steps.original_receiver_present).toBe(false);
});
