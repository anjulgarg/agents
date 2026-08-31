# Architecture and components

The repository is the authoritative local source. The CLI resolves selections through a static registry, inspects only approved destinations under the selected `--home`, plans exact changes, and applies them through a staged transaction with a per-home lock, backup, atomic receipt, and rollback.

## Data flow

1. `agents` parses a command, profile, category, or component selection.
2. The registry validates component resources and adds dependencies.
3. Status inspection compares source resources with approved outputs and the receipt at `~/.agents/anjulgarg-agents.json`.
4. The planner produces creates, updates, and deletes without writing.
5. Confirmation hands the plan to the transaction layer. It stages output, backs up affected paths, commits, and updates the receipt. A failure restores the backup.
6. `agents list` and `agents doctor` verify the result. Pi loads extensions, prompts, and themes through one filtered local package entry in settings.

Unknown skills, unrelated JSON fields and hooks, credentials, authentication, sessions, state, and Pi package caches are outside ownership. Operations reject unsafe links, source/home overlap, malformed managed JSON, unsupported receipt versions, and concurrent locks.

## Component catalog

| Category       | Installed role                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `skill`        | Three shared skill directories under `~/.agents/skills`; each can be selected independently.                      |
| `pi-extension` | Local-package filters for 33 Pi entrypoints. Directory entrypoints retain their support files in this repository. |
| `pi-config`    | Pi keybindings plus optional local-only model and MCP JSON pointers. Unowned keys remain local.                   |
| `pi-package`   | The optional removable `npm:pi-mcp-adapter@2.15.0` Pi setting. It is referenced, not vendored.                    |
| `pi-prompt`    | The `orchestrate` prompt through the local Pi package.                                                            |
| `pi-theme`     | The `foreman` theme through the local Pi package.                                                                 |
| `instructions` | Managed instruction blocks or copies for Pi, Codex, OpenCode, Claude Code, and Cursor.                            |

The compaction-model extension stores its global selection under `~/.pi/agent/state/compaction-model.json`; it is not tied to an individual session and is used only for compaction. During compaction it shows a live elapsed timer and adds a visible compaction receipt with the reason, token count, and model used, plus the final duration to the persistent thread. Configured-model requests apply the credential-derived provider base URL before streaming, including enterprise GitHub Copilot endpoints. If the configured model cannot be used, the fallback warning includes a bounded, redacted lookup, authentication, provider, or request failure reason instead of collapsing every failure into an unavailable-model message.

The utility-model extension stores its global selection under `~/.pi/agent/state/utility-model.json`. The `/utility-model` preference is used by session naming, `/btw`, `/recap`, and `/git:publish` commit drafting so these lightweight requests share one model and can benefit from provider prompt caching. It falls back to the active conversation model when the preference is unset or unavailable.

The `/changes` extension is a read-only, Git-only browser for the union of uncommitted and unpushed files. F5 opens the full-screen TUI and closes it again while focused. The view presents horizontally switchable file tabs, aggregate added and removed line totals, pastel red and green diffs with wrapped lines and collapsed or full-file context, keyboard scrolling, and an edit-request shortcut that pre-fills Pi's input with the selected path. It performs no model calls.

The `/session:find [query]` extension lazily builds an in-memory index over session conversation text, summaries, metadata, custom messages, and user-entered shell commands. It excludes assistant reasoning, tool calls, tool results, and shell output. The full-screen fuzzy finder supports incomplete and misspelled terms, exact URL boosting, all-project or current-project scope, spaced result cards with accented workspace names and high-contrast matched source text, and direct session resumption without persisting a second copy of session content. The active session remains searchable and is labeled `current` in results. `/session:pin` and `/session:unpin` manage the active session's global finder pin, while Ctrl+P toggles the selected result in the finder. Matching pinned sessions are marked and ranked before unpinned matches. Pins persist under `~/.pi/agent/state/session-pins.json` without modifying session transcripts.

Profiles combine these components: `default` selects the available catalog, `pi` selects Pi resources and shared instructions, and `skills` selects all shared skills. Local-only Pi configuration components appear only when their ignored files exist in the local checkout. Registry ordering is deterministic, so repeated installs are no-ops when outputs remain exact.

## Main implementation boundaries

- `src/cli/` and `src/ui/`: automation and interactive Ink interfaces.
- `src/registry/`: component metadata, profiles, dependencies, and destination containment.
- `src/status/`: read-only inspection and receipt interpretation.
- `src/install/`: plans, safety checks, transactions, backup, and rollback.
- `src/doctor/`: local runtime and integrity diagnostics.
- `pi/`: the custom Pi setup, including extensions, themes, prompts, and configuration boundaries. Personal configuration under `pi/config/` remains local-only.
- Other runtime resource directories: package payload loaded or copied by selected components.

The repository is open source, while npm publication remains disabled by `private: true`. Packaging includes the built CLI and public runtime resources, excludes development tests, plans, and local-only Pi configuration, and is constrained to a 2.5 MiB unpacked payload.
