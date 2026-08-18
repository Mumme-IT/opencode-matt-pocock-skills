import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveUrl,
  buildChildEnvironment,
  buildSkillsArguments,
  createInstaller,
  SKILLS_CLI_VERSION,
} from "../src/runtime.js";

const COMMIT = "a".repeat(40);

afterEach(() => vi.useRealTimers());

function fakeChild(pid = 42): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: pid },
    kill: { value: vi.fn(() => true) },
  });
  return child;
}

describe("skills CLI runtime", () => {
  it("builds immutable archive source arguments", () => {
    expect(archiveUrl(COMMIT)).toBe(
      `https://github.com/mattpocock/skills/archive/${COMMIT}.tar.gz`,
    );
    expect(buildSkillsArguments(COMMIT)).toEqual([
      "--yes",
      `skills@${SKILLS_CLI_VERSION}`,
      "add",
      `https://github.com/mattpocock/skills/archive/${COMMIT}.tar.gz`,
      "--agent",
      "opencode",
      "--skill",
      "*",
      "-y",
      "--full-depth",
      "--copy",
    ]);
    expect(() => buildSkillsArguments("ABC")).toThrow(
      "exactly 40 lowercase hex",
    );
  });

  it("passes only download essentials and disables telemetry", () => {
    const environment = buildChildEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      HTTPS_PROXY: "https://proxy.test",
      NODE_EXTRA_CA_CERTS: "/cert.pem",
      GH_TOKEN: "github-secret",
      GITHUB_TOKEN: "github-secret-2",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      ANTHROPIC_API_KEY: "provider-secret",
      RANDOM_SECRET: "other-secret",
      DISABLE_TELEMETRY: "0",
    });

    expect(environment).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      HTTPS_PROXY: "https://proxy.test",
      NODE_EXTRA_CA_CERTS: "/cert.pem",
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      CI: "1",
      NO_COLOR: "1",
    });
  });

  it("spawns npx without shell using sanitized environment", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const install = createInstaller({
      spawnProcess,
      platform: "linux",
      environment: { PATH: "/bin", GH_TOKEN: "secret" },
    });

    const result = install("/stage", COMMIT, 1_000);
    child.emit("close", 0, null);
    await result;

    expect(spawnProcess).toHaveBeenCalledWith(
      "npx",
      buildSkillsArguments(COMMIT),
      expect.objectContaining({
        cwd: "/stage",
        detached: true,
        shell: false,
        env: expect.not.objectContaining({ GH_TOKEN: expect.anything() }),
      }),
    );
  });

  it("terminates POSIX process group on timeout without double settlement", async () => {
    vi.useFakeTimers();
    const child = fakeChild(77);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const killProcessGroup = vi.fn();
    const install = createInstaller({
      spawnProcess,
      platform: "linux",
      environment: { PATH: "/bin" },
      killProcessGroup,
    });

    const result = install("/stage", COMMIT, 10);
    const assertion = expect(result).rejects.toThrow("timed out after 10ms");
    await vi.advanceTimersByTimeAsync(1_010);
    await assertion;

    expect(killProcessGroup).toHaveBeenNthCalledWith(1, 77, "SIGTERM");
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, 77, "SIGKILL");
    child.emit("close", 0, null);
  });

  it("uses taskkill argv without shell for Windows timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild(88);
    const taskkill = fakeChild(89);
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(taskkill) as unknown as typeof spawn;
    const install = createInstaller({
      spawnProcess,
      platform: "win32",
      environment: { Path: "C:\\Windows\\System32", GH_TOKEN: "secret" },
    });

    const result = install("C:\\stage", COMMIT, 10);
    const assertion = expect(result).rejects.toThrow("timed out after 10ms");
    await vi.advanceTimersByTimeAsync(1_010);
    await assertion;

    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      "taskkill",
      ["/PID", "88", "/T", "/F"],
      expect.objectContaining({
        shell: false,
        env: expect.not.objectContaining({ GH_TOKEN: expect.anything() }),
      }),
    );
  });
});
