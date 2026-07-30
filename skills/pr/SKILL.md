---
name: pr
description: Pull-request workflow for create, update, and continue. Use for `/pr`, its subcommands, or requests to create, update, resume, prepare, or summarize a PR. Bare `/pr` must prompt for a command.
---

# Pull Request

Preserve enough PR context for humans and future agents. Be direct, evidence-based, and
compressed; retain decisions and verification. Use the repository template, otherwise:

```md
## Problem

## Solution

## Decisions

## Verification

## Follow-ups

## Agent Notes
```

Omit empty sections except relevant verification; never leave placeholders. `Agent Notes` is
operational handoff context, not scratchpad.

## Command routing

Recognize `/pr create`, `/pr update`, `/pr continue`. For bare `/pr`, do not infer; ask:

```text
Which PR command should I run?
- create: open a PR for the current/specified branch.
- update: edit title/body/status/metadata for an existing PR.
- continue: checkout/read the PR, plan unresolved work, then proceed.
```

## Preflight

Identify repository/platform/branch/base/existing PR; inspect status, diff, and recent commits.
For update/continue, first read body, comments, and reviews; preserve useful links, checklists,
context, and user edits. Never push or publish without authorization.

- **Create:** derive title/body from context, diff, commits, issues, and instructions. Prefer
  draft unless ready-for-review is requested. Follow issue-link conventions. Report URL,
  title, base, and verification.
- **Update:** patch only stale, missing, or requested parts; summarize new commits as deltas,
  refresh verification, and remove completed follow-ups.
- **Continue:** checkout head; read PR discussion/issues/commits; plan unresolved work;
  implement scoped changes; verify; update body/comment with changes, checks, and remaining
  work. Reconstruct weak context from history.

Separate assumptions from facts; record non-obvious trade-offs. In `Solution`, prefer
`Did X to fix Y` or `[Action] [Object] [Result] [Rationale]`.
