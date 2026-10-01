import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Skill } from "@opencode/plugin";
import { parseDocument } from "yaml";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanMetadata(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${field} must be a boolean or "true"/"false"`);
}

export function parseSkill(
  path: string,
  markdown: string,
  source?: string,
): Skill.Info {
  let metadata: Record<string, unknown> = {};
  let content = markdown.replace(/^\uFEFF/, "");
  if (/^---\r?\n/.test(content)) {
    const match = /^---\r?\n([\s\S]*?)^---[\t ]*(?:\r?\n|$)/m.exec(content);
    if (!match) throw new Error(`${path}: unterminated frontmatter`);
    const document = parseDocument(match[1]!);
    if (document.errors.length)
      throw new Error(`${path}: invalid YAML frontmatter`);
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    if (value !== null && !record(value))
      throw new Error(`${path}: frontmatter must be an object`);
    metadata = value ?? {};
    content = content.slice(match[0].length);
  }
  const id =
    source && resolve(dirname(path)) === resolve(source)
      ? "SKILL"
      : basename(dirname(path));
  for (const field of ["name", "description"]) {
    if (metadata[field] !== undefined && typeof metadata[field] !== "string") {
      throw new Error(`${path}: ${field} must be a string`);
    }
  }
  if (metadata.metadata !== undefined && !record(metadata.metadata)) {
    throw new Error(`${path}: metadata must be an object`);
  }
  const extra = record(metadata.metadata) ? metadata.metadata : {};
  const autoinvoke = booleanMetadata(
    extra["opencode/autoinvoke"],
    "opencode/autoinvoke",
  );
  return {
    id: Skill.ID.make(id),
    name: Skill.Name.make((metadata.name as string | undefined) ?? id),
    path: resolve(path) as Skill.Info["path"],
    content,
    ...(metadata.description !== undefined
      ? { description: metadata.description as string }
      : {}),
    ...(autoinvoke !== undefined ? { autoinvoke } : {}),
  };
}

/** Load before registering a transform; callbacks must never perform filesystem work. */
export async function loadSkills(
  directory: string,
  signal?: AbortSignal,
): Promise<readonly Skill.Info[]> {
  const skills: Skill.Info[] = [];
  const ids = new Set<string>();
  async function visit(path: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const file = join(path, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`${file}: symbolic links are not supported`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        const skill = parseSkill(
          file,
          await readFile(file, { encoding: "utf8", signal }),
          directory,
        );
        if (ids.has(skill.id))
          throw new Error(`duplicate collection skill ID: ${skill.id}`);
        ids.add(skill.id);
        skills.push(skill);
      }
    }
  }
  await visit(directory);
  if (!skills.length) throw new Error("skills CLI output contains no SKILL.md");
  return skills;
}
