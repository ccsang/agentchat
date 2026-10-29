import { closeSync, openSync } from "node:fs";
import { dlopen } from "bun:ffi";
import { createPrivateFile, regularFile } from "./files.ts";
import { requireThat } from "./errors.ts";

// Kernel advisory locks are released on process death, including SIGKILL. No PID-based lock stealing.
let native: ReturnType<typeof load> | undefined;
function load() {
  requireThat(process.platform === "darwin" || process.platform === "linux", "E_PLATFORM", "Automatic receivers require macOS or Linux");
  return dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
  });
}
export function tryLock(path: string, create = true): (() => void) | null {
  if (create) createPrivateFile(path); else regularFile(path);
  native ??= load();
  const fd = openSync(path, "r+");
  if (native.symbols.flock(fd, 2 | 4) !== 0) { closeSync(fd); return null; }
  return () => { native!.symbols.flock(fd, 8); closeSync(fd); };
}
