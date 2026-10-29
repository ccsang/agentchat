import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { version } from "../package.json";

const root = resolve(import.meta.dir, "..");
if (Bun.version !== "1.3.14") throw new Error("Release builds require the pinned Bun 1.3.14 runtime");
const { values } = parseArgs({ options: { target: { type: "string" }, outdir: { type: "string" } } });
const target = values.target ?? `${process.platform}-${process.arch}`;
const targets: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64", "darwin-x64": "bun-darwin-x64-baseline",
  "linux-arm64": "bun-linux-arm64", "linux-x64": "bun-linux-x64-baseline",
};
if (!targets[target]) throw new Error(`Unsupported release target: ${target}`);
if (!readFileSync(join(root, "install.sh"), "utf8").includes(`AGENTCHAT_VERSION="v${version}"`)) throw new Error("Installer and package versions differ");
const outdir = resolve(values.outdir ?? join(root, "dist/release"));
mkdirSync(outdir, { recursive: true });
const name = `agentchat-v${version}-${target}`, binary = join(outdir, name), metafile = join(outdir, `metafile-${target}.json`);
const result = spawnSync(process.execPath, ["build", join(root, "src/cli.ts"), "--compile", `--target=${targets[target]}`, "--minify",
  "--define", "AGENTCHAT_STANDALONE=true", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", `--metafile=${metafile}`, "--outfile", binary],
{ cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const bytes = readFileSync(binary), compressed = gzipSync(bytes, { level: 9 });
writeFileSync(`${binary}.gz`, compressed);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
writeFileSync(join(outdir, `SHA256SUMS-${target}`), `${digest(bytes)}  ${name}\n${digest(compressed)}  ${name}.gz\n`);
const packages = new Map<string, string>();
const inputs = JSON.parse(readFileSync(metafile, "utf8")).inputs as Record<string, unknown>;
for (const input of Object.keys(inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== dirname(directory)) {
    const metadata = join(directory, "package.json");
    if (existsSync(metadata)) {
      const pkg = JSON.parse(readFileSync(metadata, "utf8"));
      if (pkg.name && pkg.version) {
        const license = readdirSync(directory).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
        if (!license) throw new Error(`Missing bundled dependency license: ${pkg.name}`);
        packages.set(`${pkg.name}@${pkg.version}`, readFileSync(join(directory, license), "utf8"));
        break;
      }
    }
    directory = dirname(directory);
  }
}
const notices = [`AgentChat ${version}: third-party notices\n\nBun ${Bun.version} runtime and its linked libraries\nSource: https://github.com/oven-sh/bun/tree/bun-v${Bun.version}\n\n${readFileSync(join(root, "third_party/bun-LICENSE.md"), "utf8")}`,
  ...[...packages.keys()].sort().map(name => `\n---\n\n${name}\n\n${packages.get(name)}`)];
writeFileSync(join(outdir, `THIRD_PARTY_LICENSES-${target}.txt`), notices.join("\n"));
console.log(JSON.stringify({ version, target, binary, asset: `${binary}.gz`, bytes: bytes.length, compressed_bytes: compressed.length }));
