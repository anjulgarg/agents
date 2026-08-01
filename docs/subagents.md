# Subagents

The Pi subagent extension runs delegated work in separate Pi processes. Each invocation has its own run ID and task ID, reports per-invocation output and usage, and is reaped after it settles.

## Ephemeral and persistent modes

Ephemeral mode is the default. It starts a sessionless one-shot child and does not retain a resumable conversation.

```json
{
	"task": "Inspect the parser and report likely defects"
}
```

Choose persistent mode only when later prompts must continue the exact child conversation.

```json
{
	"task": "Investigate the parser and record your evidence",
	"mode": "persistent"
}
```

The spawn result includes a stable `sessionId`. Every invocation still receives a new run ID and task ID.

Persistent mode also works in parallel calls. A task-level `mode` overrides the top-level default, so one call may contain persistent and ephemeral tasks.

## Resume and management

Resume an idle session with its stable ID and a new prompt.

```json
{
	"sessionId": "<stable-child-session-id>",
	"task": "Continue from your earlier evidence and implement the fix"
}
```

`subagent_resume` reopens the same native Pi JSONL session. It restores the original model, thinking level, tool allowlist, trust setting, cwd or retained worktree, workspace mode, and generated system prompt. It accepts no execution-contract overrides. Output and usage remain scoped to the new invocation.

Use `subagent_sessions` with no ID to list visible sessions, or pass `sessionId` to inspect one. Its safe view includes lifecycle state, execution summary, latest run and task references, timestamps, and diagnostics. It omits transcripts, system prompts, credentials, lock nonces, and process ownership tokens.

Use `subagent_close` to make an idle session, or a blocked session with no active lock, non-resumable. Close is logical and non-destructive. It does not delete the child transcript, unknown runtime files, worktrees, branches, or repository changes.

## Conversation and compaction semantics

A resumed child receives normal Pi session context from the same append-only JSONL conversation. If Pi compacted that conversation, the child receives the stored compaction summary and retained tail. The complete transcript remains on disk according to Pi's normal session format.

The F6 thread view reads that durable active branch, merges any live resumed events, and displays cumulative turns, tokens, and cost across invocations. Repeated resumes remain one thread even though each invocation has a distinct run ID and task ID.

A persistent child cannot invoke subagent or subagent-management tools. Dependency outputs may still be supplied through `inputFrom` when spawning or resuming.

## F6 thread view

The F6 thread view is a strictly read-only viewer. It renders the child's active branch merged with live events but offers no editor, child commands, steering, compaction controls, branch navigation, or model changes. Navigation, kill confirmation, parent return, and close behave as before.

### Header

The header is provider-free and responsive. The wide title follows `✓ Subagent 1/1 · gpt-5.6 luna max · 168k/258k · persistent`: an icon-only status directly prefixes the subagent position without a dot separator, followed by a readable model label with thinking effort appended, true context occupancy, and the mode. The running loader and subagent identity share the parent activity indicator's red pastel; model, context, mode, and separators use distinct colors from the parent status-line palette. Provider prefixes are stripped and model IDs are normalized for reading; the stored model identity is never changed. Status uses the same semantic accent as the parent activity indicator while running, such as `◒`, then failure or success coloring for `✗` or `✓`; status words never appear next to the icon in the title.

At narrow widths the title keeps the prefixed status and subagent position plus the readable model, and moves context, mode, and compact cumulative usage into wrapped secondary metadata together with team role and token speed. Cumulative usage moves from the transcript bottom into this metadata and renders like `↻ 18 · ⇅ 317k · $0.0045`; the standard Unicode `⇅` marks combined input/output/cache token traffic, and larger totals use compact lowercase units such as `⇅ 5.5m`. Persistent session IDs are hidden from the visual UI and remain programmatic control identifiers, not visual metadata. Shared workspace text is hidden. Tasks with verified worktree branch metadata show the real branch as `󰙅 <branch>` followed by compact usage; the marker is omitted when no actual branch metadata exists. The complete branch is shown whenever it fits, and only the branch is truncated with `…` when needed to preserve usage. Secondary metadata wraps to the exact terminal width. Static child `mcp` status is filtered while meaningful custom statuses remain.

### Context occupancy

The context segment comes from the child's Pi `get_session_stats` RPC snapshot (`contextUsage`), never from cumulative billed input/output traffic. Known occupancy renders compactly as `168k/258k`; unknown tokens right after compaction render as `unknown/258k`; an absent or invalid snapshot renders `context unavailable`. Cumulative turns, tokens, and cost are separate from the context segment and render as compact cumulative usage in secondary header metadata, not at the transcript bottom.

### Transcript and grouping

Supported parent tools (read, find, grep, ls, edit) render with the same compact presentation and soft grouping as the parent minimal transcript. Consecutive calls collapse into one leader row, `announce_step` does not break an eligible streak, and visible prose or user content does. Successful results collapse; failures keep an explicit row; bash and write remain individually visible. Ctrl+O expands per-call details. Tools outside the shared set keep Pi's generic tool rendering.

### Footer

The footer uses one adaptive hint row. It shows `PgUp/Dn` only when the thread is scrollable and `k/K` only while relevant agents are running. Optional guidance is compacted or dropped before wrapping, while essential navigation remains visible. Historical run groups stay internal: Shift+Left and Shift+Right continue to move across them, and the footer labels that navigation `history` without exposing a run or delegation counter.

## Ownership and branches

A persistent child belongs to the exact persisted parent session that created it. It survives a parent process restart and `/resume` of that parent. It is not globally discoverable or transferable and cannot be claimed from another parent or project session, `/new`, `/fork`, `/clone`, or a parent branch before the child was created.

The registry is reconstructed only from `subagent-session-state` entries visible on the active parent branch. Switching branches immediately changes which child sessions are visible.

Persistent mode requires the parent session to be saved on disk. An in-memory parent cannot create or resume a persistent child.

## Storage and retention

Child session files and lock state live below Pi's agent directory, partitioned by parent session ID. Tests and integrations can inject a separate state root. Runtime files are not package resources and are never written into this repository.

Persistent sessions have no automatic expiry or garbage collection. Logical close preserves their files. Destructive cleanup is intentionally not provided, so operators must treat retained transcripts as local sensitive data and manage storage through their normal Pi data-retention procedures.

## Process and lock safety

Every prompt starts a fresh RPC subprocess against the retained child session. After `agent_settled`, failure, timeout, or abort, the extension reaps the process group before returning the session to `idle`. No dormant child process remains between prompts.

An atomic per-session lock permits only one writer. A live owner is never replaced. On parent restart, an interrupted child is reaped only when its process and ownership token can be verified. Missing ownership, owner mismatch, unsafe storage paths, or unconfirmed cleanup leaves the session `blocked` with a diagnostic instead of risking concurrent JSONL writers.

A later cleanup retry may return a blocked invocation to idle only after process-group cleanup is confirmed. A blocked session can be inspected, and it can be logically closed only when no invocation lock remains.

## Resume validation

Before spawning a resumed child, the extension refuses the request when:

- the session is unknown, busy, blocked, closed, foreign, or absent from the active branch
- the stored model is unavailable or disabled
- a stored tool is no longer active in the parent
- the stored cwd or retained worktree is missing
- the original invocation required project trust and the current parent is untrusted
- the stored child path escapes its parent-partitioned runtime root

Resume never substitutes a different model, changes tools, lowers the frozen trust setting, or creates a replacement conversation.

## Worktrees

A persistent worktree session always resumes in its original retained worktree. Settlement, parent shutdown, and logical close preserve the worktree and branch, including uncommitted changes. If that worktree path is removed externally, resume fails before child creation.
