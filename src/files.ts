import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireThat } from "./errors.ts";

export function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(), "E_PERMISSIONS", `Not a private directory: ${path}`);
  requireThat(process.getuid === undefined || stat.uid === process.getuid(), "E_PERMISSIONS", `Directory has another owner: ${path}`);
  requireThat(process.platform === "win32" || (stat.mode & 0o077) === 0, "E_PERMISSIONS", `Directory must be owner-only: ${path}`);
}
export function regularFile(path: string, privateOnly = true): void {
  const stat = lstatSync(path);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), "E_PERMISSIONS", `Refusing non-regular file: ${path}`);
  requireThat(process.getuid === undefined || stat.uid === process.getuid(), "E_PERMISSIONS", `File has another owner: ${path}`);
  requireThat(!privateOnly || process.platform === "win32" || (stat.mode & 0o077) === 0, "E_PERMISSIONS", `File must be owner-only: ${path}`);
}
export function createPrivateFile(path: string): void {
  try { const fd = openSync(path, "wx", 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  regularFile(path);
}
export function atomicWrite(path: string, data: string, mode = 0o600): void {
  if (pathPresent(path)) regularFile(path, false);
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    fchmodSync(fd, mode);
    writeFileSync(fd, data, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function readJson<T>(path: string): T | null {
  if (!pathPresent(path)) return null;
  regularFile(path);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function writeJson(path: string, data: unknown): void {
  privateDirectory(dirname(path)); atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
}
