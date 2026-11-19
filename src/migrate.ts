import { accessSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { Store } from "./store.ts";
import { integrationDir } from "./project.ts";
import { roomName } from "./rooms.ts";
import { privateDirectory, regularFile } from "./files.ts";
import { tryLock } from "./lock.ts";
import { requireThat } from "./errors.ts";
import type { Project } from "./types.ts";

export const MIGRATION_BASELINE = "0.1.0-alpha.14";
interface Pin { source: string; kind: "entry" | "managed_hook"; version: string | null; status: "compatible" | "old" | "unknown"; fingerprint: string }
export interface MigrationPlan { project: Project; from: number; pins: Pin[] }
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function compatible(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  return parts[0]! > 0 || parts[1]! > 1 || parts[1] === 1 && (parts[2]! > 0 || !match[4] || Number(match[4]) >= 14);
}
function text(path: string, max = 1024 * 1024): string | null {
  if (!existsSync(path)) return null;
  regularFile(path, false); requireThat(lstatSync(path).size <= max, "E_CONFIG", "Participating configuration exceeds inventory budget");
  return readFileSync(path, "utf8");
}
// Only exact generated run wrappers may execute --version. Hook command text is
// never evaluated; unknown/custom wrappers are reported as unknown.
function entryVersion(command: string[], run: string): string | null {
  const wrapper = text(run, 65536);
  if (wrapper !== `#!/bin/sh\nexec ${command.map(quote).join(" ")} "$@"\n`
    && wrapper !== `#!/bin/sh\n# agentchat:program-v1\nexec ${command.map(quote).join(" ")} "$@"\n`) return null;
  for (const path of command) { regularFile(path, false); requireThat((lstatSync(path).mode & 0o022) === 0, "E_PERMISSIONS", "Participating executable is writable by others"); }
  const result = spawnSync(command[0]!, [...command.slice(1), "--version"], { encoding: "utf8", timeout: 1000,
    killSignal: "SIGKILL", maxBuffer: 1024, env: { PATH: process.env.PATH ?? "" } });
  const value = result.stdout?.trim();
  return result.status === 0 && !result.error && /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(value) ? value : null;
}
function globalEntryVersion(): string | null {
  const override = process.env.AGENTCHAT_BIN_DIR ? join(process.env.AGENTCHAT_BIN_DIR, "agentchat") : null;
  let cli: string | null = null;
  if (override) { try { accessSync(override, constants.X_OK); cli = override; } catch { /* Match the hook wrapper's fallback order. */ } }
  cli ??= Bun.which("agentchat") ?? join(homedir(), ".local", "bin", "agentchat");
  const program = text(cli, 65536), line = program?.split("\n")[2];
  if (program?.startsWith("#!/bin/sh\n# agentchat:program-v1\n") && line) {
    const command = [...line.matchAll(/'([^'\n]+)'/g)].map(m => m[1]!);
    if (command.length >= 1 && command.length <= 2 && command.every(isAbsolute)) return entryVersion(command, cli);
  }
  return null;
}
export function inventoryPins(project: Project): Pin[] {
  const base = integrationDir(project), records = [join(base, "installed.json")], roots = new Set([project.root]), pins: Pin[] = [];
  const workspaces = join(base, "workspaces");
  if (existsSync(workspaces)) {
    const entries = readdirSync(workspaces); requireThat(entries.length <= 256, "E_CONFIG", "Too many workspaces for migration inventory");
    for (const entry of entries) if (/^[0-9a-f]{64}$/.test(entry)) records.push(join(workspaces, entry, "installed.json"));
  }
  const commands = new Map<string, string | null>();
  for (const path of records) {
    let raw: string | null = null, version: string | null = null;
    try {
      raw = text(path); if (raw === null) continue;
      const saved = JSON.parse(raw) as { installed?: boolean; root?: string; command?: unknown; cli?: string; interpreter?: string; tool?: string };
      if (!saved.installed) continue;
      if (saved.root && isAbsolute(saved.root)) roots.add(saved.root);
      const command = saved.command ?? (saved.interpreter && saved.tool ? [saved.interpreter, saved.tool] : undefined);
      if (Array.isArray(command) && command.length >= 1 && command.length <= 2 && command.every(p => typeof p === "string" && isAbsolute(p))) {
        const key = JSON.stringify(command);
        version = commands.has(key) ? commands.get(key)! : entryVersion(command, join(base, "run")); commands.set(key, version);
      }
    } catch { /* An unreadable participating pin is explicitly unknown. */ }
    pins.push({ source: path, kind: "entry", version, status: version ? compatible(version) ? "compatible" : "old" : "unknown", fingerprint: digest(raw ?? "unreadable") });
  }
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  requireThat(isAbsolute(config), "E_CONFIG", "CLAUDE_CONFIG_DIR must be absolute for migration inventory");
  const settingsPaths = [...roots].flatMap(root => [join(root, ".claude", "settings.local.json"), join(root, ".claude", "settings.json")]);
  settingsPaths.push(join(config, "settings.json"));
  const pluginChoices = new Map<string, boolean>();
  for (const path of settingsPaths) { let raw: string | null = null;
    try {
      raw = text(path); if (raw === null) continue;
      const settings = JSON.parse(raw) as { enabledPlugins?: Record<string, boolean>; hooks?: Record<string, { hooks?: { command?: unknown; args?: unknown }[] }[]> };
      // Any known participating workspace enabling this plugin is relevant,
      // even if another workspace overrides it off.
      for (const [id, enabled] of Object.entries(settings.enabledPlugins ?? {})) if (id.split("@")[0] === "agentchat") pluginChoices.set(id, pluginChoices.get(id) === true || enabled === true);
      for (const groups of Object.values(settings.hooks ?? {})) for (const group of groups) for (const hook of group.hooks ?? []) {
        if (!Array.isArray(hook.args) || !hook.args.includes("--agentchat-managed=v1")) continue;
        const argv = [hook.command, ...hook.args], marker = argv.indexOf("--project");
        const prefix = marker >= 1 ? argv.slice(0, marker) : [];
        let version = commands.get(JSON.stringify(prefix)) ?? null;
        // Older structured hooks may still reference a superseded source entry.
        // Inspect its static version only; never execute a hook's command string.
        if (!version && prefix.length === 2 && prefix.every(v => typeof v === "string" && isAbsolute(v))) {
          const source = prefix[1] as string;
          if (source.startsWith(base + "/") && source.endsWith(".js")) {
            const code = text(source, 4 * 1024 * 1024);
            const matches = [...(code ?? "").matchAll(/\bvar version = "(\d+\.\d+\.\d+(?:-alpha\.\d+)?)";/g)];
            if (matches.length === 1 && code?.includes("AgentChat")) version = matches[0]![1]!;
          }
        }
        pins.push({ source: path, kind: "managed_hook", version, status: version ? compatible(version) ? "compatible" : "old" : "unknown", fingerprint: digest(raw) });
      }
    } catch {
      pins.push({ source: path, kind: "managed_hook", version: null, status: "unknown", fingerprint: digest(raw ?? "unreadable") });
    }
  }
  if ([...pluginChoices.values()].some(Boolean)) {
    const registryPath = join(config, "plugins", "installed_plugins.json"); let raw: string | null = null;
    try {
      raw = text(registryPath); const registry = raw ? JSON.parse(raw) as { plugins?: Record<string, { installPath: string; projectPath?: string }[]> } : null;
      for (const [id, enabled] of pluginChoices) if (enabled) {
        const installs = registry?.plugins?.[id];
        if (!Array.isArray(installs) || !installs.length) pins.push({ source: registryPath, kind: "managed_hook", version: null, status: "unknown", fingerprint: digest(raw ?? "missing") });
        for (const installed of installs ?? []) {
          if (installed.projectPath && !roots.has(installed.projectPath)) continue;
          let version: string | null = null;
          const source = typeof installed.installPath === "string" && isAbsolute(installed.installPath) ? join(installed.installPath, "scripts", "hook.sh") : registryPath;
          const wrapper = source === registryPath ? null : text(source, 65536);
          if (wrapper?.includes('exec "$cli" hook "plugin-$1"')) {
            version = globalEntryVersion();
          }
          pins.push({ source, kind: "managed_hook", version, status: version ? compatible(version) ? "compatible" : "old" : "unknown", fingerprint: digest((raw ?? "") + (wrapper ?? "")) });
        }
      }
    } catch { pins.push({ source: registryPath, kind: "managed_hook", version: null, status: "unknown", fingerprint: digest(raw ?? "unreadable") }); }
  }
  const agyPlugins = [...roots].map(root => join(root, ".agents", "plugins", "agentchat-agy"));
  agyPlugins.push(join(homedir(), ".gemini", "config", "plugins", "agentchat-agy"));
  for (const plugin of agyPlugins) {
    if (!existsSync(plugin)) continue;
    const source = join(plugin, "hooks.json"); let raw: string | null = null, version: string | null = null;
    try {
      const manifest = JSON.parse(text(join(plugin, "plugin.json")) ?? "null") as { name?: string } | null;
      if (manifest?.name !== "agentchat-agy") continue;
      raw = text(source); const hooks = raw ? JSON.parse(raw) as { agentchat?: { enabled?: boolean } } : null;
      if (hooks?.agentchat?.enabled === false) continue;
      const wrapper = text(join(plugin, "scripts", "hook.sh"), 65536);
      if (wrapper?.includes('exec "$cli" hook "agy-$1"')) version = globalEntryVersion();
    } catch { /* Detectable plugin hook with unknown compatibility. */ }
    pins.push({ source, kind: "managed_hook", version, status: version ? compatible(version) ? "compatible" : "old" : "unknown", fingerprint: digest(raw ?? "unreadable") });
  }
  // A recognized entry can exist before an installation record is written.
  if (!pins.some(p => p.kind === "entry") && existsSync(join(base, "run"))) pins.push({ source: join(base, "run"), kind: "entry", version: null, status: "unknown", fingerprint: digest(text(join(base, "run"), 65536) ?? "unreadable") });
  return pins;
}
export function planMigration(project: Project): MigrationPlan {
  const store = new Store(project.room, { readonly: true });
  try { return { project, from: store.schemaVersion(), pins: inventoryPins(project) }; } finally { store.close(); }
}
export function previewMigration(plan: MigrationPlan): Record<string, unknown> {
  return { ok: true, applied: false, project: plan.project.root, room: roomName(plan.project), database: join(plan.project.room, "chat.db"),
    from_schema: plan.from, to_schema: 2, needed: plan.from < 2, minimum_cli: MIGRATION_BASELINE, participating_pins: plan.pins,
    blocked_by_old_pins: plan.from < 2 && plan.pins.some(p => p.status === "old"),
    consequence: "Old executables refuse v2 with E_SCHEMA. Upgrade all participating entries/hooks first; --allow-old-pins explicitly overrides known old pins. Unknown pins do not block apply; manually verify their versions before applying. Plugin global CLI resolution uses this command's AGENTCHAT_BIN_DIR/PATH, which can differ from the native host's startup environment.",
    inventory_scope: "Known workspace entries, structured managed project/user hooks, enabled known Claude plugin hooks and detectable agy plugin hooks; unreferenced caches, running old processes and manually copied executables cannot all be discovered.",
    preserves: ["two tables", "member IDs", "message history", "read cursors", "indexes", "triggers", "notification reservations", "pauses"],
    note: "Only this room is migrated. Installation, join and reads never migrate rooms." };
}
export function applyMigration(plan: MigrationPlan, allowOldPins = false): Record<string, unknown> {
  const release = tryLock(join(plan.project.room, "migration.lock"));
  requireThat(release, "E_BUSY", "Another migration is running for this room");
  let store: Store | undefined, backup: string | null = null;
  try {
    const currentPins = inventoryPins(plan.project);
    requireThat(JSON.stringify(currentPins) === JSON.stringify(plan.pins), "E_CONFLICT", "Participating entries changed since preview; preview again");
    requireThat(plan.from === 2 || allowOldPins || !currentPins.some(p => p.status === "old"), "E_OLD_PINS", "Upgrade known participating entries/hooks before migration, or explicitly choose --allow-old-pins; old CLIs then refuse this room with E_SCHEMA");
    store = new Store(plan.project.room);
    requireThat(store.schemaVersion() === plan.from, "E_CONFLICT", "Room schema changed since preview");
    if (plan.from === 2) return { ...previewMigration(plan), applied: true, changed: false, backup: null };
    const db = store.db;
    // Disabling FK enforcement outside the EXCLUSIVE transaction is required
    // for SQLite's table replacement procedure. Validate again before commit.
    db.exec("PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE");
    try {
      const columns = db.query("PRAGMA table_info(members)").all() as { name: string }[];
      requireThat(columns.map(c => c.name).join(",") === "id,name,runtime,session_ref,read_seq,created_at", "E_SCHEMA", "Unexpected member columns; migration refused");
      requireThat(db.query("PRAGMA foreign_key_check").all().length === 0, "E_SCHEMA", "Room has broken foreign keys before migration");
      const objects = db.query("SELECT sql FROM sqlite_master WHERE tbl_name='members' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all() as { sql: string }[];
      backup = join(plan.project.room, "backups", `schema-v1-${randomUUID()}.db`); privateDirectory(dirname(backup));
      const fd = openSync(backup, "wx", 0o600);
      try { writeFileSync(fd, db.serialize()); fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(dirname(backup), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
      db.exec(`CREATE TABLE members_v2 (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude','agy','generic')),
        session_ref TEXT, read_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_seq >= 0), created_at INTEGER NOT NULL,
        CHECK(runtime = 'generic' OR session_ref IS NOT NULL));
        INSERT INTO members_v2 SELECT id,name,runtime,session_ref,read_seq,created_at FROM members;
        DROP TABLE members; ALTER TABLE members_v2 RENAME TO members;`);
      for (const object of objects) db.exec(object.sql);
      db.exec("PRAGMA user_version=2");
      requireThat(db.query("PRAGMA foreign_key_check").all().length === 0, "E_SCHEMA", "Migration foreign-key validation failed");
      requireThat((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok", "E_SCHEMA", "Migration integrity check failed");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.exec("PRAGMA foreign_keys=ON"); }
    return { ...previewMigration(plan), applied: true, changed: true, backup, old_pins_overridden: allowOldPins && currentPins.some(p => p.status === "old") };
  } finally { store?.close(); release(); }
}
