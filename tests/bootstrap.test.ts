import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fixture, testEnv } from "./helpers.ts";
import { version } from "../package.json";

let f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv, assets: string, log: string, execution: string, name: string;
const installer = join(import.meta.dir, "../install.sh");
beforeEach(() => {
  f = fixture(); assets = join(f.root, "assets"); const bin = join(f.root, "fake-bin");
  mkdirSync(assets); mkdirSync(bin); log = join(f.root, "downloads"); execution = join(f.root, "executed");
  const platform = process.platform, arch = process.arch;
  name = `agentchat-v${version}-${platform}-${arch}`;
  const program = Buffer.from(`#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' '${version}'; exit 0; fi\nprintf '%s\\n' "$@" > "$FIXTURE_EXECUTION"\nprintf '%s\\n' '{"ok":true}'\n`);
  writeFileSync(join(assets, `${name}.gz`), gzipSync(program));
  const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
  writeFileSync(join(assets, "SHA256SUMS"), `${hash(program)}  ${name}\n${hash(readFileSync(join(assets, `${name}.gz`)))}  ${name}.gz\n`);
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nset -eu\noutput=\nurl=\nwhile [ "$#" -gt 0 ]; do\n case "$1" in\n  --output) output=$2; shift 2 ;;\n  https://github.com/ccsang/agentchat/releases/download/*) url=$1; shift ;;\n  *) shift ;;\n esac\ndone\n[ -n "$url" ] && [ -n "$output" ]\nname=\${url##*/}\nprintf '%s\\n' "$name" >> "$FIXTURE_LOG"\nif [ "\${FIXTURE_FAIL_DOWNLOAD:-0}" = 1 ] && [ "$name" != SHA256SUMS ]; then printf partial > "$output"; exit 22; fi\ncp "$FIXTURE_ASSETS/$name" "$output"\n`, { mode: 0o700 });
  writeFileSync(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) printf '%s\\n' "\${FIXTURE_PLATFORM:-${platform === "darwin" ? "Darwin" : "Linux"}}" ;; -m) printf '%s\\n' '${arch === "arm64" ? "aarch64" : "x86_64"}' ;; esac\n`, { mode: 0o700 });
  env = testEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: f.root, AGENTCHAT_INSTALL_DIR: join(f.root, "cache with space's"),
    FIXTURE_ASSETS: assets, FIXTURE_LOG: log, FIXTURE_EXECUTION: execution });
});
afterEach(() => f.cleanup());
function install(args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/sh", [installer, "--project", f.root, ...args], { cwd: f.root, env: { ...env, ...extra }, encoding: "utf8", timeout: 5000 });
}
test("bootstrap verifies a pinned standalone download, preserves arguments and reuses the verified cache", () => {
  expect(install().status).toBe(0);
  expect(readFileSync(execution, "utf8").split("\n")).toEqual(["--project", f.root, "install", ""]);
  expect(existsSync(join(f.root, ".claude"))).toBe(false);
  expect(install(["--apply"]).status).toBe(0);
  expect(readFileSync(execution, "utf8").split("\n")).toEqual(["--project", f.root, "install", "--apply", ""]);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["SHA256SUMS", `${name}.gz`, "SHA256SUMS"]);
});
test("a corrupt download is never executed and cannot modify project settings", () => {
  writeFileSync(join(assets, `${name}.gz`), "corrupt download");
  const result = install(["--apply"]);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("checksum mismatch");
  expect(existsSync(execution)).toBe(false); expect(existsSync(join(f.root, ".claude"))).toBe(false);
});
test("the decompressed executable is checked independently before it can run", () => {
  const sums = join(assets, "SHA256SUMS"), lines = readFileSync(sums, "utf8").split("\n");
  lines[0] = `${"0".repeat(64)}  ${name}`; writeFileSync(sums, lines.join("\n"));
  const result = install();
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("Executable checksum mismatch"); expect(existsSync(execution)).toBe(false);
});
test("an interrupted download leaves no executable or configuration behind", () => {
  const result = install(["--apply"], { FIXTURE_FAIL_DOWNLOAD: "1" });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("Download failed"); expect(existsSync(execution)).toBe(false);
  expect(existsSync(join(env.AGENTCHAT_INSTALL_DIR!, `v${version}`, `${process.platform}-${process.arch}`, "agentchat"))).toBe(false);
});
test("ambiguous checksum manifests are refused", () => {
  const sums = join(assets, "SHA256SUMS"); writeFileSync(sums, readFileSync(sums, "utf8").repeat(2));
  expect(install().status).not.toBe(0); expect(existsSync(execution)).toBe(false);
});
test("unsupported systems and unknown options fail before downloading", () => {
  expect(install([], { FIXTURE_PLATFORM: "UnsupportedOS" }).status).not.toBe(0);
  expect(install(["--silently-change-policy"]).status).not.toBe(0);
  expect(existsSync(log)).toBe(false); expect(existsSync(env.AGENTCHAT_INSTALL_DIR!)).toBe(false);
});
