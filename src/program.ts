import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { atomicWrite, regularFile } from "./files.ts";
import { requireThat } from "./errors.ts";
import { standalone } from "./executable.ts";
import { version } from "../package.json";

export function setupProgram(): Record<string, unknown> {
  requireThat(standalone, "E_BUILD", "Use the standalone release installer to install the program; source users can run bin/agentchat directly");
  const directory = process.env.AGENTCHAT_BIN_DIR ?? join(homedir(), ".local", "bin");
  requireThat(isAbsolute(directory), "E_CONFIG", "AGENTCHAT_BIN_DIR must be absolute");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const cli = join(realpathSync(directory), "agentchat"), marker = "# agentchat:program-v1\n";
  if (existsSync(cli)) {
    regularFile(cli, false);
    requireThat(statSync(cli).size <= 65536 && readFileSync(cli, "utf8").startsWith(`#!/bin/sh\n${marker}`), "E_CONFLICT", "An unrelated agentchat command already exists; choose AGENTCHAT_BIN_DIR");
  }
  const executable = realpathSync(process.execPath), quoted = `'${executable.replaceAll("'", "'\\''")}'`;
  atomicWrite(cli, `#!/bin/sh\n${marker}exec ${quoted} "$@"\n`, 0o755);
  return { ok: true, version, cli, executable, program_installed: true, project_initialized: false,
    next: "Run this command with join inside a project; the first join initializes that project automatically" };
}
