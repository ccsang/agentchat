import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ChatError, requireThat } from "./errors.ts";
import { createPrivateFile, privateDirectory, regularFile } from "./files.ts";
import type { Batch, Identity, Member, Message, Page } from "./types.ts";
import { sessionId } from "./identity.ts";

const APP_ID = 0x41474348;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
 runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude','generic')),
 session_ref TEXT, read_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_seq >= 0),
 created_at INTEGER NOT NULL,
 CHECK(runtime = 'generic' OR session_ref IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS member_session ON members(runtime,session_ref) WHERE session_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS messages (
 seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
 from_id TEXT NOT NULL REFERENCES members(id), to_id TEXT REFERENCES members(id),
 reply_to TEXT REFERENCES messages(id), body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 8192),
 notify INTEGER NOT NULL DEFAULT 0 CHECK(notify IN (0,1)),
 notify_batch_id TEXT, notify_claimed_at INTEGER, created_at INTEGER NOT NULL,
 CHECK(notify=0 OR (to_id IS NOT NULL AND to_id != from_id)),
 CHECK((notify_batch_id IS NULL) = (notify_claimed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS pending_notifications ON messages(to_id,notify,seq) WHERE notify_batch_id IS NULL;
CREATE TRIGGER IF NOT EXISTS immutable_message BEFORE UPDATE ON messages
WHEN NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.from_id IS NOT OLD.from_id
 OR NEW.to_id IS NOT OLD.to_id OR NEW.reply_to IS NOT OLD.reply_to OR NEW.body IS NOT OLD.body
 OR NEW.notify IS NOT OLD.notify OR NEW.created_at IS NOT OLD.created_at
 OR OLD.notify_batch_id IS NOT NULL OR NEW.notify_batch_id IS NULL
BEGIN SELECT RAISE(ABORT,'messages are append-only; notification reservations cannot be reset'); END;
CREATE TRIGGER IF NOT EXISTS no_message_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT,'messages are append-only'); END;
PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
`;

export class Store {
  readonly db: Database;
  constructor(readonly room: string, options: { create?: boolean; readonly?: boolean } = {}) {
    const path = join(room, "chat.db");
    if (options.create) { privateDirectory(room); createPrivateFile(path); }
    requireThat(existsSync(path), "E_ROOM", "Room not found; join this project first");
    privateDirectory(room); regularFile(path);
    for (const suffix of ["-journal", "-wal", "-shm"]) if (existsSync(path + suffix)) regularFile(path + suffix);
    this.db = new Database(path, { readonly: options.readonly ?? false, create: false, strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
      if (options.create) this.db.transaction(() => {
        const app = (this.db.query("PRAGMA application_id").get() as { application_id: number }).application_id;
        const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
        requireThat((app === 0 || app === APP_ID) && version <= 1, "E_SCHEMA", "Unsupported database format");
        if (version === 0) {
          const count = this.db.query("SELECT count(*) n FROM sqlite_master WHERE type='table'").get() as { n: number };
          requireThat(count.n === 0, "E_SCHEMA", "Refusing to initialize an unrelated database");
          this.db.exec(SCHEMA);
        }
      }).immediate();
      const format = this.db.query("PRAGMA application_id").get() as { application_id: number };
      const version = this.db.query("PRAGMA user_version").get() as { user_version: number };
      requireThat(format.application_id === APP_ID && version.user_version === 1, "E_SCHEMA", "Room schema is missing or unsupported");
      const mode = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      requireThat(mode.journal_mode === "delete", "E_SCHEMA", "Expected SQLite rollback journal mode (DELETE)");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  members(): Member[] { return this.db.query("SELECT * FROM members ORDER BY created_at,id").all() as Member[]; }
  member(ref: string): Member {
    const members = this.db.query("SELECT * FROM members WHERE id=? OR name=?").all(ref, ref) as Member[];
    requireThat(members.length === 1, "E_MEMBER", `Unknown or ambiguous member: ${ref}`);
    return members[0]!;
  }
  actor(identity: Identity): Member {
    const member = this.db.query("SELECT * FROM members WHERE runtime=? AND session_ref=?").get(identity.runtime, identity.session) as Member | null;
    requireThat(member, "E_NOT_JOINED", "This native session has not joined this project"); return member;
  }
  join(identity: Identity, name?: string): Member {
    requireThat(["codex", "claude", "generic"].includes(identity.runtime), "E_IDENTITY", "Unknown runtime");
    if (identity.runtime !== "generic") sessionId(identity.session);
    const generated = `${identity.runtime}-${createHash("sha256").update(identity.session ?? randomUUID()).digest("hex").slice(0, 10)}`;
    const proposed = name ?? generated;
    requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(proposed) && !proposed.startsWith("m_"), "E_NAME", "Name must use 1–64 letters, digits, dots, underscores or hyphens");
    return this.db.transaction(() => {
      if (identity.session) {
        const existing = this.db.query("SELECT * FROM members WHERE runtime=? AND session_ref=?").get(identity.runtime, identity.session) as Member | null;
        if (existing) {
          if (name && name !== existing.name) {
            requireThat(!this.db.query("SELECT id FROM members WHERE name=?").get(name), "E_CONFLICT", "Name already belongs to another session");
            this.db.query("UPDATE members SET name=? WHERE id=?").run(name, existing.id);
            return this.member(existing.id);
          }
          return existing;
        }
      }
      const collision = this.db.query("SELECT * FROM members WHERE name=?").get(proposed) as Member | null;
      if (collision && identity.runtime === "generic" && collision.runtime === "generic" && !identity.session) return collision;
      requireThat(!collision, "E_CONFLICT", "Name already belongs to another session");
      return this.db.query("INSERT INTO members(id,name,runtime,session_ref,created_at) VALUES(?,?,?,?,?) RETURNING *")
        .get(`m_${randomUUID()}`, proposed, identity.runtime, identity.session, Date.now()) as Member;
    }).immediate();
  }
  message(id: string): Message {
    const message = this.db.query("SELECT * FROM messages WHERE id=?").get(id) as Message | null;
    requireThat(message, "E_MESSAGE", `Message not found: ${id}`); return message;
  }
  send(input: { from: string; to?: string; replyTo?: string; body: string; notify?: boolean; id?: string; now?: number }): { message: Message; reused: boolean } {
    const id = input.id ?? `msg_${randomUUID()}`;
    requireThat(/^[a-zA-Z0-9._:-]{1,128}$/.test(id), "E_MESSAGE_ID", "Message ID must be 1–128 safe ASCII characters");
    requireThat(input.body.trim().length > 0 && Buffer.byteLength(input.body, "utf8") <= 8192, "E_SIZE", "Body must contain text and be at most 8 KiB UTF-8");
    return this.db.transaction(() => {
      const from = this.member(input.from);
      const parent = input.replyTo ? this.message(input.replyTo) : null;
      const explicit = input.to ? this.member(input.to).id : null;
      requireThat(!parent || !explicit || parent.from_id === explicit, "E_CONFLICT", "Recipient conflicts with the original sender");
      const to = parent?.from_id ?? explicit;
      const notify = input.notify ? 1 : 0;
      requireThat(!notify || (to && to !== from.id), "E_NOTIFY", "Notifications require another exact recipient; broadcasts and self-notifications are forbidden");
      const existing = this.db.query("SELECT * FROM messages WHERE id=?").get(id) as Message | null;
      if (existing) {
        requireThat(existing.from_id === from.id && existing.to_id === to && existing.reply_to === (parent?.id ?? null)
          && existing.body === input.body && existing.notify === notify, "E_CONFLICT", "This message ID already has different content");
        return { message: existing, reused: true };
      }
      const message = this.db.query("INSERT INTO messages(id,from_id,to_id,reply_to,body,notify,created_at) VALUES(?,?,?,?,?,?,?) RETURNING *")
        .get(id, from.id, to, parent?.id ?? null, input.body, notify, input.now ?? Date.now()) as Message;
      return { message, reused: false };
    }).immediate();
  }
  read(after: number, limit = 20, maxBytes = 256 * 1024): Page {
    requireThat(Number.isSafeInteger(after) && after >= 0, "E_CURSOR", "after must be a nonnegative integer");
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 100, "E_LIMIT", "limit must be 1–100");
    const candidates = this.db.query("SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit + 1) as Message[];
    const messages: Message[] = []; let bytes = 256;
    for (const message of candidates.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (bytes + size > maxBytes) break;
      messages.push(message); bytes += size;
    }
    if (candidates.length && !messages.length) throw new ChatError("E_SIZE", "Response budget cannot contain the next complete message");
    return { after, next_cursor: messages.at(-1)?.seq ?? after, has_more: candidates.length > messages.length, messages };
  }
  mark(memberId: string, seq: number): number {
    requireThat(Number.isSafeInteger(seq) && seq >= 0, "E_CURSOR", "mark must be a nonnegative integer");
    return this.db.transaction(() => {
      const member = this.member(memberId);
      requireThat(seq === 0 || this.db.query("SELECT seq FROM messages WHERE seq=?").get(seq), "E_CURSOR", "Cannot mark a sequence that does not exist");
      const cursor = Math.max(member.read_seq, seq);
      this.db.query("UPDATE members SET read_seq=? WHERE id=?").run(cursor, member.id); return cursor;
    }).immediate();
  }
  claim(memberId: string, budget = 20, now = Date.now()): { batch: Batch | null; reason: string; used: number } {
    requireThat(Number.isInteger(budget) && budget >= 1 && budget <= 10000, "E_BUDGET", "Invalid notification budget");
    return this.db.transaction(() => {
      const member = this.member(memberId);
      const stats = this.db.query("SELECT count(DISTINCT notify_batch_id) used,max(notify_claimed_at) last FROM messages WHERE to_id=?")
        .get(member.id) as { used: number; last: number | null };
      const result = (reason: string) => ({ batch: null, reason, used: stats.used });
      if (stats.used >= budget) return result("budget_exhausted");
      if (stats.last !== null && now - stats.last < 5000) return result("minimum_interval");
      const messages = this.db.query("SELECT * FROM messages WHERE to_id=? AND notify=1 AND notify_batch_id IS NULL AND seq>? AND created_at>=? AND created_at<=? ORDER BY seq LIMIT 20")
        .all(member.id, member.read_seq, now - 1800000, now) as Message[];
      if (!messages.length) return result("no_pending_notification");
      const id = `batch_${randomUUID()}`;
      const update = this.db.query("UPDATE messages SET notify_batch_id=?,notify_claimed_at=? WHERE id=? AND notify_batch_id IS NULL");
      for (const message of messages) update.run(id, now, message.id);
      return { batch: { id, member, messages }, reason: "reserved", used: stats.used + 1 };
    }).immediate();
  }
}
