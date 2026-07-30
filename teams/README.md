# Pi Teams

Teams are declarative multi-agent workflows layered on the subagent extension. A team selects a
manager model, defines assignable roles, requires a dependency-aware plan, delegates approved
tasks, and tracks review and verification before completion.

- [Pi operational handbook](../README.md)
- [Current product team](product.json)

## Working With Teams

List configured teams by inspecting the JSON files in this directory. Each valid team creates
a command named after its `name`:

```text
/team:product Implement and verify the requested feature
```

Without a goal, the team command opens the dashboard:

```text
/team:product
```

Other commands:

| Command        | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `/teams`       | Inspect runs, tasks, dependencies, outputs, usage, and errors |
| `/team-cancel` | Cancel the active run and kill its running child agents       |
| `F6`           | Inspect underlying subagent threads                           |

From the `/teams` dashboard, press `r` to inspect configured teams and their roles. The role
view shows effective model, thinking, workspace, capacity, review and verification flags, tool
policy, and historical or live task instances. The coordinator is the parent chat agent and is
not listed as a team member.

Only one nonterminal team run is active at a time. Starting another team asks before replacing
the current run. Use `/team-cancel` first when tasks are running: replacement currently marks
the prior run cancelled but does not kill its child processes.

## Team Lifecycle

1. `/team:<name> <goal>` waits for the current agent run to settle.
2. Pi saves the current model and thinking level, then switches to the team's manager.
3. The goal is sent to the manager with the roster and manager protocol in its system prompt.
4. The manager submits a complete dependency graph through `team_plan`.
5. The plan must contain dependent review and verification tasks.
6. When approval is enabled, the user can approve, request changes, or cancel.
7. The manager delegates only dependency-ready tasks through `subagent`.
8. Completed dependency output is injected directly into dependent tasks.
9. Failed tasks may be deliberately reset through `team_retry`.
10. `team_complete` records the verified outcome and restores the original model settings.

Delegation is non-blocking. Completion wakes the manager; it must not poll child agents.
Team state is persisted in session entries and restored with the session. Tasks that were still
running when a session reloads are marked failed rather than silently resumed.

## Add a Team

1. Copy `product.json` or create `teams/<name>.json`.
2. Give it a unique lowercase `name` using letters, numbers, and hyphens.
3. Choose manager and role models that are available in `settings.json`.
4. Include at least one role marked `review` and one marked `verification`.
5. Run `npm ci && npm run build` from the repository root.
6. After installing the local resources, run `/reload` in active Pi sessions.
7. Start it with `/team:<name> <goal>` and review the generated plan.

The filename is not the team identity, but matching the filename to `name` keeps configuration
discoverable. One invalid JSON or team definition prevents all teams from loading for that
extension instance, so validate before installing.

## Complete Shape

```json
{
	"name": "team-name",
	"description": "What this team is optimized to deliver.",
	"manager": {
		"model": "provider/model",
		"thinking": "high",
		"instructions": "Manager-specific coordination instructions."
	},
	"defaults": {
		"model": "provider/model",
		"thinking": "medium",
		"workspace": "shared"
	},
	"roles": {
		"role-name": {
			"description": "What this role contributes.",
			"instructions": "Optional child system-prompt persona.",
			"modelPolicy": "manager",
			"model": "provider/model",
			"allowedModels": ["provider/model"],
			"thinking": "medium",
			"workspace": "shared",
			"maxInstances": 2,
			"review": false,
			"verification": false,
			"tools": ["read", "grep"]
		}
	},
	"limits": {
		"maxConcurrency": 4,
		"requirePlanApproval": true
	}
}
```

### Required Fields

| Field                      | Requirement                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `name`                     | Unique lowercase identifier matching `^[a-z0-9][a-z0-9-]*$` |
| `description`              | Nonempty team purpose                                       |
| `manager.model`            | Available `provider/model` used by the parent manager       |
| `manager.thinking`         | Valid thinking level                                        |
| `manager.instructions`     | Nonempty coordination instructions                          |
| `roles`                    | At least one role                                           |
| `roles.<name>.description` | Nonempty role description                                   |

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Workspace modes are `shared` and `worktree`.

## Model Policies

The effective role fallback is `role.model`, then `defaults.model`.

| Policy    | Behavior                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------- |
| `manager` | Default policy. The manager may request an available model; otherwise the role fallback is used |
| `fixed`   | Locks the role to its configured fallback model                                                 |
| `ask`     | Prompts interactively when the manager does not specify a model                                 |

`manager` does not mean the role inherits `manager.model`. The manager model controls the
parent coordinator only.

`allowedModels` restricts explicit or interactive role choices. Models resolve by exact
`provider/model` or by a unique model ID and must be available to the scoped subagent runtime.

## Role Fields

| Field           | Effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `description`   | Tells the manager when and why to assign the role                          |
| `instructions`  | Optional child system-prompt persona injected on delegation                |
| `modelPolicy`   | Controls model selection as described above                                |
| `model`         | Role-specific fallback model                                               |
| `allowedModels` | Allowed explicit or interactive models                                     |
| `thinking`      | Role-specific thinking default                                             |
| `workspace`     | `shared` or isolated `worktree` execution                                  |
| `maxInstances`  | Maximum concurrent tasks for the role; integer from 1 through 8, default 1 |
| `review`        | Marks this as an independent-review role                                   |
| `verification`  | Marks this as a final-verification role                                    |
| `tools`         | Child tool allowlist copied onto delegated tasks                           |

`description` guides the manager roster only. `instructions`, when set, are stamped onto
delegated subagent tasks and appended to the child system prompt as a `ROLE:` block. Child
behavior is otherwise driven by the approved task description, generic subagent rules, model,
thinking level, workspace, and tool allowlist. Instructions are trimmed, must be nonempty when
present, and are capped at 4000 characters.

## Plan Requirements

The manager's plan may contain 1 through 64 tasks. Every task has this shape:

```json
{
	"id": "stable-task-id",
	"title": "Short title",
	"description": "Bounded assignment, constraints, and success criteria.",
	"role": "role-name",
	"dependsOn": ["prerequisite-id"],
	"model": "provider/model",
	"thinking": "medium",
	"workspace": "shared"
}
```

`model`, `thinking`, `workspace`, and `dependsOn` are optional. Task IDs must be unique
lowercase identifiers. Dependencies must exist, cannot reference the task itself, and cannot
form cycles.

Every accepted plan must include:

- At least one task assigned to a role with `review: true`.
- At least one task assigned to a role with `verification: true`.
- At least one dependency on every review and verification task.

The extension verifies that a dependency exists, but not that it is the implementation being
reviewed. The manager and user must confirm that review and verification tasks depend on the
specific work they inspect. A single role may carry both flags, although separate roles
provide stronger independence. Plan revisions are refused while team tasks are running.

## Concurrency and Workspaces

`limits.maxConcurrency` bounds a delegation batch and defaults to 8. Keep it between 1 and 8
to match the subagent runtime. Each role's `maxInstances` applies independently.

Use `shared` only when parallel tasks own non-overlapping files. Use `worktree` when tasks may
overlap or require isolated commits. Dependency ordering does not by itself prevent two ready
shared-workspace tasks from editing the same file.

## Retry, Kill, and Completion Safety

- The dashboard can kill a selected running task with `k` followed by confirmation.
- `/team-cancel` kills all running child agents for the active team.
- `team_retry` requires a reason field, but the schema currently accepts an empty string. The
  manager must provide a concrete nonempty reason.
- `team_retry` blocks a manually killed task until the user explicitly approves. Plan
  revision can currently clear that marker, so managers must not use revision to bypass the
  same approval requirement before redelegation.
- Successful team completion requires no pending, blocked, or running tasks, plus completed
  review and verification tasks.
- The current completion gate does not reject already-failed tasks. The manager must resolve
  or explicitly account for every failure before reporting success.

Treat a watchdog warning as a reason to inspect current subagent evidence, not proof that a
child is idle.

## Minimal Example

```json
{
	"name": "maintenance",
	"description": "Small team for bounded maintenance changes.",
	"manager": {
		"model": "openai-codex/gpt-5.6-sol",
		"thinking": "high",
		"instructions": "Plan the change, delegate bounded work, and require objective review."
	},
	"defaults": {
		"model": "openai-codex/gpt-5.6-luna",
		"thinking": "medium",
		"workspace": "shared"
	},
	"roles": {
		"builder": {
			"description": "Implements the approved change.",
			"instructions": "Implement only the approved change. Stay inside the assigned ownership boundary and verify before finishing.",
			"modelPolicy": "manager",
			"maxInstances": 2
		},
		"gate": {
			"description": "Independently reviews and verifies the completed change.",
			"instructions": "Review and verify independently. Prefer concrete findings over rewrites.",
			"modelPolicy": "fixed",
			"model": "openai-codex/gpt-5.6-sol",
			"thinking": "high",
			"review": true,
			"verification": true,
			"maxInstances": 1
		}
	},
	"limits": {
		"maxConcurrency": 2,
		"requirePlanApproval": true
	}
}
```

A matching plan must make the `gate` task depend on the `builder` task.

## Validation and Troubleshooting

Validate syntax and extension behavior:

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("teams/product.json", "utf8"))'
npm run test:extensions
```

Common failures:

- **No `/team:<name>` command:** rebuild, reload Pi, and inspect startup errors.
- **Unavailable model:** add it to `enabledModels`, authenticate its provider, or change the
  team definition.
- **Plan rejected:** include dependent review and verification tasks and check for dependency
  cycles.
- **Role cannot run concurrently:** raise `maxInstances` only when ownership is safely split.
- **Team tools are missing:** they activate only while a nonterminal team run is active.
