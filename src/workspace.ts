import { createHash } from "node:crypto";
import { join } from "node:path";
import { integrationDir } from "./project.ts";
import { readJson } from "./files.ts";
import type { Project } from "./types.ts";
import { requireThat } from "./errors.ts";

export interface Integration { instructions: boolean; hooks: boolean }
interface Installation {
  installed: boolean; root?: string; routingVersion?: number; setupVersion?: number; command?: unknown;
  interpreter?: string; tool?: string; integration?: Integration;
}

export function workspaceDir(project: Project): string {
  return join(integrationDir(project), "workspaces", createHash("sha256").update(project.root).digest("hex"));
}
export function installation(project: Project): Installation | null {
  return readJson(join(workspaceDir(project), "installed.json")) ?? readJson(join(integrationDir(project), "installed.json"));
}
export function integrationSettings(project: Project): Integration {
  const saved = installation(project);
  // The shared fallback may describe a different worktree; opt-in is workspace-local.
  if (saved?.root && saved.root !== project.root) return { instructions: false, hooks: false };
  if (saved?.integration) {
    requireThat(typeof saved.integration.instructions === "boolean" && typeof saved.integration.hooks === "boolean", "E_CONFIG", "Invalid optional project integration metadata");
    return saved.integration;
  }
  // Earlier releases always enabled both. Preserve that fact without rewriting those files.
  const legacy = !!saved?.installed && saved.setupVersion === undefined;
  return { instructions: legacy, hooks: legacy };
}
