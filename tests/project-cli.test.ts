import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverProject } from "../src/project.ts";
import { identify } from "../src/identity.ts";
import { cli, fixture, git, testEnv } from "./helpers.ts";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); }); afterEach(() => f.cleanup());
test("missing identity fails before room creation", () => {
  const result = cli(f.root, ["join"]); expect(result.status).toBe(2); expect(result.data.error.code).toBe("E_IDENTITY"); expect(existsSync(f.project.room)).toBe(false);
});
test("native join needs no room or UUID arguments and is idempotent", () => {
  const env = testEnv({ CODEX_THREAD_ID: randomUUID() });
  const a = cli(f.root, ["join"], env), b = cli(f.root, ["join"], env);
  expect(a.status).toBe(0); expect(b.data.member.id).toBe(a.data.member.id); expect(b.data.members).toHaveLength(1);
  expect(a.data.reception.state).toBe("unverified");
});
test("malformed, conflicting and subagent host identities are rejected", () => {
  expect(() => identify({ CODEX_THREAD_ID: "latest" })).toThrow();
  expect(() => identify({ CODEX_THREAD_ID: randomUUID(), AGENTCHAT_CLAUDE_SESSION_ID: randomUUID() })).toThrow("Conflicting");
  expect(() => identify({ CODEX_THREAD_ID: randomUUID(), CLAUDE_AGENT_ID: "subagent" })).toThrow("Subagents");
});
test("generic operator CLI roundtrip and explicit mark", () => {
  expect(cli(f.root, ["join", "--generic", "--name", "a"]).status).toBe(0);
  expect(cli(f.root, ["join", "--generic", "--name", "b"]).status).toBe(0);
  const sent = cli(f.root, ["--as", "a", "send", "--to", "b", "--text", "问候", "--id", "q"]);
  expect(sent.data.stored).toBe(true);
  const before = readFileSync(join(f.project.room, "chat.db"));
  expect(cli(f.root, ["--as", "b", "read", "--new"]).data.next_cursor).toBe(1);
  expect(readFileSync(join(f.project.room, "chat.db"))).toEqual(before);
  expect(cli(f.root, ["--as", "b", "read", "--mark", "1"]).data.read_seq).toBe(1);
  expect(cli(f.root, ["--as", "b", "send", "--reply-to", "q", "--stdin"], testEnv(), "收到").status).toBe(0);
  expect(cli(f.root, ["--as", "a", "read", "--id", "q"]).data.message.body).toBe("问候");
});
test("invalid command options cannot silently mutate state", () => {
  expect(cli(f.root, ["join", "--mark", "100"]).data.error.code).toBe("E_USAGE");
  expect(existsSync(f.project.room)).toBe(false);
  expect(cli(f.root, ["unknown"]).data.error.code).toBe("E_USAGE");
});
test("a native agent cannot write or mark under another native session's profile", () => {
  const a = testEnv({ CODEX_THREAD_ID: randomUUID() }), b = testEnv({ CODEX_THREAD_ID: randomUUID() });
  const first = cli(f.root, ["join"], a); cli(f.root, ["join"], b);
  const wrong = cli(f.root, ["--as", first.data.member.id, "send", "--text", "wrong identity"], b);
  expect(wrong.data.error.code).toBe("E_IDENTITY");
  expect(cli(f.root, ["--as", first.data.member.id, "read", "--mark", "0"], b).data.error.code).toBe("E_IDENTITY");
  expect(cli(f.root, ["read"], a).data.messages).toHaveLength(0);
});
test("doctor reports missing context without initializing storage", () => {
  expect(cli(f.root, ["doctor"]).data.joined).toBe(false); expect(existsSync(f.project.room)).toBe(false);
});
test("linked worktrees and symlink paths share a room; separate clones do not", () => {
  git(f.root, ["init", "-b", "main"]);
  git(f.root, ["-c", "user.name=AgentChat test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const worktree = join(f.root, "linked"); git(f.root, ["worktree", "add", "-b", "test-worktree", worktree]);
  const first = discoverProject(f.root), linked = discoverProject(worktree);
  expect(first.room).toBe(linked.room);
  const alias = join(f.root, "alias"); symlinkSync(worktree, alias); expect(discoverProject(alias).room).toBe(first.room);
  const clone = join(f.root, "clone"); git(f.root, ["clone", "--local", f.root, clone]); expect(discoverProject(clone).room).not.toBe(first.room);
});
test("non-Git nested directories discover their existing ancestor room", () => {
  cli(f.root, ["join", "--generic", "--name", "shell"]);
  const child = join(f.root, "a", "b"); mkdirSync(child, { recursive: true });
  expect(discoverProject(child).room).toBe(f.project.room);
});
test("Git failure never silently creates a non-Git room in an existing repository", () => {
  git(f.root, ["init", "-b", "main"]);
  const result = cli(f.root, ["join"], testEnv({ CODEX_THREAD_ID: randomUUID(), AGENTCHAT_GIT_BIN: join(f.root, "missing-git") }));
  expect(result.status).toBe(2); expect(result.data.error.code).toBe("E_PROJECT");
  expect(existsSync(f.project.room)).toBe(false); expect(existsSync(join(f.root, ".git/agentchat"))).toBe(false);
});
