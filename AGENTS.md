# Foreman Stack Guidance

This repository is the public source of truth for the **Foreman Stack**, a collection of tools for
building an enterprise-grade coding harness focused on maximum productivity and quality. It contains
reusable skills, prompts, Pi resources and extensions, themes, instructions, and an installer
that support the workflow.

The stack is designed for real enterprise engineering environments, but it is not a prescriptive
company standard. Treat it as an inspectable toolkit: understand the local repository, adapt the
resources and workflow to its constraints, and keep the quality and safety guarantees intact.

Pi-wide operating and communication behavior is defined by `pi/AGENTS.md`; this file contains
repository-specific constraints and development guidance.

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
- `skills/`, `pi/prompts/`, and `pi/AGENTS.md`: installable resources.
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

Update repository documentation when behavior, commands, configuration, or recovery steps change.
