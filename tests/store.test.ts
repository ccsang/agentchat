import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { fixture, nativeIdentity } from "./helpers.ts";
import type { Member } from "../src/types.ts";
import * as files from "../src/files.ts";

let f: ReturnType<typeof fixture>, store: Store, a: Member, b: Member;
beforeEach(() => { f = fixture(); store = new Store(f.project.room, { create: true }); a = store.join(nativeIdentity(), "alice"); b = store.join(nativeIdentity("claude"), "bob"); });
afterEach(() => { store.close(); f.cleanup(); });

test("exactly two application tables and rollback journal", () => {
  expect(store.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "members" }, { name: "messages" }]);
  expect(store.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
});
test("opening a room tolerates a completed writer removing its transient journal during the permission check", () => {
  const journal = join(f.project.room, "chat.db-journal"), original = files.regularFile;
  writeFileSync(journal, "", { mode: 0o600 });
  const mock = spyOn(files, "regularFile").mockImplementation((path, ...args) => {
    if (path === journal) unlinkSync(path);
    return original(path, ...args);
  });
  try {
    const opened = new Store(f.project.room);
    try { expect(opened.members()).toHaveLength(2); } finally { opened.close(); }
  } finally { mock.mockRestore(); }
});
test("transient SQLite sidecars still reject permission failures and dangling symlinks", () => {
  const target = join(f.root, "sidecar"), sidecar = join(f.project.room, "chat.db-journal");
  writeFileSync(sidecar, "", { mode: 0o600 }); chmodSync(sidecar, 0o644);
  expect(() => new Store(f.project.room)).toThrow("owner-only"); unlinkSync(sidecar);
  writeFileSync(target, "", { mode: 0o600 }); symlinkSync(target, sidecar);
  expect(() => new Store(f.project.room)).toThrow("non-regular");
  unlinkSync(target); expect(() => new Store(f.project.room)).toThrow("non-regular");
});
test("join is idempotent by native session; explicit rename preserves ID", () => {
  const again = store.join({ runtime: a.runtime, session: a.session_ref }); expect(again.id).toBe(a.id); expect(again.name).toBe("alice");
  expect(store.join({ runtime: a.runtime, session: a.session_ref }, "reviewer").id).toBe(a.id);
  expect(store.member(a.id).name).toBe("reviewer"); expect(store.members()).toHaveLength(2);
});
test("a new session never takes an existing name", () => {
  expect(() => store.join(nativeIdentity(), "alice")).toThrow("another session"); expect(store.member("alice").id).toBe(a.id);
});
test("same ID and content reuse the original sequence", () => {
  const input = { from: a.id, to: b.id, body: "read only review", id: "review-1", notify: true };
  const first = store.send(input), second = store.send(input);
  expect(second.reused).toBe(true); expect(second.message.seq).toBe(first.message.seq); expect(store.read(0).messages).toHaveLength(1);
  for (const change of [{ body: "other" }, { notify: false }, { from: b.id, to: a.id }]) expect(() => store.send({ ...input, ...change })).toThrow("different content");
});
test("reply routing is atomic and conflicting recipients are rejected", () => {
  store.send({ from: a.id, to: b.id, id: "q", body: "question" });
  expect(store.send({ from: b.id, replyTo: "q", body: "answer" }).message.to_id).toBe(a.id);
  expect(() => store.send({ from: b.id, replyTo: "q", to: b.id, body: "wrong" })).toThrow("conflicts");
  expect(() => store.send({ from: b.id, replyTo: "missing", body: "wrong" })).toThrow("not found");
  expect(store.read(0).messages).toHaveLength(2);
});
test("broadcasts and self-notifications cannot wake models", () => {
  expect(() => store.send({ from: a.id, body: "broadcast", notify: true })).toThrow("Notifications require");
  expect(() => store.send({ from: a.id, to: a.id, body: "self", notify: true })).toThrow("Notifications require");
  expect(store.send({ from: a.id, body: "progress" }).message.notify).toBe(0);
});
test("UTF-8 byte limits are enforced without truncation", () => {
  expect(() => store.send({ from: a.id, body: "中".repeat(2731) })).toThrow("8 KiB");
  expect(store.send({ from: a.id, body: "中".repeat(2730) }).message.body.length).toBe(2730);
  expect(() => store.send({ from: a.id, body: " \n " })).toThrow();
});
test("reads and ID lookups do not update cursors or the DB bytes", () => {
  store.send({ from: a.id, to: b.id, body: "private direction, shared visibility", id: "m1" });
  const path = join(f.project.room, "chat.db"), before = readFileSync(path);
  expect(store.read(0).messages).toHaveLength(1); store.message("m1");
  expect(store.member(b.id).read_seq).toBe(0); expect(readFileSync(path)).toEqual(before);
});
test("pagination advances only over complete returned rows, across all recipients", () => {
  for (let i = 0; i < 7; i++) store.send({ from: a.id, to: i % 2 ? b.id : undefined, body: `message ${i}` });
  const first = store.read(0, 3); expect(first.next_cursor).toBe(3); expect(first.has_more).toBe(true);
  expect(store.read(first.next_cursor, 3).messages.map(m => m.seq)).toEqual([4, 5, 6]);
  const last = store.read(6, 3); expect(last.has_more).toBe(false); expect(last.next_cursor).toBe(7);
});
test("encoded response budget stops at a complete message and does not skip the remainder", () => {
  for (let i = 0; i < 3; i++) store.send({ from: a.id, body: "\u0001".repeat(1000) });
  const page = store.read(0, 20, 8000); expect(page.messages).toHaveLength(1); expect(page.next_cursor).toBe(1); expect(page.has_more).toBe(true);
  expect(store.read(page.next_cursor).messages.map(m => m.seq)).toEqual([2, 3]);
});
test("mark is explicit, monotonic and cannot jump beyond existing rows", () => {
  store.send({ from: a.id, body: "one" }); store.send({ from: a.id, body: "two" });
  expect(store.mark(b.id, 2)).toBe(2); expect(store.mark(b.id, 1)).toBe(2);
  expect(() => store.mark(b.id, 100)).toThrow("does not exist"); expect(store.member(b.id).read_seq).toBe(2);
});
test("database rejects modifying or deleting committed messages", () => {
  const { message } = store.send({ from: a.id, body: "immutable" });
  expect(() => store.db.query("UPDATE messages SET body='changed' WHERE id=?").run(message.id)).toThrow("append-only");
  expect(() => store.db.query("DELETE FROM messages WHERE id=?").run(message.id)).toThrow("append-only");
});
test("notification reservations survive reopening, and cannot be reset", () => {
  store.send({ from: a.id, to: b.id, body: "notify", notify: true });
  const claim = store.claim(b.id); expect(claim.batch?.messages).toHaveLength(1);
  store.close(); store = new Store(f.project.room);
  expect(store.claim(b.id, 20, Date.now() + 6000).batch).toBeNull();
  expect(() => store.db.exec("UPDATE messages SET notify_batch_id=NULL,notify_claimed_at=NULL")).toThrow();
});
test("notification TTL and read cursor only suppress wake, not historical readability", () => {
  const now = Date.now(); store.send({ from: a.id, to: b.id, body: "old", notify: true, now: now - 1800001 });
  store.send({ from: a.id, to: b.id, body: "already read", notify: true, now }); store.mark(b.id, 2);
  expect(store.claim(b.id, 20, now).batch).toBeNull(); expect(store.read(0).messages).toHaveLength(2);
});
test("batch interval and durable budget do not reset across rename or reopen", () => {
  const now = Date.now(); store.send({ from: a.id, to: b.id, body: "one", notify: true, now });
  expect(store.claim(b.id, 1, now).used).toBe(1);
  store.send({ from: a.id, to: b.id, body: "two", notify: true, now });
  expect(store.claim(b.id, 20, now + 1).reason).toBe("minimum_interval");
  store.join({ runtime: "claude", session: b.session_ref }, "renamed");
  store.close(); store = new Store(f.project.room);
  expect(store.claim(b.id, 1, now + 6000).reason).toBe("budget_exhausted");
  expect(store.claim(b.id, 2, now + 6000).batch?.messages).toHaveLength(1);
});
test("read-only opening never creates a missing room", () => {
  expect(() => new Store(join(f.root, "absent"), { readonly: true })).toThrow("Room not found"); expect(existsSync(join(f.root, "absent"))).toBe(false);
});
test("a spent rolling window recovers after reopen without clearing old reservations", () => {
  const now = Date.now();
  store.send({ from: a.id, to: b.id, notify: true, id: "window-first", body: "first", now });
  const batch = store.claim(b.id, 1, now, 5000).batch!;
  store.send({ from: a.id, to: b.id, notify: true, id: "window-next", body: "next", now });
  store.close(); store = new Store(f.project.room);
  expect(store.claim(b.id, 1, now + 4999, 5000).reason).toBe("budget_exhausted");
  expect(store.notificationLimit(b.id, 1, now + 4999, 5000).retry_at).toBe(now + 5000);
  expect(store.claim(b.id, 1, now + 5000, 5000).batch?.messages.map(m => m.id)).toEqual(["window-next"]);
  expect(store.message("window-first").notify_batch_id).toBe(batch.id);
});
test("umask 022 cannot widen fresh room/database permissions; permissive existing DB is refused", () => {
  const previous = process.umask(0o022);
  try {
    const room = join(f.root, "private"); const other = new Store(room, { create: true }); other.close();
    expect(statSync(room).mode & 0o777).toBe(0o700); expect(statSync(join(room, "chat.db")).mode & 0o777).toBe(0o600);
    chmodSync(join(room, "chat.db"), 0o644); expect(() => new Store(room)).toThrow("owner-only");
  } finally { process.umask(previous); }
});
test("room symlinks are refused", () => {
  const alias = join(f.root, "alias"); symlinkSync(f.project.room, alias); expect(() => new Store(alias)).toThrow("private directory");
});
