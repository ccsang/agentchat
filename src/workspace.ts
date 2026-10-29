import { createHash } from "node:crypto";
import { join } from "node:path";
import { integrationDir } from "./project.ts";
import { readJson } from "./files.ts";
import type { Project } from "./types.ts";

export function workspaceDir(project: Project): string {
  return join(integrationDir(project), "workspaces", createHash("sha256").update(project.root).digest("hex"));
}
export function installation(project: Project): { installed: boolean; routingVersion?: number; command?: unknown; interpreter?: string; tool?: string } | null {
  return readJson(join(workspaceDir(project), "installed.json")) ?? readJson(join(integrationDir(project), "installed.json"));
}
