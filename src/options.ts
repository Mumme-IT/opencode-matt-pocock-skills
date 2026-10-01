import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type UpdateMode = "background" | "blocking" | "off";

export interface MattPocockSkillsOptions {
  stateDir?: string;
  updateMode?: UpdateMode;
  checkIntervalMs?: number;
  checkTimeoutMs?: number;
  installTimeoutMs?: number;
}

export interface ResolvedOptions {
  stateDir: string;
  updateMode: UpdateMode;
  checkIntervalMs: number;
  checkTimeoutMs: number;
  installTimeoutMs: number;
}

const defaults = {
  updateMode: "background",
  checkIntervalMs: 24 * 60 * 60 * 1_000,
  checkTimeoutMs: 2_500,
  installTimeoutMs: 120_000,
} as const;

function duration(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim();
  const openCodeState =
    stateHome && isAbsolute(stateHome)
      ? resolve(stateHome, "opencode")
      : resolve(homedir(), ".local", "state", "opencode");
  return resolve(openCodeState, "opencode-matt-pocock-skills");
}

export function resolveOptions(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  directory: string = process.cwd(),
): ResolvedOptions {
  if (
    value !== undefined &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  ) {
    throw new TypeError("plugin options must be an object");
  }

  const options = (value ?? {}) as MattPocockSkillsOptions;
  const updateMode = options.updateMode ?? defaults.updateMode;
  if (!(["background", "blocking", "off"] as const).includes(updateMode)) {
    throw new TypeError(
      'updateMode must be "background", "blocking", or "off"',
    );
  }

  let stateDir = options.stateDir ?? defaultStateDir(env);
  if (typeof stateDir !== "string" || stateDir.trim() === "") {
    throw new TypeError("stateDir must be a non-empty string");
  }
  stateDir = resolve(directory, stateDir);

  return {
    stateDir,
    updateMode,
    checkIntervalMs: duration(
      options.checkIntervalMs,
      "checkIntervalMs",
      defaults.checkIntervalMs,
    ),
    checkTimeoutMs: duration(
      options.checkTimeoutMs,
      "checkTimeoutMs",
      defaults.checkTimeoutMs,
    ),
    installTimeoutMs: duration(
      options.installTimeoutMs,
      "installTimeoutMs",
      defaults.installTimeoutMs,
    ),
  };
}
