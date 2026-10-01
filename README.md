# opencode-matt-pocock-skills

OpenCode plugin that installs and maintains all skills from
[`mattpocock/skills`](https://github.com/mattpocock/skills). Installed releases live in OpenCode state, not project directories.

## Requirements

- Node.js 22.20.0 or newer
- OpenCode V2 compatible with `@opencode/plugin` 2.0.21 (V1 users should keep plugin version 0.1.1)
- `npx` available on `PATH`
- Network access to GitHub and npm during installs and updates

## Install

Add package to OpenCode config (`~/.config/opencode/opencode.json` for global use):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-matt-pocock-skills"]
}
```

Options use the package-and-options object form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-matt-pocock-skills",
      "options": {
        "updateMode": "background",
        "checkIntervalMs": 86400000,
        "checkTimeoutMs": 2500,
        "installTimeoutMs": 120000
      }
    }
  ]
}
```

OpenCode V2 reloads watched configuration automatically. If a change is not picked up, run `opencode service restart`; closing the terminal alone does not stop the shared background service.

## Options

| Option             | Default                                        | Meaning                                                   |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------- |
| `stateDir`         | `<OpenCode state>/opencode-matt-pocock-skills` | Absolute or plugin-location-relative storage override     |
| `updateMode`       | `"background"`                                 | `background`, `blocking`, or `off`                        |
| `checkIntervalMs`  | `86400000`                                     | Minimum time between remote checks; also controls polling |
| `checkTimeoutMs`   | `2500`                                         | GitHub request timeout and part of initial lock wait      |
| `installTimeoutMs` | `120000`                                       | Skills CLI timeout and part of initial lock wait          |

OpenCode state is `${XDG_STATE_HOME}/opencode` when `XDG_STATE_HOME` is absolute. Unset or relative values fall back to `~/.local/state/opencode`.

## Behavior

1. Missing or invalid state blocks startup while plugin acquires lock, resolves `main` to upstream commit SHA, and stages full install.
2. Plugin runs `npx --yes skills@1.5.22 add https://github.com/mattpocock/skills/archive/<40-character-commit-sha>.tar.gz --agent opencode --skill * -y --full-depth --copy` in staging directory, without shell. Immutable archive closes revision race between check and install.
3. Staging must contain at least one recursive `.agents/skills/**/SKILL.md`. All skill definitions are parsed before atomic publication. Invalid YAML, invalid interpreted field types, duplicate collection IDs, or symbolic links reject the entire candidate release.
4. The plugin registers validated definitions through V2 skill transforms, with absolute `SKILL.md` paths so supporting files remain accessible. IDs come from containing directory names; frontmatter `name` is the display label. Markdown bodies, descriptions, and `metadata.opencode/autoinvoke` are preserved.
5. Recently checked valid state performs no network request or child process.
6. Stale state uses GitHub commit endpoint and ETag. HTTP 304 or unchanged commit SHA updates check metadata only.
7. Changed SHA creates full new release. Plugin does not use `skills update`: that command can miss newly added, deleted, or renamed skills.

`background` registers the old release immediately and checks asynchronously. Successful updates become available to future skill loads immediately, including additions, changes, and deletions. Already-loaded instructions cannot be retracted. `blocking` waits for the initial check before registering skills. Both modes poll while the plugin is active. `off` never checks after a valid install exists.

Polling runs after each completed check, never overlaps within a plugin instance, and uses a minimum delay of one second (`checkIntervalMs: 0` still means always stale). Multiple instances coordinate through the shared filesystem lock. Unloading cancels requests and installers, clears timers, releases locks, and removes registrations.

Existing definitions with the same ID win; conflicting collection skills are skipped with a warning. Later plugin registrations follow OpenCode's normal precedence. Each refresh rebuilds only this plugin's contribution, preserving unrelated skills.

Failed checks, installs, or validation preserve the previous release. Old releases remain because running OpenCode sessions may still reference them. Initial failure logs a warning and registers no partial collection; enabled polling retries later. Existing V1 state and releases are reused when they pass the stricter validation.

## State layout

```text
opencode-matt-pocock-skills/
├── state.json
├── update.lock/              # present only while owner updates
├── releases/<id>/.agents/skills/
└── tmp/<id>/                 # staging
```

## Security

Plugin executes pinned `skills@1.5.22` against immutable archive selected from current `mattpocock/skills` `main`. Review upstream before use. `GH_TOKEN` or `GITHUB_TOKEN` is sent only as GitHub API authorization when present; plugin does not store, log, or pass token to child process. Child process receives minimal download-related environment allowlist, with telemetry disabled through `DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1`, `CI=1`, and `NO_COLOR=1`. Installed skill text can influence agent behavior and should be treated as executable instructions.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
```
