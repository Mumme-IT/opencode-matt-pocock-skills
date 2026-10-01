import { Plugin } from "@opencode/plugin";
import { setupSkills } from "./plugin.js";
import { resolveOptions } from "./options.js";
import { createRuntime } from "./runtime.js";

export type { MattPocockSkillsOptions, UpdateMode } from "./options.js";

export default Plugin.define({
  id: "opencode-matt-pocock-skills",
  setup(ctx) {
    return setupSkills(
      ctx.skill,
      resolveOptions(ctx.options, process.env, ctx.location.directory),
      createRuntime(),
    );
  },
});
