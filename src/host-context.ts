import { basename } from "node:path";
import type { Ancestor } from "./lifecycle.ts";

// Only transparent native tool/hook shims may be crossed. An unrecognized
// language runtime may itself host a nested agent and is an identity boundary.
export function nearestHost(ancestors: Ancestor[]): { runtime: "agy" | "claude" | "codex"; process: Ancestor } | null {
  for (const process of ancestors) {
    const executable = basename(process.executable ?? "").toLowerCase();
    if (executable === "agy") return { runtime: "agy", process };
    if (executable === "claude") return { runtime: "claude", process };
    if (executable === "codex") return { runtime: "codex", process };
    if (!/^(?:sh|bash|zsh|dash|fish|env)$/.test(executable)) return null;
  }
  return null;
}
