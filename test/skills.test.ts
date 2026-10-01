import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills, parseSkill } from "../src/skills.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "matt-skills-loader-"));
  roots.push(directory);
  return directory;
}

describe("skill loading", () => {
  it("uses path IDs, absolute paths, stripped content, and native metadata", () => {
    expect(
      parseSkill(
        "/release/team/review/SKILL.md",
        [
          "---",
          "name: Team Review",
          "description: |",
          "  Review carefully.",
          "metadata:",
          '  opencode/autoinvoke: "false"',
          "license: MIT",
          "---",
          "Read references/policy.md.",
        ].join("\n"),
      ),
    ).toEqual({
      id: "review",
      name: "Team Review",
      description: "Review carefully.\n",
      autoinvoke: false,
      path: "/release/team/review/SKILL.md",
      content: "Read references/policy.md.",
    });
  });

  it("supports optional frontmatter, BOM, and CRLF", () => {
    expect(
      parseSkill("/release/example/SKILL.md", "---\n---\nBody").content,
    ).toBe("Body");
    expect(parseSkill("/release/example/SKILL.md", "Body").name).toBe(
      "example",
    );
    expect(
      parseSkill(
        "/release/example/SKILL.md",
        "\uFEFF---\r\nname: Example\r\n---\r\nBody",
      ).content,
    ).toBe("Body");
  });

  it("uses the native SKILL ID for a source-root entry", async () => {
    const directory = await root();
    await writeFile(join(directory, "SKILL.md"), "Body");
    expect((await loadSkills(directory))[0]?.id).toBe("SKILL");
  });

  it.each([
    "---\nname: Example\nBody",
    "---\nname: [broken\n---\nBody",
    "---\nname: Example\nname: Duplicate\n---\nBody",
    "---\n- item\n---\nBody",
    "---\nname: 123\n---\nBody",
    "---\ndescription: false\n---\nBody",
    "---\nmetadata: invalid\n---\nBody",
    "---\nmetadata:\n  opencode/autoinvoke: nope\n---\nBody",
  ])("rejects malformed definitions %#", (markdown) => {
    expect(() => parseSkill("/release/example/SKILL.md", markdown)).toThrow();
  });

  it("rejects an empty collection and duplicate path-derived IDs", async () => {
    const directory = await root();
    await expect(loadSkills(directory)).rejects.toThrow("no SKILL.md");
    for (const parent of ["one", "two"]) {
      const skill = join(directory, parent, "same");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "Body");
    }
    await expect(loadSkills(directory)).rejects.toThrow(
      "duplicate collection skill ID: same",
    );
  });

  it("retains supporting files and does not follow symbolic links", async () => {
    const directory = await root();
    await mkdir(join(directory, "example", "references"), { recursive: true });
    await writeFile(join(directory, "example", "SKILL.md"), "Body");
    await writeFile(
      join(directory, "example", "references", "policy.md"),
      "Policy",
    );
    expect(await loadSkills(directory)).toHaveLength(1);
    await symlink(join(directory, "example"), join(directory, "linked"));
    await expect(loadSkills(directory)).rejects.toThrow("symbolic links");
  });
});
