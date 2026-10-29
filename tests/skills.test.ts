import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyInstall, planInstall } from "../src/install.ts";
import { version } from "../package.json";
import { cli, fixture, testEnv } from "./helpers.ts";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); }); afterEach(() => f.cleanup());
const repository = resolve(import.meta.dir, "..");
function raw(args: string[]) {
  return spawnSync(process.execPath, [join(repository, "bin/agentchat"), ...args], { cwd: f.root,
    env: testEnv({ CODEX_THREAD_ID: "invalid", AGENTCHAT_CLAUDE_SESSION_ID: "conflicting-invalid", AGENTCHAT_GIT_BIN: "/missing/git" }),
    encoding: "utf8", timeout: 15000 });
}
test("embedded protocol reads without project discovery or native identity and leaves no files", () => {
  const before = readdirSync(f.root);
  const result = raw(["--project", join(f.root, "nonexistent"), "skills", "get"]);
  expect(result.status).toBe(0);
  const json = JSON.parse(raw(["skills", "get", "agentchat", "--json"]).stdout);
  expect(json.version).toBe(version); expect(json.content).toBe(result.stdout);
  expect(json.sha256).toBe(createHash("sha256").update(result.stdout).digest("hex"));
  expect(result.stdout).toContain(`CLI version: ${version}`);
  expect(readdirSync(f.root)).toEqual(before);
});
test("skill discovery and errors are explicit, read-only and never fall through to join", () => {
  const list = cli(f.root, ["skills", "list"]);
  expect(list.status).toBe(0); expect(list.data.version).toBe(version);
  expect(list.data.skills.map((s: { name: string }) => s.name)).toEqual(["agentchat"]);
  for (const args of [["skills"], ["skills", "list", "extra"], ["skills", "get", "--apply"], ["skills", "get", "--room", "other"]]) expect(raw(args).status).toBe(2);
  const missing = cli(f.root, ["skills", "get", "../other", "--json"]);
  expect(missing.data.error.code).toBe("E_SKILL"); expect(readdirSync(f.root)).toEqual([]);
});
test("private installed bundle serves its own protocol without a source Markdown dependency", async () => {
  applyInstall(await planInstall(f.project));
  const script = join(f.project.room, "agentchat.js");
  const result = spawnSync(process.execPath, [script, "skills", "get", "--json"], { cwd: f.root, env: testEnv(), encoding: "utf8" });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).version).toBe(version);
  expect(JSON.parse(result.stdout).content).toBe(cli(f.root, ["skills", "get", "--json"]).data.content);
  expect(existsSync(join(f.project.room, "skills"))).toBe(false);
  expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false); expect(existsSync(join(f.root, ".claude"))).toBe(false);
});
test("both marketplaces discover one shared thin skill and consistent portable/host manifests", () => {
  const read = (path: string) => JSON.parse(readFileSync(join(repository, path), "utf8"));
  const claude = read(".claude-plugin/marketplace.json"), codex = read(".agents/plugins/marketplace.json");
  const selected = claude.plugins[0], directory = resolve(repository, selected.source);
  expect(directory).toBe(resolve(repository, codex.plugins[0].source.path));
  const portable = JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8"));
  expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  for (const host of [".claude-plugin", ".codex-plugin"]) {
    const manifest = JSON.parse(readFileSync(join(directory, host, "plugin.json"), "utf8"));
    expect(manifest.name).toBe(portable.name); expect(manifest.version).toBe(portable.version);
  }
  expect(selected.name).toBe(portable.name); expect(codex.plugins[0].name).toBe(portable.name);
  const skill = readFileSync(join(directory, "skills/agentchat/SKILL.md"), "utf8");
  const frontmatter = Bun.YAML.parse(skill.split("---")[1]!) as { name: string; description: string };
  expect(frontmatter.name).toBe("agentchat"); expect(frontmatter.description.length).toBeGreaterThan(20);
  expect(existsSync(join(directory, "hooks"))).toBe(false); expect(existsSync(join(directory, "mcp.json"))).toBe(false);
});
