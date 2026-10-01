import type { SkillDomain } from "@opencode/plugin/promise/skill";
import type { ResolvedOptions } from "./options.js";
import { SkillsManager, type ActiveRelease } from "./manager.js";
import type { Runtime } from "./runtime.js";

// Node timers overflow above this limit; a zero interval must not create a busy loop.
export function pollingDelay(interval: number): number {
  return Math.min(2_147_483_647, Math.max(1_000, interval));
}

export async function setupSkills(
  domain: Pick<SkillDomain, "transform" | "reload">,
  options: ResolvedOptions,
  runtime: Runtime,
): Promise<() => Promise<void>> {
  const controller = new AbortController();
  const manager = new SkillsManager(options, runtime, controller.signal);
  let selected = await manager.load();
  const warned = new Set<string>();
  const conflicts = new Set<string>();
  const registration = await domain.transform((editor) => {
    conflicts.clear();
    for (const skill of selected?.skills ?? []) {
      if (editor.get(skill.id)) {
        conflicts.add(skill.id);
      } else {
        editor.add(skill);
      }
    }
  });
  function warnConflicts(): void {
    for (const id of conflicts) {
      if (!warned.has(id)) {
        warned.add(id);
        runtime.warn(`skipping conflicting skill ID: ${id}`);
      }
    }
  }
  warnConflicts();
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;

  async function activate(next: ActiveRelease | undefined): Promise<void> {
    if (!next || next.path === selected?.path || controller.signal.aborted)
      return;
    const previous = selected;
    selected = next;
    try {
      await domain.reload();
      warnConflicts();
    } catch (error) {
      selected = previous;
      // Restore the old snapshot if a registry rebuild failed partway through.
      await domain.reload().catch(() => undefined);
      throw error;
    }
  }

  function schedule(): void {
    if (controller.signal.aborted || options.updateMode === "off") return;
    timer = setTimeout(run, pollingDelay(options.checkIntervalMs));
    timer.unref();
  }

  function run(): void {
    if (controller.signal.aborted || pending) return;
    pending = (async () => {
      try {
        await activate(await manager.refresh());
      } catch (error) {
        if (!controller.signal.aborted) {
          runtime.warn(
            `background update failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        pending = undefined;
        schedule();
      }
    })();
  }

  if (options.updateMode === "background" && selected) run();
  else schedule();

  return async () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    await pending;
    await registration.dispose();
  };
}
