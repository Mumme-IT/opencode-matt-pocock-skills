import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export const SKILLS_CLI_VERSION = "1.5.22";
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

const PASSTHROUGH_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_STRICT_SSL",
]);

export interface Runtime {
  fetch: typeof globalThis.fetch;
  install: (
    cwd: string,
    upstreamCommitSha: string,
    timeoutMs: number,
  ) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  randomId: () => string;
  warn: (message: string) => void;
}

export interface InstallerDependencies {
  spawnProcess: typeof spawn;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
}

export function assertCommitSha(value: string): void {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(
      "upstream commit SHA must be exactly 40 lowercase hex characters",
    );
  }
}

export function archiveUrl(upstreamCommitSha: string): string {
  assertCommitSha(upstreamCommitSha);
  return `https://github.com/mattpocock/skills/archive/${upstreamCommitSha}.tar.gz`;
}

export function buildSkillsArguments(upstreamCommitSha: string): string[] {
  return [
    "--yes",
    `skills@${SKILLS_CLI_VERSION}`,
    "add",
    archiveUrl(upstreamCommitSha),
    "--agent",
    "opencode",
    "--skill",
    "*",
    "-y",
    "--full-depth",
    "--copy",
  ];
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSTHROUGH_ENVIRONMENT.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  environment.DISABLE_TELEMETRY = "1";
  environment.DO_NOT_TRACK = "1";
  environment.CI = "1";
  environment.NO_COLOR = "1";
  return environment;
}

function terminateWindowsTree(
  child: ChildProcess,
  dependencies: InstallerDependencies,
  environment: NodeJS.ProcessEnv,
): void {
  if (child.pid === undefined) return;
  const killer = dependencies.spawnProcess(
    "taskkill",
    ["/PID", String(child.pid), "/T", "/F"],
    {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      env: environment,
    },
  );
  killer.once("error", () => child.kill());
}

export function createInstaller(
  overrides: Partial<InstallerDependencies> = {},
): Runtime["install"] {
  const dependencies: InstallerDependencies = {
    spawnProcess: spawn,
    platform: process.platform,
    environment: process.env,
    killProcessGroup: (pid, signal) => process.kill(-pid, signal),
    ...overrides,
  };

  return (cwd, upstreamCommitSha, timeoutMs) => {
    const executable = dependencies.platform === "win32" ? "npx.cmd" : "npx";
    const environment = buildChildEnvironment(dependencies.environment);
    const args = buildSkillsArguments(upstreamCommitSha);

    return new Promise((resolve, reject) => {
      const child = dependencies.spawnProcess(executable, args, {
        cwd,
        detached: dependencies.platform !== "win32",
        env: environment,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (error) reject(error);
        else resolve();
      };

      const timeoutError = (): Error =>
        new Error(`skills CLI timed out after ${timeoutMs}ms`);

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (dependencies.platform === "win32") {
          terminateWindowsTree(child, dependencies, environment);
        } else if (child.pid !== undefined) {
          try {
            dependencies.killProcessGroup(child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }

        forceKillTimer = setTimeout(() => {
          if (dependencies.platform !== "win32" && child.pid !== undefined) {
            try {
              dependencies.killProcessGroup(child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          finish(timeoutError());
        }, 1_000);
        forceKillTimer.unref();
      }, timeoutMs);
      timeoutTimer.unref();

      child.once("error", (error) => {
        if (!timedOut) finish(error);
      });
      child.once("close", (code, signal) => {
        if (timedOut) return;
        if (code !== 0) {
          finish(
            new Error(
              `skills CLI exited with code ${String(code)} (${String(signal)})`,
            ),
          );
        } else {
          finish();
        }
      });
    });
  };
}

export function createRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    fetch: globalThis.fetch,
    install: createInstaller(),
    now: Date.now,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    randomId: randomUUID,
    warn: (message) => console.warn(`[opencode-matt-pocock-skills] ${message}`),
    ...overrides,
  };
}
