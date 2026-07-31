# Native resumable-subagent adapter

Use this adapter only when the current coding harness exposes active, documented subagent tools that satisfy every capability below. Tool names may differ by harness; capabilities and lifecycle semantics are the portable contract.

## Capability gate

The native surface must:

- start a persistent child and return a stable session identifier
- resume that exact session by identifier, never by ambiguous "latest" state
- preserve conversation history and the original cwd, access boundary, model, reasoning, and tool allowlist
- return a distinct invocation reference and retrievable result for every turn
- let the worker consume the trusted `PROMPT_FILE` by attachment or exact-path read without interpolating its contents
- prevent the child from delegating or invoking subagent-management tools
- serialize writers and report busy, blocked, closed, or ownership failures without creating a replacement session
- keep the child within `CWD` and enforce `ACCESS`, or provide a reviewed mitigation using a narrow tool set, isolated clean checkout, before/after status comparison, and rejection of mutated work

If any required capability is absent or uncertain, this adapter is ineligible. With `TRANSPORT=auto`, use one reviewed CLI adapter instead. A native runtime preflight or start refusal may fall back only when the operation proves that no child session or invocation was created. With `TRANSPORT=native`, stop and report the missing capability. Never infer support from a generic agent tool or guess undocumented arguments.

## Prompt-file contract

Resolve `PROMPT_FILE` to a trusted absolute path. The child task tells the worker to read that exact file and follow it as the complete turn prompt. Do not interpolate, print, or copy the file contents into a tool argument.

The child must receive only the tools allowed by `ACCESS`. Read-only review normally needs file read, search, listing, and narrowly scoped Git inspection. If the native harness cannot prevent its shell from mutating, use the adapter's reviewed isolated-checkout mitigation, compare status after every invocation, reject mutated work, and stop using that session.

## Lifecycle

### Persistent start

Invoke the documented native start operation with:

- persistent mode
- the pinned `CWD`
- the requested model and reasoning only when supported
- the narrow `ACCESS` tool allowlist
- a task instructing the child to read `PROMPT_FILE` and answer only that prompt

Capture the stable session identifier plus the first invocation's run/task reference. Wait for completion through the harness's normal wake or completion mechanism, then retrieve the result by exact invocation reference.

### Persistent ask

Invoke the documented exact-session resume operation with the retained session identifier and a task instructing the child to read the new `PROMPT_FILE`. Do not supply execution-contract overrides. Capture the new invocation reference, wait for completion, and retrieve only that invocation's result.

Never replace the session after a failed resume. Surface the failure to the caller.

### Stop or retain

Retain the session while the caller has more turns. If the native surface provides non-destructive logical close, use it only when the caller requests closure. Never delete transcripts, worktrees, branches, or repository changes.

## Pi mapping

Pi's reviewed native mapping is:

- start: `subagent` with `mode="persistent"`, `cwd`, and the requested tool allowlist
- wait: the normal subagent completion wake
- result: `subagent_result` with the returned run ID and task ID
- resume: `subagent_resume` with the stable session ID and the next prompt-file task
- inspect: `subagent_sessions` with the stable session ID
- optional logical close: `subagent_close`

For Pi read-only review, omit edit and write tools. Bash is allowed only for scoped Git inspection in a clean review checkout whose status is compared before and after. A parent session that is not persisted makes native start ineligible before allocation, so auto transport may use a reviewed CLI adapter. Any blocked-session diagnostic after allocation is returned without replacing the worker.

## Return

Return the transport (`native`), host harness, mode, model if specified, stable session identifier, latest invocation reference, result payload, lifecycle state when available, and any access or capability limitation.
