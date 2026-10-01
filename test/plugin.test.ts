import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@opencode/plugin";
import type { SkillDomain, SkillEditor } from "@opencode/plugin/promise/skill";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { setupSkills, pollingDelay } from "../src/plugin.js";
import { resolveOptions } from "../src/options.js";
import { createRuntime, SKILLS_CLI_VERSION } from "../src/runtime.js";
import { parseSkill } from "../src/skills.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "matt-plugin-"));
  roots.push(directory);
  return directory;
}

async function skill(
  directory: string,
  id: string,
  body = "Body",
): Promise<void> {
  const path = join(directory, id);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${id}\ndescription: Test skill\n---\n${body}`,
  );
}

async function existing(directory: string): Promise<void> {
  const path = join(directory, "releases", "old", ".agents", "skills");
  await skill(path, "removed");
  await skill(path, "review", "Old review");
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      schema: 1,
      activeRelease: "old",
      upstreamCommitSha: SHA_1,
      etag: '"old"',
      checkedAt: "2026-01-01T00:00:00.000Z",
      cliVersion: SKILLS_CLI_VERSION,
    }),
  );
}

function response(sha = SHA_2): Response {
  return new Response(JSON.stringify({ sha }), { headers: { etag: '"new"' } });
}

/** Emulate V2's fresh, ordered replay rather than mutating the previous result. */
function registry(base: readonly Skill.Info[] = []) {
  let transform: ((editor: SkillEditor) => void) | undefined;
  const current = new Map<string, Skill.Info>();
  const rebuild = () => {
    current.clear();
    base.forEach((definition) => current.set(definition.id, definition));
    transform?.({
      list: () => [...current.values()],
      get: (id) => current.get(id),
      add: (definition) => {
        current.set(definition.id, definition);
      },
      remove: (id) => {
        current.delete(id);
      },
      update: () => {},
    });
  };
  const dispose = vi.fn(async () => {
    transform = undefined;
    rebuild();
  });
  const domain: Pick<SkillDomain, "transform" | "reload"> = {
    transform: vi.fn(async (callback) => {
      transform = callback;
      rebuild();
      return { dispose };
    }),
    reload: vi.fn(async () => {
      rebuild();
    }),
  };
  return { domain, current, dispose };
}

describe("V2 plugin", () => {
  it("exports a stable V2 definition", () => {
    expect(plugin.id).toBe("opencode-matt-pocock-skills");
    expect(plugin.setup).toBeTypeOf("function");
  });

  it("activates a background update atomically and removes deleted collection skills", async () => {
    const directory = await root();
    await existing(directory);
    let release!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const install = vi.fn(async (cwd: string) => {
      await skill(join(cwd, ".agents", "skills"), "review", "New review");
    });
    const { domain, current, dispose } = registry();
    const cleanup = await setupSkills(
      domain,
      resolveOptions({ stateDir: directory, checkIntervalMs: 0 }),
      createRuntime({ fetch, install }),
    );
    cleanups.push(cleanup);
    expect(current.get("review")?.content).toBe("Old review");
    expect(current.has("removed")).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release(response());
    await vi.waitFor(() =>
      expect(current.get("review")?.content).toBe("New review"),
    );
    expect(current.has("removed")).toBe(false);
    expect(domain.reload).toHaveBeenCalledOnce();
    expect(
      await readFile(
        join(
          directory,
          "releases",
          "old",
          ".agents",
          "skills",
          "review",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("Old review");
    await cleanup();
    cleanups.pop();
    expect(dispose).toHaveBeenCalledOnce();
    expect(current.size).toBe(0);
  });

  it("keeps existing definitions and warns only once across replays", async () => {
    const directory = await root();
    await existing(directory);
    const prior = parseSkill("/project/review/SKILL.md", "Project review");
    const { domain, current } = registry([prior]);
    const warn = vi.fn();
    const fetch = vi.fn();
    cleanups.push(
      await setupSkills(
        domain,
        resolveOptions({ stateDir: directory, updateMode: "off" }),
        createRuntime({ fetch, warn }),
      ),
    );
    expect(current.get("review")).toBe(prior);
    await domain.reload();
    expect(current.get("review")).toBe(prior);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "skipping conflicting skill ID: review",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid update without publishing state or replacing the registry", async () => {
    const directory = await root();
    await existing(directory);
    const { domain, current } = registry();
    const warn = vi.fn();
    const install = vi.fn(async (cwd: string) => {
      const path = join(cwd, ".agents", "skills");
      await skill(path, "valid");
      await mkdir(join(path, "invalid"));
      await writeFile(
        join(path, "invalid", "SKILL.md"),
        "---\nname: [broken\n---\nBody",
      );
    });
    cleanups.push(
      await setupSkills(
        domain,
        resolveOptions({
          stateDir: directory,
          updateMode: "blocking",
          checkIntervalMs: 0,
        }),
        createRuntime({ fetch: vi.fn(async () => response()), install, warn }),
      ),
    );
    expect(current.get("review")?.content).toBe("Old review");
    expect(current.has("valid")).toBe(false);
    expect(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8"))
        .activeRelease,
    ).toBe("old");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("keeping previous release"),
    );
  });

  it("polls after initial load and stops polling on unload", async () => {
    vi.useFakeTimers();
    const directory = await root();
    await existing(directory);
    const fetch = vi.fn(async () => response(SHA_1));
    const { domain } = registry();
    const cleanup = await setupSkills(
      domain,
      resolveOptions({
        stateDir: directory,
        updateMode: "blocking",
        checkIntervalMs: 1_000,
      }),
      createRuntime({ fetch }),
    );
    cleanups.push(cleanup);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await cleanup();
    cleanups.pop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight fetch and releases its lock on unload", async () => {
    const directory = await root();
    await existing(directory);
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const { domain } = registry();
    const cleanup = await setupSkills(
      domain,
      resolveOptions({ stateDir: directory, checkIntervalMs: 0 }),
      createRuntime({ fetch, warn: vi.fn() }),
    );
    cleanups.push(cleanup);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await cleanup();
    cleanups.pop();
    expect(signal?.aborted).toBe(true);
    await expect(
      readFile(join(directory, "update.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(domain.reload).not.toHaveBeenCalled();
  });

  it("clamps zero and overflowing polling intervals", () => {
    expect(pollingDelay(0)).toBe(1_000);
    expect(pollingDelay(10_000)).toBe(10_000);
    expect(pollingDelay(Number.MAX_VALUE)).toBe(2_147_483_647);
  });

  it("retries a failed initial install on the next poll", async () => {
    vi.useFakeTimers();
    const directory = await root();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => response());
    const install = vi.fn(async (cwd: string) => {
      await skill(join(cwd, ".agents", "skills"), "review", "Recovered");
    });
    const { domain, current } = registry();
    cleanups.push(
      await setupSkills(
        domain,
        resolveOptions({ stateDir: directory, checkIntervalMs: 0 }),
        createRuntime({ fetch, install, warn: vi.fn() }),
      ),
    );
    expect(current.size).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(current.get("review")?.content).toBe("Recovered"),
    );
    expect(install).toHaveBeenCalledOnce();
  });

  it("restores the selected snapshot after a registry reload fails", async () => {
    const directory = await root();
    await existing(directory);
    const { domain, current } = registry();
    const warn = vi.fn();
    vi.mocked(domain.reload).mockRejectedValueOnce(
      new Error("registry unavailable"),
    );
    const install = vi.fn(async (cwd: string) => {
      await skill(join(cwd, ".agents", "skills"), "review", "New review");
    });
    cleanups.push(
      await setupSkills(
        domain,
        resolveOptions({ stateDir: directory, checkIntervalMs: 0 }),
        createRuntime({ fetch: vi.fn(async () => response()), install, warn }),
      ),
    );
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "background update failed: registry unavailable",
      ),
    );
    expect(current.get("review")?.content).toBe("Old review");
    expect(current.has("removed")).toBe(true);
    expect(domain.reload).toHaveBeenCalledTimes(2);
  });
});
