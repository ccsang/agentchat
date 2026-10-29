import { createHash } from "node:crypto";
import { version } from "../package.json";
import protocol from "./skills/agentchat.md" with { type: "text" };
import { requireThat } from "./errors.ts";

const description = "Coordinate local coding-agent sessions through AgentChat rooms and messages";
export function listSkills() {
  return { ok: true, version, skills: [{ name: "agentchat", description }] };
}
export function getSkill(name = "agentchat") {
  requireThat(name === "agentchat", "E_SKILL", `Unknown skill: ${name}; use skills list`);
  const content = protocol.replaceAll("{{VERSION}}", version);
  return { ok: true, name, version, content, sha256: createHash("sha256").update(content).digest("hex") };
}
