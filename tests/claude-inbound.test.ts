import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyClaudeInbound, planClaudeInbound } from "../src/claude-inbound.ts";
import { cli, fixture, testEnv } from "./helpers.ts";

let f: ReturnType<typeof fixture>, previous: string | undefined;
beforeEach(() => { f = fixture(); previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = join(f.root, "Claude config's"); });
afterEach(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; f.cleanup(); });
function invoke(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../bin/agentchat"), "claude-inbound", ...args], { cwd: f.root,
    env: testEnv({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENTCHAT_GIT_BIN: "/missing/git", CODEX_THREAD_ID: "invalid", AGENTCHAT_CLAUDE_SESSION_ID: "also-invalid", ...extra }), encoding: "utf8" });
  return { ...result, data: JSON.parse(result.stdout.trim() || result.stderr.trim()) };
}
function prepare(content: string): string {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { mode: 0o700 });
  const path = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"); writeFileSync(path, content, { mode: 0o600 }); return path;
}

test("inbound inspection and preview require no project or native identity and do not write files", () => {
  const before = readdirSync(f.root);
  const status = invoke([]); expect(status.status).toBe(0); expect(status.data.configured).toBeNull();
  const plan = invoke(["accept"]); expect(plan.status).toBe(0); expect(plan.data.applied).toBe(false); expect(plan.data.changed).toBe(true);
  expect(plan.data.scope).toBe("user"); expect(plan.data.note).toContain("not just AgentChat");
  expect(plan.data.reception_verified).toBe(false); expect(readdirSync(f.root)).toEqual(before);
  expect(invoke(["default", "--apply"]).data.changed).toBe(false); expect(readdirSync(f.root)).toEqual(before);
  const applied = invoke(["accept", "--apply"]);
  expect(applied.status).toBe(0); expect(applied.data.backup).toBeNull();
  expect(JSON.parse(readFileSync(applied.data.path, "utf8"))).toEqual({ crossSessionInbound: "accept" });
  expect(lstatSync(applied.data.path).mode & 0o777).toBe(0o600);
  expect(existsSync(f.project.room)).toBe(false);
});
test("explicit apply backs up exact bytes, preserves other settings and is idempotent", () => {
  const before = '{"permissions":{"deny":["Bash(curl:*)"]},"env":{"SECRET":"do-not-print"},"hooks":{"Stop":[]}}\n';
  const path = prepare(before); chmodSync(path, 0o640);
  const result = invoke(["accept", "--apply"]);
  expect(result.status).toBe(0); expect(result.data.applied).toBe(true); expect(result.data.configured).toBe("accept");
  expect(readFileSync(result.data.backup, "utf8")).toBe(before);
  expect(lstatSync(result.data.backup).mode & 0o777).toBe(0o600);
  expect(lstatSync(path).mode & 0o777).toBe(0o640);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...JSON.parse(before), crossSessionInbound: "accept" });
  expect(result.stdout).not.toContain("do-not-print"); expect(result.stdout).not.toContain("Bash(curl");
  const after = readFileSync(path, "utf8"), time = lstatSync(path).mtimeMs;
  const repeated = invoke(["accept", "--apply"]);
  expect(repeated.data.changed).toBe(false); expect(repeated.data.backup).toBeNull();
  expect(readFileSync(path, "utf8")).toBe(after); expect(lstatSync(path).mtimeMs).toBe(time);
  expect(existsSync(f.project.room)).toBe(false);
});
test("hold, refuse and default provide explicit reversal without overwriting unrelated settings", () => {
  const path = prepare('{"crossSessionInbound":"accept","model":"keep"}\n');
  for (const choice of ["hold", "refuse"]) {
    expect(invoke([choice, "--apply"]).data.configured).toBe(choice);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "keep", crossSessionInbound: choice });
  }
  expect(invoke(["default", "--apply"]).data.configured).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "keep" });
});
test("malformed settings, nonobjects and linked files are refused without touching their contents", () => {
  const path = prepare("malformed JSON");
  for (const text of ["malformed JSON", "[]", "null", '"text"']) {
    writeFileSync(path, text); const result = invoke(["accept", "--apply"]);
    expect(result.status).toBe(2); expect(result.data.error.code).toBe("E_CONFIG"); expect(readFileSync(path, "utf8")).toBe(text);
  }
  const linked = join(f.root, "linked-config"); symlinkSync(process.env.CLAUDE_CONFIG_DIR!, linked);
  expect(invoke(["accept", "--apply"], { CLAUDE_CONFIG_DIR: linked }).data.error.code).toBe("E_PERMISSIONS");
  expect(invoke(["accept", "--apply"], { CLAUDE_CONFIG_DIR: linked + "/" }).data.error.code).toBe("E_PERMISSIONS");
  const other = join(f.root, "file-link-config"); mkdirSync(other, { mode: 0o700 }); symlinkSync(path, join(other, "settings.json"));
  expect(invoke(["accept", "--apply"], { CLAUDE_CONFIG_DIR: other }).data.error.code).toBe("E_PERMISSIONS");
  expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, ".agentchat-backups"))).toBe(false);
});
test("stale previews never overwrite a changed user settings file", () => {
  const path = prepare('{"model":"first"}\n'), plan = planClaudeInbound("accept");
  writeFileSync(path, '{"model":"changed-by-user"}\n');
  expect(() => applyClaudeInbound(plan)).toThrow("changed since preview");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "changed-by-user" });
  chmodSync(path, 0o666); expect(invoke(["accept", "--apply"]).data.error.code).toBe("E_CONFIG");
});
test("inbound command rejects ambiguous scopes and never discovers or initializes a project", () => {
  for (const args of [["--apply"], ["yes", "--apply"], ["accept", "extra"], ["accept", "--project", f.root], ["accept", "--room", "review"], ["accept", "--as", "another"]]) {
    expect(invoke(args).status).toBe(2);
  }
  expect(invoke([], { CLAUDE_CONFIG_DIR: "relative" }).data.error.code).toBe("E_CONFIG"); expect(readdirSync(f.root)).toEqual([]);
});
test("doctor distinguishes a configured user value from verified effective native policy", () => {
  prepare('{"crossSessionInbound":"accept"}\n');
  const env = testEnv({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENTCHAT_CLAUDE_SESSION_ID: "887f5eb8-55e9-434f-ace4-6f7f53e0150b" });
  expect(cli(f.root, ["join"], env).status).toBe(0);
  const result = cli(f.root, ["doctor"], env);
  expect(result.data.claude_inbound.configured).toBe("accept"); expect(result.data.claude_inbound.effective_policy_verified).toBe(false);
  expect(result.data.claude_inbound.reception_verified).toBe(false);
});
