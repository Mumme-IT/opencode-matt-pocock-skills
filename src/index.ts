import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { createHooks } from "./manager.js";
import { resolveOptions, type MattPocockSkillsOptions } from "./options.js";
import { createRuntime } from "./runtime.js";

export type { MattPocockSkillsOptions, UpdateMode } from "./options.js";

const plugin = (async (_input, options?: PluginOptions) =>
  createHooks(resolveOptions(options), createRuntime())) satisfies Plugin;

export default plugin;
