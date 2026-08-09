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

## Passive activity

Long-running work displays a coarse phase derived from actual model and tool lifecycle events:

- `Working` when no tool is active
- `Inspecting`
- `Editing`
- `Running tests`
- `Building`
- `Running command`

When no tool is active, the live status uses `Working` rather than guessing `Running command`. The
status includes bounded elapsed time and activity counts. It is passive: no progress tool call,
prompt instruction, follow-up message, or additional model turn is created. Completed activity is
stored as a muted, context-free receipt immediately before the final assistant message, never after
it. Failure labels and error coloring are omitted. Historical legacy announcement receipts remain
readable.

## Todo lifecycle

The `todo` tool remains immediately available. Related status changes can be applied atomically with
one `update` call, producing one persisted snapshot. Existing single-item actions remain supported
and idempotent.

Replacing a list automatically starts its first open item when no item is already active. Completing
the sole in-progress item starts the next open item, and the widget hides when every item is done.
Compact mutation receipts omit the repeated full queue; `/todos` and tool details still expose the
complete state. At settlement, one hidden reconciliation turn may continue verified open work, but
it does not recursively schedule itself.
