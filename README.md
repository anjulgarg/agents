<h1 align="center">Foreman Stack</h1>

<p align="center">
  <strong>An open-source toolkit for building an enterprise-grade coding harness focused on productivity and quality.</strong>
</p>

<p align="center">
  Skills · prompts · Pi extensions · themes · instructions · safe installation
</p>

The **Foreman Stack** is a collection of tools for building a powerful, enterprise-grade coding
harness. It brings together reusable skills, prompts, instructions, and a custom Pi setup
with extensions that improve productivity, quality, and operational safety across engineering work.

The stack is designed to be inspectable and adaptable. Use the pieces that fit your team, repositories,
and standards, then extend the workflow with your own tools and integrations.

## What is included

- **Pi configuration** with extensions for planning, handoffs, subagents, worktrees,
  checkpoints, memory, jobs, LSP navigation, usage, and focused transcript workflows.
- **Engineering skills** for planning, pull requests, deep code review, specialist review,
  harness-neutral worker orchestration, GitHub workflows, and estimation readiness.
- **Prompts, themes, and instructions** that coordinate repeatable work across supported
  coding-agent harnesses.
- **The `agents` CLI**, which installs selected components transactionally into an alternate home,
  preserves unrelated files, and supports status, diagnostics, removal, backup, and rollback.

The public repository contains the reusable tools and public Pi setup. Personal model choices, MCP
endpoints, keybindings, and other private Pi settings stay local and are intentionally excluded from
the public package. That boundary lets you build the workflow without publishing credentials,
sessions, or personal runtime state.

## Quick start

Prerequisites: Node.js 22.19.0 or newer, npm, Git, and Pi 0.83.0 for Pi resources.

```bash
npm ci
npm run build
npm link
agents
```

The interactive dashboard lets you select a profile or individual component. For a quick install
of the default profile:

```bash
agents install --yes
```

For a disposable or alternate home, always pass `--home`:

```bash
agents install --profile pi --home /absolute/fixture-home --yes
agents doctor --home /absolute/fixture-home
```

Use `agents list` to inspect availability and drift, or add `--json` for machine-readable output.
Use `agents doctor` when something looks unexpected. To remove a selected component, run
`agents remove --component <id> --yes`. After updating an active Pi session, run `/reload`. Every
mutation presents a plan, requires confirmation unless `--yes` is supplied, and can roll back a
failed transaction.

## Profiles and components

| Profile   | Includes                                          |
| --------- | ------------------------------------------------- |
| `default` | Every approved component available in the catalog |
| `pi`      | Pi resources plus shared instructions             |
| `skills`  | All retained cross-harness skills                 |

Components can also be selected directly:

```bash
agents install --category skill --yes
agents install --component skill:foreman-plan --yes
agents remove --component skill:foreman-plan --yes
agents list
agents doctor
```

The catalog covers `skill`, `pi-extension`, `pi-config`, `pi-package`, `pi-prompt`, `pi-theme`,
and `instructions` resources. Dependencies are resolved automatically.

## Explore the stack

- [Architecture and component catalog](docs/architecture.md)
- [Migration and recovery](docs/migration-and-recovery.md)
- [Pi resources](pi/)
- [Pi context efficiency](docs/pi-efficiency.md)
- [Subagent sessions](docs/subagents.md)
- [Skills](skills/)
- [Prompts](pi/prompts/)

## Development

```bash
npm ci
npm run check
npm run test:e2e
npm run pack:check
```

`npm run check` audits the repository, checks formatting and lint, type-checks, runs the unified
Vitest suite, and builds the CLI. Extension test cases use up to four isolated child processes by
default; set `EXTENSION_TEST_CONCURRENCY=1` for serial execution or
`EXTENSION_TEST_VERBOSE=1` to show full passing-test output. The end-to-end suite runs offline with
unique temporary homes and never mutates a real home directory.

## Principles

The Foreman Stack is opinionated about the parts that protect engineering quality:

- **Inspect before editing.** Understand the repository and define done first.
- **Make work legible.** Keep plans, progress, decisions, and failures visible.
- **Delegate deliberately.** Give every worker a bounded task, context, and verification target.
- **Protect the operator.** Preserve unknown files, private state, and unowned configuration.
- **Prefer reversible changes.** Use confirmation, backups, receipts, locking, and rollback.
- **Share the method.** The resources are open for inspection, adaptation, and contribution.

## License

MIT. See [LICENSE](LICENSE).
