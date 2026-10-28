import { join } from "node:path";
import type { OwnerSkillsSnapshot } from "@pi-orb/protocol";
import { materializeOwnerSkills as install } from "../owner-skills/materialize.ts";

/** Claude user skills retain their priority over project skills. */
export const materializeOwnerSkills = (configDir: string, skills: OwnerSkillsSnapshot["skills"]) =>
  install(join(configDir, "skills"), skills);
