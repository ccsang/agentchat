import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { notice, dispatchCodex } from "../src/notify.ts";
import { discoverProject } from "../src/project.ts";
import { roomProject } from "../src/rooms.ts";
import { writeJson } from "../src/files.ts";
import { cli, fixture, nativeIdentity, testEnv } from "./helpers.ts";

let f: ReturnType<typeof fixture>, elsewhere: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); elsewhere = fixture(); });
afterEach(() => { f.cleanup(); elsewhere.cleanup(); });
function readArgv(text: string): string[] {
  return JSON.parse(text.split("\n").find(line => line.startsWith("Read argv: "))!.slice("Read argv: ".length));
}
test("one compact notification retains every ID in a full batch without carrying bodies or duplicate routing", () => {
  const store = new Store(f.project.room, { create: true });
  try {
    const sender = store.join(nativeIdentity()), target = store.join(nativeIdentity("claude"));
    for (let i = 0; i < 20; i++) store.send({ from: sender.id, to: target.id, id: `request-${i}`, body: "Private business content", notify: true });
    const batch = store.claim(target.id).batch!, text = notice(batch, f.project), lines = text.split("\n");
    expect(lines).toHaveLength(3); expect(lines[0]).toContain("not user approval");
    expect(lines[1]!.slice("Messages: ".length).split(", ")).toEqual(batch.messages.map(m => m.id));
    expect(readArgv(text)).toEqual([join(f.project.room, "run"), "--project", f.root, "--room", "default", "read", "--new"]);
    for (const omitted of ["Private business content", target.id, "base64", "https://", "Tool argv", "skills get"]) expect(text).not.toContain(omitted);
    expect(store.member(target.id).read_seq).toBe(0);
  } finally { store.close(); }
});
test("a compact Codex notice can be handled from another cwd after switching rooms, preserving argv, replies and cursors", () => {
  const root = join(f.root, "project with space's $HOME"); mkdirSync(root);
  const project = discoverProject(root), identity = nativeIdentity(), env = testEnv({ CODEX_THREAD_ID: identity.session! });
  expect(cli(root, ["join"], env).status).toBe(0);
  expect(cli(root, ["room", "create", "review"], env).status).toBe(0);
  const joined = cli(root, ["room", "use", "review"], env);
  expect(joined.status).toBe(0);
  const selected = roomProject(project, "review"), store = new Store(selected.room);
  const capture = join(f.root, "notice"), fake = join(f.root, "fake-codex");
  writeFileSync(fake, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst a=process.argv.slice(2); if(a.includes('--help')) {console.log('--thread --message'); process.exit(0);} if(a.includes('--version')) {console.log('codex-cli fixture'); process.exit(0);}\nwriteFileSync(${JSON.stringify(capture)},a[a.indexOf('--message')+1]); console.log('Queued message compact123 for thread '+a[a.indexOf('--thread')+1]+'.');\n`, { mode: 0o700 });
  writeJson(join(project.room, "config.json"), { budget: 20, windowSeconds: 600, autoJoin: false, codexBin: fake });
  try {
    const sender = store.join({ runtime: "generic", session: null }, "sender"), target = store.actor(identity);
    store.send({ from: sender.id, id: "context", body: "Shared stream context" });
    store.send({ from: sender.id, to: target.id, id: "review-request", body: "Business body remains in SQLite", notify: true });
    expect(dispatchCodex(store, selected, target).state).toBe("submitted");
    const text = readFileSync(capture, "utf8"), argv = readArgv(text);
    expect(argv).toEqual([join(project.room, "run"), "--project", root, "--room", "review", "read", "--new"]);
    expect(text).not.toContain("Business body remains in SQLite");
    expect(cli(root, ["room", "use", "default"], env).status).toBe(0);
    const protocol = spawnSync(argv[0]!, ["skills", "get"], { cwd: elsewhere.root, env, encoding: "utf8" });
    expect(protocol.status).toBe(0); expect(protocol.stdout).toContain("Read argv");
    const read = spawnSync(argv[0]!, argv.slice(1), { cwd: elsewhere.root, env, encoding: "utf8" });
    expect(read.status).toBe(0);
    const page = JSON.parse(read.stdout);
    expect(page.room_name).toBe("review"); expect(page.messages.map((m: { id: string }) => m.id)).toEqual(["context", "review-request"]);
    expect(store.member(target.id).read_seq).toBe(0);
    const routed = (args: string[]) => spawnSync(argv[0]!, [...argv.slice(1, -2), ...args], { cwd: elsewhere.root, env, encoding: "utf8" });
    const reply = routed(["send", "--reply-to", "review-request", "--text", "Result"]);
    expect(reply.status).toBe(0); expect(store.message(JSON.parse(reply.stdout).message_id).reply_to).toBe("review-request");
    expect(routed(["read", "--mark", String(page.next_cursor)]).status).toBe(0);
    expect(store.member(target.id).read_seq).toBe(page.next_cursor);
    expect(cli(root, ["room", "current"], env).data.current).toBe("default");
    expect(readdirSync(elsewhere.root)).toEqual([]); expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  } finally { store.close(); }
});
