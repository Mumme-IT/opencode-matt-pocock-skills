import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStateDir, resolveOptions } from "../src/options.js";

describe("options", () => {
  it("resolves XDG state and defaults", () => {
    expect(defaultStateDir({ XDG_STATE_HOME: "/var/state" })).toBe(
      resolve("/var/state/opencode/opencode-matt-pocock-skills"),
    );
    expect(resolveOptions(undefined, { XDG_STATE_HOME: "/var/state" })).toEqual(
      {
        stateDir: resolve("/var/state/opencode/opencode-matt-pocock-skills"),
        updateMode: "background",
        checkIntervalMs: 86_400_000,
        checkTimeoutMs: 2_500,
        installTimeoutMs: 120_000,
      },
    );
  });

  it("accepts overrides and resolves relative state paths", () => {
    expect(
      resolveOptions({
        stateDir: "fixture-state",
        updateMode: "blocking",
        checkIntervalMs: 0,
        checkTimeoutMs: 10,
        installTimeoutMs: 20,
      }),
    ).toEqual({
      stateDir: resolve("fixture-state"),
      updateMode: "blocking",
      checkIntervalMs: 0,
      checkTimeoutMs: 10,
      installTimeoutMs: 20,
    });
  });

  it("ignores relative XDG_STATE_HOME", () => {
    expect(defaultStateDir({ XDG_STATE_HOME: "relative/state" })).toBe(
      resolve(
        homedir(),
        ".local",
        "state",
        "opencode",
        "opencode-matt-pocock-skills",
      ),
    );
  });

  it.each([
    [{ updateMode: "sometimes" }, "updateMode"],
    [{ stateDir: "" }, "stateDir"],
    [{ checkIntervalMs: -1 }, "checkIntervalMs"],
    [{ checkTimeoutMs: Number.NaN }, "checkTimeoutMs"],
    [[], "plugin options"],
  ])("rejects invalid options %#", (value, message) => {
    expect(() => resolveOptions(value)).toThrow(message);
  });
});
