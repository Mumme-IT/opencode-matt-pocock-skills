import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Skill } from "@opencode/plugin";
import lockfile from "proper-lockfile";
import { loadSkills } from "./skills.js";
import type { ResolvedOptions } from "./options.js";
import {
  COMMIT_SHA_PATTERN,
  SKILLS_CLI_VERSION,
  type Runtime,
} from "./runtime.js";

const COMMIT_URL =
  "https://api.github.com/repos/mattpocock/skills/commits/main";
const STATE_SCHEMA = 1;
const LOCK_POLL_MS = 100;

interface StoredState {
  schema: 1;
  activeRelease: string;
  upstreamCommitSha?: string;
  etag?: string;
  checkedAt: string;
  cliVersion: string;
}

interface RemoteRevision {
  sha: string;
  etag?: string;
  notModified: boolean;
}

interface OwnedLock {
  release: () => Promise<void>;
  assertOwned: () => void;
}

export interface ActiveRelease {
  state: StoredState;
  path: string;
  skills: readonly Skill.Info[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): StoredState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== STATE_SCHEMA ||
    typeof value.activeRelease !== "string" ||
    basename(value.activeRelease) !== value.activeRelease ||
    value.activeRelease === "." ||
    value.activeRelease === ".." ||
    typeof value.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    value.cliVersion !== SKILLS_CLI_VERSION
  ) {
    return undefined;
  }
  if (
    value.upstreamCommitSha !== undefined &&
    (typeof value.upstreamCommitSha !== "string" ||
      !COMMIT_SHA_PATTERN.test(value.upstreamCommitSha))
  )
    return undefined;
  if (value.etag !== undefined && typeof value.etag !== "string")
    return undefined;

  return {
    schema: STATE_SCHEMA,
    activeRelease: value.activeRelease,
    checkedAt: value.checkedAt,
    cliVersion: SKILLS_CLI_VERSION,
    ...(typeof value.upstreamCommitSha === "string"
      ? { upstreamCommitSha: value.upstreamCommitSha }
      : {}),
    ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
  };
}

export class SkillsManager {
  private readonly stateFile: string;
  private readonly lockTarget: string;
  private readonly releasesDir: string;
  private readonly temporaryDir: string;

  constructor(
    private readonly options: ResolvedOptions,
    private readonly runtime: Runtime,
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {
    this.stateFile = join(options.stateDir, "state.json");
    this.lockTarget = join(options.stateDir, "update");
    this.releasesDir = join(options.stateDir, "releases");
    this.temporaryDir = join(options.stateDir, "tmp");
  }

  async load(): Promise<ActiveRelease | undefined> {
    this.signal.throwIfAborted();
    let active = await this.readValidActive();
    if (!active) {
      active = await this.installInitial();
      return active;
    }

    if (this.options.updateMode === "off" || !this.isStale(active.state)) {
      return active;
    }

    if (this.options.updateMode === "background") {
      return active;
    }

    await this.maintainSafely();
    const updated = await this.readValidActive();
    return updated ?? active;
  }

  async refresh(): Promise<ActiveRelease | undefined> {
    this.signal.throwIfAborted();
    if (!(await this.readValidActive())) return this.installInitial();
    if (this.options.updateMode !== "off") await this.maintainSafely();
    return this.readValidActive();
  }

  private isStale(state: StoredState): boolean {
    return (
      this.runtime.now() - Date.parse(state.checkedAt) >=
      this.options.checkIntervalMs
    );
  }

  private async installInitial(): Promise<ActiveRelease | undefined> {
    const waitUntil =
      this.runtime.now() +
      this.options.checkTimeoutMs +
      this.options.installTimeoutMs;

    while (true) {
      this.signal.throwIfAborted();
      const existing = await this.readValidActive();
      if (existing) return existing;

      const lock = await this.acquireLock();
      if (lock) {
        try {
          const rechecked = await this.readValidActive();
          if (rechecked) return rechecked;
          const remote = await this.fetchRevision(undefined);
          if (remote.notModified)
            throw new Error("GitHub returned 304 without local state");
          lock.assertOwned();
          await this.installRelease(remote, lock.assertOwned);
          return await this.readValidActive();
        } catch (error) {
          this.signal.throwIfAborted();
          this.warn("initial install failed", error);
          return undefined;
        } finally {
          await this.releaseLock(lock);
        }
      }

      if (this.runtime.now() >= waitUntil) {
        this.runtime.warn(
          "initial install skipped: timed out waiting for update lock",
        );
        return undefined;
      }
      await this.runtime.sleep(
        Math.min(LOCK_POLL_MS, Math.max(0, waitUntil - this.runtime.now())),
        this.signal,
      );
    }
  }

  private async maintainSafely(): Promise<void> {
    try {
      await this.maintain();
    } catch (error) {
      this.signal.throwIfAborted();
      this.warn("update failed; keeping previous release", error);
    }
  }

  private async maintain(): Promise<void> {
    this.signal.throwIfAborted();
    const lock = await this.acquireLock();
    if (!lock) return;
    try {
      const active = await this.readValidActive();
      if (!active || !this.isStale(active.state)) return;
      const remote = await this.fetchRevision(active.state.etag);
      if (remote.notModified || remote.sha === active.state.upstreamCommitSha) {
        lock.assertOwned();
        await this.writeState({
          ...active.state,
          checkedAt: new Date(this.runtime.now()).toISOString(),
          ...(remote.etag ? { etag: remote.etag } : {}),
        });
        return;
      }
      lock.assertOwned();
      await this.installRelease(remote, lock.assertOwned);
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async fetchRevision(
    etag: string | undefined,
  ): Promise<RemoteRevision> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.checkTimeoutMs,
    );
    timeout.unref();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-matt-pocock-skills",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (etag) headers["If-None-Match"] = etag;
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await this.runtime.fetch(COMMIT_URL, {
        headers,
        signal: AbortSignal.any([controller.signal, this.signal]),
      });
      const responseEtag = response.headers.get("etag") ?? undefined;
      if (response.status === 304) {
        return {
          sha: "",
          notModified: true,
          ...(responseEtag ? { etag: responseEtag } : {}),
        };
      }
      if (!response.ok)
        throw new Error(
          `GitHub commit request failed with HTTP ${response.status}`,
        );
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        typeof body.sha !== "string" ||
        !COMMIT_SHA_PATTERN.test(body.sha)
      ) {
        throw new Error(
          "GitHub commit response has no valid 40-character lowercase commit SHA",
        );
      }
      return {
        sha: body.sha,
        notModified: false,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async installRelease(
    remote: RemoteRevision,
    assertLockOwned: () => void,
  ): Promise<void> {
    const id = `${this.runtime.now()}-${remote.sha.slice(0, 12)}-${this.runtime.randomId().slice(0, 8)}`;
    const staging = join(this.temporaryDir, id);
    const release = join(this.releasesDir, id);
    await mkdir(staging, { recursive: true });

    try {
      await this.runtime.install(
        staging,
        remote.sha,
        this.options.installTimeoutMs,
        this.signal,
      );
      this.signal.throwIfAborted();
      assertLockOwned();
      const skillsPath = join(staging, ".agents", "skills");
      await loadSkills(skillsPath, this.signal);
      this.signal.throwIfAborted();
      assertLockOwned();
      await mkdir(this.releasesDir, { recursive: true });
      await rename(staging, release);
      assertLockOwned();
      await this.writeState({
        schema: STATE_SCHEMA,
        activeRelease: id,
        upstreamCommitSha: remote.sha,
        ...(remote.etag ? { etag: remote.etag } : {}),
        checkedAt: new Date(this.runtime.now()).toISOString(),
        cliVersion: SKILLS_CLI_VERSION,
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async readValidActive(): Promise<ActiveRelease | undefined> {
    let state: StoredState | undefined;
    try {
      state = parseState(JSON.parse(await readFile(this.stateFile, "utf8")));
    } catch {
      return undefined;
    }
    if (!state) return undefined;
    const path = resolve(
      this.releasesDir,
      state.activeRelease,
      ".agents",
      "skills",
    );
    try {
      return { state, path, skills: await loadSkills(path, this.signal) };
    } catch {
      return undefined;
    }
  }

  private async writeState(state: StoredState): Promise<void> {
    this.signal.throwIfAborted();
    await mkdir(this.options.stateDir, { recursive: true });
    const temporary = `${this.stateFile}.${this.runtime.randomId()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        flag: "wx",
      });
      this.signal.throwIfAborted();
      await rename(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async acquireLock(): Promise<OwnedLock | undefined> {
    await mkdir(this.options.stateDir, { recursive: true });
    const stale = Math.max(
      2_000,
      this.options.installTimeoutMs + this.options.checkTimeoutMs + 30_000,
    );
    let compromised: Error | undefined;

    try {
      const release = await lockfile.lock(this.lockTarget, {
        realpath: false,
        retries: 0,
        stale,
        update: Math.max(1_000, Math.floor(stale / 2)),
        onCompromised: (error) => {
          compromised = error;
        },
      });
      return {
        release,
        assertOwned: () => {
          if (compromised) throw compromised;
        },
      };
    } catch (error) {
      if (isRecord(error) && error.code === "ELOCKED") return undefined;
      throw error;
    }
  }

  private async releaseLock(ownedLock: OwnedLock): Promise<void> {
    try {
      await ownedLock.release();
    } catch {
      // Lock library reports compromised or already released ownership.
    }
  }

  private warn(context: string, error: unknown): void {
    this.runtime.warn(`${context}: ${errorMessage(error)}`);
  }
}
