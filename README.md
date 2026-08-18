# opencode-matt-pocock-skills

OpenCode plugin that installs and maintains all skills from
[`mattpocock/skills`](https://github.com/mattpocock/skills). Installed releases live in OpenCode state, not project directories.

## Requirements

- Node.js 22.20.0 or newer
- OpenCode with plugin tuple support
- `npx` available on `PATH`
- Network access to GitHub and npm during installs and updates

## Install

Add package to OpenCode config (`~/.config/opencode/opencode.json` for global use):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-matt-pocock-skills"]
}
```

Options use plugin tuple form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-matt-pocock-skills",
      {
        "updateMode": "background",
        "checkIntervalMs": 86400000,
        "checkTimeoutMs": 2500,
        "installTimeoutMs": 120000
      }
    ]
  ]
}
```

Quit and restart OpenCode after changing plugin config. OpenCode loads config-time plugins once per startup.

## Options

| Option             | Default                                        | Meaning                                              |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| `stateDir`         | `<OpenCode state>/opencode-matt-pocock-skills` | Absolute or cwd-relative storage override            |
| `updateMode`       | `"background"`                                 | `background`, `blocking`, or `off`                   |
| `checkIntervalMs`  | `86400000`                                     | Minimum time between remote checks                   |
| `checkTimeoutMs`   | `2500`                                         | GitHub request timeout and part of initial lock wait |
| `installTimeoutMs` | `120000`                                       | Skills CLI timeout and part of initial lock wait     |

OpenCode state is `${XDG_STATE_HOME}/opencode` when `XDG_STATE_HOME` is absolute. Unset or relative values fall back to `~/.local/state/opencode`.

## Behavior

1. Missing or invalid state blocks startup while plugin acquires lock, resolves `main` to upstream commit SHA, and stages full install.
2. Plugin runs `npx --yes skills@1.5.22 add https://github.com/mattpocock/skills/archive/<40-character-commit-sha>.tar.gz --agent opencode --skill * -y --full-depth --copy` in staging directory, without shell. Immutable archive closes revision race between check and install.
3. Staging must contain at least one recursive `.agents/skills/**/SKILL.md` before atomic publication.
4. Valid active release path is added once to `skills.paths` as absolute path.
5. Recently checked valid state performs no network request or child process.
6. Stale state uses GitHub commit endpoint and ETag. HTTP 304 or unchanged commit SHA updates check metadata only.
7. Changed SHA creates full new release. Plugin does not use `skills update`: that command can miss newly added, deleted, or renamed skills.

`background` returns old release immediately and checks asynchronously. New release becomes active for next OpenCode startup because current config already contains old path. `blocking` waits and switches path during current startup. `off` never checks after valid install exists.

Failed checks or installs preserve previous release. Old releases remain because running OpenCode sessions may still reference them. Initial failure logs warning and injects no partial path.

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
