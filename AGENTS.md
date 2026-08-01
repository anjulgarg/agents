# Foreman Stack Guidance

This repository is the public source of truth for the **Foreman Stack**, a collection of tools for
building an enterprise-grade coding harness focused on maximum productivity and quality. It contains
reusable skills, prompts, Pi resources and extensions, teams, themes, instructions, and an installer
that support the workflow.

The stack is designed for real enterprise engineering environments, but it is not a prescriptive
company standard. Treat it as an inspectable toolkit: understand the local repository, adapt the
resources and workflow to its constraints, and keep the quality and safety guarantees intact.

## Working agreement

- Define the requested outcome and the checks that will prove it before editing.
- Inspect the smallest relevant files first, then expand only when dependencies or risk require it.
- Prefer the smallest maintainable change and avoid unrelated refactoring or new dependencies.
- Make plans, progress, decisions, and failures legible to the operator.
- Delegate only with bounded ownership, sufficient context, and explicit verification criteria.
- Follow existing naming, module, test, formatting, and documentation conventions.
- Do not overwrite or discard unrelated working-tree changes.
- Update documentation when behavior, commands, configuration, or recovery steps change.

## Safety boundaries

- Never add credentials, authentication data, sessions, caches, private runtime state, or personal
  configuration.
- Preserve unknown files, unowned JSON fields, and resources outside the selected component.
- Keep destination containment, link checks, locking, backup, receipt, rollback, and confirmation
  protections intact.
- Treat changes under `src/install/`, `src/status/`, `src/registry/`, migration code, and removal
  flows as high risk. Add focused regression tests for changed behavior.
- Keep the public package reusable. Personal Pi settings, model overrides, MCP endpoints,
  credentials, sessions, and runtime state belong in local-only files under `pi/config/`.

## Repository map

- `src/cli/` and `src/ui/`: command automation and the interactive Ink interface.
- `src/registry/`: component definitions, profiles, dependencies, and destinations.
- `src/status/`: read-only inspection and receipt handling.
- `src/install/`: planning, safety checks, transactions, backup, and rollback.
- `src/doctor/`: runtime and integrity diagnostics.
- `pi/`: Pi-specific extensions, configuration boundaries, themes, and keybindings.
- `skills/`, `pi/prompts/`, `pi/teams/`, and `pi/AGENTS.md`: installable resources.
- `docs/`: architecture, migration, and recovery documentation.

## Development

Use Node.js 22.19.0 or newer and install dependencies with `npm ci`.

```bash
npm run check
npm run test:e2e
npm run pack:check
```

Run the narrowest relevant test while iterating. Before handing off a code change, run
`npm run check`. For packaging changes, also run `npm run pack:check`. End-to-end tests must run
offline in isolated temporary homes.

## Completion

Before declaring work complete, report the changed behavior, the verification performed, and any
remaining risk or follow-up. Do not claim completion when required checks are failing or were not
run.
