import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { baseProject, integrationDir } from "./project.ts";
import { privateDirectory, readJson, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { sessionId } from "./identity.ts";
import { Store } from "./store.ts";
import { tryLock } from "./lock.ts";
import type { Identity, Member, Project } from "./types.ts";

export function roomName(project: Project): string { return project.roomName ?? "default"; }
function name(value: string): string {
  requireThat(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value), "E_ROOM", "Room names use 1–64 lowercase letters, digits, underscores or hyphens");
  return value;
}
export function roomProject(project: Project, value: string): Project {
  const base = integrationDir(project), selected = name(value);
  return { ...project, integration: base, roomName: selected, room: selected === "default" ? base : join(base, "rooms", selected) };
}
export function roomExists(project: Project): boolean {
  if (existsSync(project.room)) {
    const info = lstatSync(project.room);
    requireThat(info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid()) && (info.mode & 0o077) === 0,
      "E_PERMISSIONS", "Room must be an owned private directory, not a symlink");
  }
  const metadata = readJson<{ name: string }>(join(project.room, "room.json"));
  if (metadata) requireThat(metadata.name === roomName(project), "E_ROOM", "Room metadata does not match its directory");
  return existsSync(join(project.room, "chat.db")) && (roomName(project) === "default" || !!metadata);
}
export function createRoom(project: Project, value: string): Record<string, unknown> {
  const target = roomProject(project, value);
  privateDirectory(integrationDir(project));
  const release = tryLock(join(integrationDir(project), "rooms.lock"));
  requireThat(release, "E_BUSY", "Another room is being created");
  try {
    if (roomExists(target)) return { ok: true, created: false, name: roomName(target), room: target.room };
    if (roomName(target) !== "default") privateDirectory(join(integrationDir(project), "rooms"));
    const store = new Store(target.room, { create: true }); store.close();
    writeJson(join(target.room, "room.json"), { name: roomName(target), createdAt: Date.now() });
    return { ok: true, created: true, name: roomName(target), room: target.room };
  } finally { release(); }
}
function selectionPath(project: Project, identity: Identity): string | null {
  if (identity.runtime === "generic" || !identity.session) return null;
  return join(integrationDir(project), "room-selections", `${identity.runtime}-${sessionId(identity.session)}.json`);
}
export function selectedRoom(project: Project, identity?: Identity): string {
  const path = identity ? selectionPath(project, identity) : null;
  const value = path ? readJson<{ runtime: string; session: string; name: string }>(path) : null;
  if (!value) return "default";
  requireThat(value.runtime === identity!.runtime && value.session === identity!.session, "E_IDENTITY", "Room selection belongs to another native session");
  return name(value.name);
}
export function resolveRoom(project: Project, selector?: string, identity?: Identity): Project {
  let selected = selector ?? selectedRoom(project, identity);
  if (isAbsolute(selected)) {
    const absolute = resolve(selected), base = integrationDir(project);
    if (absolute === base) selected = "default";
    else {
      const prefix = join(base, "rooms") + "/";
      requireThat(absolute.startsWith(prefix), "E_ROOM", "Room paths must belong to this project; use room create/use with a name");
      selected = absolute.slice(prefix.length);
    }
  }
  const target = roomProject(project, selected);
  requireThat(selected === "default" || roomExists(target), "E_ROOM", "Room does not exist; use room create NAME first");
  return target;
}
export function selectRoom(project: Project, identity: Identity): void {
  const path = selectionPath(project, identity);
  if (path && selectedRoom(project, identity) !== roomName(project)) writeJson(path, { runtime: identity.runtime, session: identity.session, name: roomName(project) });
}
export async function withRoomSelection<T>(project: Project, identity: Identity, action: () => Promise<T>): Promise<T> {
  const path = selectionPath(project, identity);
  if (!path) return action();
  privateDirectory(join(integrationDir(project), "room-selections"));
  const deadline = Date.now() + 5000;
  let release: (() => void) | null;
  while (!(release = tryLock(path + ".lock"))) {
    requireThat(Date.now() < deadline, "E_BUSY", "Another command is selecting this session's room");
    await Bun.sleep(10);
  }
  try { return await action(); } finally { release(); }
}
export function memberRoomSelected(project: Project, member: Member): boolean {
  return !member.session_ref || selectedRoom(project, { runtime: member.runtime, session: member.session_ref }) === roomName(project);
}
export function legacyMember(project: Project, member: Member): Member | null {
  if (project.room === integrationDir(project)) return member;
  if (!member.session_ref || !existsSync(join(integrationDir(project), "chat.db"))) return null;
  const store = new Store(integrationDir(project), { readonly: true });
  try { return store.db.query("SELECT * FROM members WHERE runtime=? AND session_ref=?").get(member.runtime, member.session_ref) as Member | null; }
  finally { store.close(); }
}
export function listRooms(project: Project, identity?: Identity): Record<string, unknown> {
  const rooms = [baseProject(project)];
  const directory = join(integrationDir(project), "rooms");
  if (existsSync(directory)) {
    requireThat(!lstatSync(directory).isSymbolicLink(), "E_PERMISSIONS", "Refusing a symlink in the room directory");
    const entries = readdirSync(directory, { withFileTypes: true });
    requireThat(entries.length <= 256, "E_ROOM", "Too many room directories");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      requireThat(!entry.isSymbolicLink(), "E_PERMISSIONS", "Refusing a symlink in the room directory");
      if (entry.isDirectory()) rooms.push(roomProject(project, entry.name));
    }
  }
  const current = identity ? selectedRoom(project, identity) : null;
  return { ok: true, current, rooms: rooms.filter(roomExists).map(value => ({ name: roomName(value), room: value.room, selected: roomName(value) === current })) };
}
