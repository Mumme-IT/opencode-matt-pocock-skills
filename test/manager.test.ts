import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsManager } from "../src/manager.js";
import { resolveOptions, type UpdateMode } from "../src/options.js";
import {
  createRuntime,
  SKILLS_CLI_VERSION,
  type Runtime,
} from "../src/runtime.js";

const roots: string[] = [];
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-matt-skills-"));
  roots.push(root);
  return root;
}

function commitResponse(sha: string, etag = '"etag-2"'): Response {
  return new Response(JSON.stringify({ sha }), {
    status: 200,
    headers: { etag },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function writeRelease(
  root: string,
  id = "release-1",
  checkedAt = "2026-01-01T00:00:00.000Z",
  sha = SHA_1,
): Promise<string> {
  const skills = join(root, "releases", id, ".agents", "skills");
  await mkdir(join(skills, "example", "nested"), { recursive: true });
  await writeFile(
    join(skills, "example", "nested", "SKILL.md"),
    "---\nname: example\n---\n",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "state.json"),
    `${JSON.stringify({
      schema: 1,
      activeRelease: id,
      upstreamCommitSha: sha,
      etag: '"etag-1"',
      checkedAt,
      cliVersion: SKILLS_CLI_VERSION,
    })}\n`,
  );
  return resolve(skills);
}

function manager(
  root: string,
  overrides: Partial<Runtime> = {},
  updateMode: UpdateMode = "blocking",
  checkIntervalMs = 0,
): { manager: SkillsManager; runtime: Runtime } {
  const runtime = createRuntime({
    now: () => Date.parse("2026-08-17T00:00:00.000Z"),
    randomId: vi.fn(() => `id-${Math.random().toString(16).slice(2)}`),
    warn: vi.fn(),
    ...overrides,
  });
  const options = resolveOptions({
    stateDir: root,
    updateMode,
    checkIntervalMs,
    checkTimeoutMs: 100,
    installTimeoutMs: 1_000,
  });
  return { manager: new SkillsManager(options, runtime), runtime };
}

async function successfulInstall(cwd: string): Promise<void> {
  const skill = join(cwd, ".agents", "skills", "new-skill", "deep");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "installed");
}

async function storedState(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "state.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("SkillsManager", () => {
  it("returns validated absolute release path without network work", async () => {
    const root = await temporaryRoot();
    const path = await writeRelease(
      root,
      "existing",
      "2026-08-17T00:00:00.000Z",
    );
    const fetch = vi.fn();
    const install = vi.fn();
    const { manager: subject } = manager(
      root,
      { fetch, install },
      "blocking",
      86_400_000,
    );
    const active = await subject.load();
    expect(active?.path).toBe(path);
    expect(active?.skills[0]?.id).toBe("nested");
    expect(fetch).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("blocks for successful initial install and publishes only valid output", async () => {
    const root = await temporaryRoot();
    const fetch = vi.fn(async () => commitResponse(SHA_1));
    const install = vi.fn(successfulInstall);
    const { manager: subject } = manager(root, { fetch, install });
    const active = await subject.load();

    expect(fetch).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(
      expect.any(String),
      SHA_1,
      1_000,
      expect.any(AbortSignal),
    );
    expect(active?.path).toMatch(/releases\/.*\.agents\/skills$/);
    expect((await storedState(root)).upstreamCommitSha).toBe(SHA_1);
  });

  it("warns and injects no path when initial install fails validation", async () => {
    const root = await temporaryRoot();
    const warn = vi.fn();
    const { manager: subject } = manager(root, {
      fetch: vi.fn(async () => commitResponse(SHA_1)),
      install: vi.fn(async () => undefined),
      warn,
    });
    expect(await subject.load()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("initial install failed"),
    );
    await expect(readFile(join(root, "state.json"))).rejects.toThrow();
  });

  it("uses interval fast path without fetch or install", async () => {
    const root = await temporaryRoot();
    await writeRelease(root, "fresh", "2026-08-16T23:59:00.000Z");
    const fetch = vi.fn();
    const install = vi.fn();
    const { manager: subject } = manager(
      root,
      { fetch, install },
      "blocking",
      60_001,
    );

    await subject.load();

    expect(fetch).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("never checks existing release when updates are off", async () => {
    const root = await temporaryRoot();
    const path = await writeRelease(root);
    const fetch = vi.fn();
    const install = vi.fn();
    const { manager: subject } = manager(root, { fetch, install }, "off");
    expect((await subject.load())?.path).toBe(path);
    expect(fetch).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    ["304", new Response(null, { status: 304 })],
    ["same SHA", commitResponse(SHA_1)],
  ])("updates metadata without install for %s", async (_name, response) => {
    const root = await temporaryRoot();
    const oldPath = await writeRelease(root);
    const install = vi.fn();
    const fetch = vi.fn(async () => response);
    const { manager: subject } = manager(root, { fetch, install });
    expect((await subject.load())?.path).toBe(oldPath);
    expect(install).not.toHaveBeenCalled();
    expect((await storedState(root)).checkedAt).toBe(
      "2026-08-17T00:00:00.000Z",
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": '"etag-1"' }),
      }),
    );
  });

  it("installs changed tree and switches blocking config path", async () => {
    const root = await temporaryRoot();
    const oldPath = await writeRelease(root);
    const install = vi.fn(successfulInstall);
    const { manager: subject } = manager(root, {
      fetch: vi.fn(async () => commitResponse(SHA_2)),
      install,
    });
    const active = await subject.load();
    expect(install).toHaveBeenCalledOnce();
    expect(active?.path).not.toBe(oldPath);
    expect((await storedState(root)).upstreamCommitSha).toBe(SHA_2);
    await expect(
      readFile(join(oldPath, "example", "nested", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: example");
  });

  it("returns old path before background update completes", async () => {
    const root = await temporaryRoot();
    const oldPath = await writeRelease(root);
    const response = deferred<Response>();
    const install = vi.fn(successfulInstall);
    const { manager: subject } = manager(
      root,
      { fetch: vi.fn(() => response.promise), install },
      "background",
    );
    const active = await subject.load();
    expect(active?.path).toBe(oldPath);
    expect(install).not.toHaveBeenCalled();

    const refresh = subject.refresh();
    response.resolve(commitResponse(SHA_2));
    expect((await refresh)?.path).not.toBe(oldPath);
    expect((await storedState(root)).upstreamCommitSha).toBe(SHA_2);
    expect(active?.path).toBe(oldPath);
  });

  it("preserves old release and state after update failure", async () => {
    const root = await temporaryRoot();
    const oldPath = await writeRelease(root);
    const warn = vi.fn();
    const { manager: subject } = manager(root, {
      fetch: vi.fn(async () => commitResponse(SHA_2)),
      install: vi.fn(async () => {
        throw new Error("install broke");
      }),
      warn,
    });
    expect((await subject.load())?.path).toBe(oldPath);
    expect((await storedState(root)).upstreamCommitSha).toBe(SHA_1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("keeping previous release"),
    );
  });

  it("skips existing-release maintenance while lock is held", async () => {
    const root = await temporaryRoot();
    const path = await writeRelease(root);
    await mkdir(join(root, "update.lock"), { recursive: true });
    const fetch = vi.fn();
    const { manager: subject } = manager(root, { fetch });
    expect((await subject.load())?.path).toBe(path);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recovers stale proper-lockfile lock for initial install", async () => {
    const root = await temporaryRoot();
    const lock = join(root, "update.lock");
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const { manager: subject } = manager(root, {
      fetch: vi.fn(async () => commitResponse(SHA_1)),
      install: successfulInstall,
    });
    expect((await subject.load())?.skills).toHaveLength(1);
    await expect(stat(join(root, "update.lock"))).rejects.toThrow();
  });

  it("serializes concurrent initial installs and reuses published release", async () => {
    const root = await temporaryRoot();
    const gate = deferred<void>();
    const install = vi.fn(async (cwd: string) => {
      await gate.promise;
      await successfulInstall(cwd);
    });
    const fetch = vi.fn(async () => commitResponse(SHA_1));
    const first = manager(root, { install, fetch }).manager;
    const second = manager(root, { install, fetch }).manager;
    const firstRun = first.load();
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    const secondRun = second.load();
    gate.resolve();
    const [firstActive, secondActive] = await Promise.all([
      firstRun,
      secondRun,
    ]);

    expect(install).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(secondActive?.path).toBe(firstActive?.path);
  });

  it("ignores invalid state and never injects its release path", async () => {
    const root = await temporaryRoot();
    await writeRelease(root);
    const state = await storedState(root);
    state.cliVersion = "different";
    await writeFile(join(root, "state.json"), JSON.stringify(state));
    const warn = vi.fn();
    const { manager: subject } = manager(root, {
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      warn,
    });
    expect(await subject.load()).toBeUndefined();
  });

  it("rejects malformed upstream commit SHA before install", async () => {
    const root = await temporaryRoot();
    const install = vi.fn();
    const warn = vi.fn();
    const { manager: subject } = manager(root, {
      fetch: vi.fn(async () => commitResponse("ABC123")),
      install,
      warn,
    });
    expect(await subject.load()).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no valid 40-character lowercase commit SHA"),
    );
  });

  it("aborts stale revision checks at configured timeout", async () => {
    const root = await temporaryRoot();
    const path = await writeRelease(root);
    const warn = vi.fn();
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("fetch aborted")),
          );
        }),
    );
    const { manager: subject } = manager(root, { fetch, warn });
    expect((await subject.load())?.path).toBe(path);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fetch aborted"));
  });
});
