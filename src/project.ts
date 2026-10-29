import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { requireThat } from "./errors.ts";
import type { Project } from "./types.ts";

export function integrationDir(project: Project): string { return project.integration ?? project.room; }
export function baseProject(project: Project): Project {
  return { ...project, integration: integrationDir(project), room: integrationDir(project), roomName: "default" };
}

export function discoverProject(cwd = process.cwd(), roomOverride?: string): Project {
  const current = realpathSync(cwd);
  let gitMarker = false;
  for (let at = current; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) { gitMarker = true; break; }
    if (at === dirname(at)) break;
  }
  const git = (args: string[]) => {
    const binary = process.env.AGENTCHAT_GIT_BIN ?? (process.platform === "darwin" && process.arch === "arm64" && existsSync("/usr/bin/git") ? "/usr/bin/git" : "git");
    const env = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete (env as NodeJS.ProcessEnv)[key];
    const result = spawnSync(binary, ["-C", current, "rev-parse", ...args], { env, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
    if (result.status === 0 && !result.error && !result.signal) return result.stdout.trim();
    const genuinelyOutsideGit = !gitMarker && result.status === 128 && /not a git repository/i.test(result.stderr ?? "");
    requireThat(genuinelyOutsideGit, "E_PROJECT", "Git project discovery failed; refusing to create or select a different room. Check Git availability and permissions.");
    return null;
  };
  const top = git(["--show-toplevel"]);
  if (top) {
    const common = git(["--path-format=absolute", "--git-common-dir"]);
    requireThat(common, "E_PROJECT", "Cannot resolve Git common directory");
    const gitCommonDir = realpathSync(common);
    return { root: realpathSync(top), gitCommonDir, room: roomOverride ? resolve(roomOverride) : join(gitCommonDir, "agentchat") };
  }
  let root = current;
  for (let at = current; ; at = dirname(at)) {
    if (existsSync(join(at, ".agentchat"))) { root = at; break; }
    if (at === dirname(at) || at === homedir()) break;
  }
  requireThat(root !== homedir() && root !== dirname(root), "E_PROJECT", "Choose a project directory, not the home or filesystem root");
  return { root, gitCommonDir: null, room: roomOverride ? resolve(roomOverride) : join(root, ".agentchat") };
}
