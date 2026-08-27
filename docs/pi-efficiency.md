# Pi context efficiency

The Pi profile keeps routine development tools immediately available while deferring larger,
specialized tool definitions until they are needed. This reduces the initial tool context without
removing capabilities.

## Tool availability

A fresh session provides the normal coding surface: file inspection and editing, shell commands,
search, LSP navigation, questions, background jobs, todos, checkpoints, and web search. It also
provides `load_tools`, which can activate these generic optional capabilities:

- `mcp`
- `subagent`
- `memory`
- `handoff`

The model can call `load_tools` when work requires one of them. It accepts either one legacy `capability` value or a `capabilities` array to load several capabilities atomically. Operators can load one or several directly:

```text
/tools:load mcp subagent
```

Loading is additive and idempotent. A loaded capability stays active for the rest of the session;
a new or replacement session returns to the smaller default surface. Invalid command input prints
usage, and a capability whose root tool is not installed reports `unavailable` without changing the
active tools. Consecutive loader calls use the same compact soft-group tree as other grouped tools;
successful collapsed receipts stay hidden until details are expanded.

MCP configuration and connections remain adapter-managed and lazy. Loading the generic `mcp`
capability does not connect to a server, expose configuration, or perform an external call.

## Cache-stable parent context

For the first-party parent, the system prompt is immutable after the first provider request. Changes to
memory, todo, or plan-mode state are emitted as hidden authoritative tail messages instead. Each new
snapshot supersedes older snapshots, while older entries remain in the branch so an unchanged prefix can
remain reusable for providers that support prefix caching. This is a cache-stability design, not a claim
that every provider will cache the prefix.

Optional capability state is branch-local. Resume, reload, and fork restore the latest valid state visible on
the selected branch; a new or empty branch remains lazy until `load_tools` is called. Parent management
tools are monotonic within a branch, but inactive calls remain runtime-guarded and are rejected when
their current state is not valid.

Native deferred tool loading can preserve a prefix only when prompt metadata is unchanged. Fallback providers
may invalidate or rebuild cache when schemas are added. Prompt metadata supplied by an external MCP adapter is
adapter-owned and outside this guarantee. Subagent child initial prompts and isolated utility completions use
separate provider requests and are outside the parent invariant.

## Passive activity

Long-running work displays a fixed `Working` status with bounded elapsed time and activity counts
(tools, changed files, received tokens). It is passive: no progress tool call, prompt instruction,
follow-up message, or additional model turn is created. Completed activity is stored as a muted,
context-free receipt immediately before the final assistant message, never after it. Failure labels
and error coloring are omitted. Historical legacy announcement receipts remain readable.

## Bottom activity panel

Live async commands, subagent activity, and todos share one fixed panel above the editor instead of
animating transcript rows. The panel is capped at 10 lines and inserts a blank line between visible
sections. Async commands appear first with up to 3 lines, subagents next with 1 line, and todos last
with up to 6 lines. When the combined cap applies, earlier sections reserve space for later ones and
each overflowing section uses a `+ N more` hint.

Extensions add declarative sections through the shared TUI bottom-panel compositor. It centralizes
ordering, allocation, truncation, separators, repaint scheduling, and cleanup so future sections do
not need another fixed widget or animation loop. A Jiti-safe process-wide coordinator owns every
project-controlled visual frame source and synchronously batches their render requests onto 100 ms
boundaries; slower requests round up to a multiple of that cadence. Tool and job shimmer, panel
activity, and full-screen extension spinners all subscribe to that clock. The `Working` indicator uses
single-frame updates from the same coordinator instead of Pi's independent 80 ms loader timer. It
advances every glyph in sequence without frame skipping.
Completed jobs leave the panel and retain their final transcript receipt.

## Todo lifecycle

The `todo` tool remains immediately available. Related status changes can be applied atomically with
one `update` call, producing one persisted snapshot. Existing single-item actions remain supported
and idempotent.

Replacing a list automatically starts its first open item when no item is already active. Completing
the sole in-progress item starts the next open item, and the widget hides when every item is done.
The five visible widget slots prioritize unfinished items in list order. When fewer than five unfinished
items remain, the latest completed items in list order fill the leading slots; older completed items move
behind the `+ N more` overflow hint. Compact mutation receipts omit the repeated full queue; `/todos`
and tool details still expose the complete state. At settlement, one hidden reconciliation turn may
continue verified open work, but
it does not recursively schedule itself.
