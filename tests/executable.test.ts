import { expect, test } from "bun:test";
import { installedCommand } from "../src/executable.ts";
import { writeJson } from "../src/files.ts";
import { join } from "node:path";
import { fixture } from "./helpers.ts";

test("legacy installations retain their pinned interpreter and tool during launcher preparation", () => {
  const f = fixture();
  try {
    writeJson(join(f.project.room, "installed.json"), { interpreter: "/original/bun", tool: "/original/project/agentchat.js" });
    expect(installedCommand(f.project)).toEqual(["/original/bun", "/original/project/agentchat.js"]);
  } finally { f.cleanup(); }
});
test("installed launcher commands reject malformed or relative executable metadata", () => {
  const f = fixture();
  try {
    for (const command of [[], ["relative-tool"], ["/tool", "relative-script"], ["/tool", "/script", "/unexpected"]]) {
      writeJson(join(f.project.room, "installed.json"), { command });
      expect(() => installedCommand(f.project)).toThrow("Invalid installed");
    }
  } finally { f.cleanup(); }
});
