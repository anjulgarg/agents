# Local Agents

Local source of truth and installer for coding-agent configuration. The `agents` CLI installs selected resources transactionally into a home directory while preserving unrelated files and private runtime state.

## Local setup

Prerequisites: Node.js 22.19.0 or newer, npm, Git, and Pi 0.83.0 for Pi resources. No registry publication or remote is required.

```bash
npm ci
npm run build
npm link
agents
```

`npm link` exposes the locally built `agents` command. Run `npm unlink --global @anjulgarg/agents` to remove that link. Rebuild after source changes, and run `/reload` in each active Pi session after changing installed Pi resources.

## Commands

```bash
agents                              # interactive dashboard
agents install --yes                # default profile
agents install --profile pi --yes
agents install --category skill --yes
agents install --component skill:pr --yes
agents remove --component skill:pr --yes
agents remove --profile skills --yes
agents list
agents doctor
```

Mutations show a plan before applying it. Interactive use asks for confirmation; scripts must pass `--yes`. Add `--home /absolute/fixture-home` to every command to operate on a disposable or alternate home. Add `--json` to `list`, `doctor`, or a confirmed mutation for schema-versioned output. `--debug` adds stack details to errors.

### Interactive keys

- Dashboard: Up/Down, Enter to open, Escape to cancel, Ctrl+C to quit.
- Selection: Up/Down, Space to toggle, A for all visible, C for the category, X to clear, Tab/Shift+Tab to change category.
- Selection shortcuts: 1 default, 2 Pi, 3 skills, `/` search, F installed-only, Enter review.
- Preview and confirmation: Enter continues, Y applies, N or Escape cancels.

The interface requires at least 60 columns and never relies on color alone.

## Profiles and categories

Profiles are `default` for every approved component, `pi` for Pi resources plus shared instructions, and `skills` for all retained cross-harness skills. Categories are `skill`, `pi-extension`, `pi-config`, `pi-package`, `pi-prompt`, `pi-theme`, `pi-team`, `instructions`, and `harness`. Dependencies are added automatically, such as the subagent extension for the product team.

`agents list` reports:

- `available`: not installed and ready to select.
- `installed`: all outputs match this repository.
- `drifted`: an installed output differs from source.
- `partial`: only some outputs match.
- `unavailable`: an output cannot be inspected safely, often because JSON is malformed.
- `managed`: recorded in the current receipt; `legacy detected` identifies an approved old direct copy; `unmanaged` remains outside CLI ownership.

## Doctor, removal, and recovery

Run `agents doctor --home <home>` after installation or whenever status is unexpected. It checks runtimes, required commands and pinned packages, component integrity, stale filters, receipts, and legacy copies without reading sessions, credentials, caches, or other private state.

Removal is selective and preserves unknown resources and unowned JSON. Preview it interactively or use explicit selection with `--yes`; bare noninteractive removal is refused. Reinstalling a drifted component restores the repository version transactionally.

On a normal failure, inspect the message, run `agents doctor`, and retry after fixing the cause. Automatic rollback leaves the fixture unchanged. If `rollback-failed` is reported, preserve the printed recovery backup and restore it manually before retrying. For migration, live backup, pre-cutover restoration, and unlink steps, follow [Migration and recovery](docs/migration-and-recovery.md).

## Repository guide

- [Architecture and component catalog](docs/architecture.md)
- [Migration and recovery](docs/migration-and-recovery.md)

Pi-only resources live in `pi/`, including extensions, themes, and keybindings. The personal Pi settings, model overrides, and MCP configuration files under `pi/config/` are intentionally local-only and ignored from the public repository. Other runtime resources live in `harnesses/`, `instructions/`, `prompts/`, `skills/`, and `teams/`. Never add credentials, authentication, sessions, state, caches, or other private runtime files.

## Development checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run pack:check
```

The E2E suite uses a unique temporary home per test, runs offline, and never mutates the live home or the dotfiles repository. Live model-call smoke files are intentionally excluded from normal checks.
