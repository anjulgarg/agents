# Native resumable-subagent adapter

If the host's active, documented tools provide persistent, resumable, long-running child tasks or subagents that return each turn's result, use them. Do not guess tool names or arguments.

## Capability gate

That documented surface is required. If it is absent or undocumented, this adapter is ineligible. With `TRANSPORT=auto`, do not choose a CLI adapter; return ineligible so the caller can ask the user which reviewed CLI to use. A native runtime preflight or start refusal may fall back only when the operation proves that no child session or invocation was created. With `TRANSPORT=native`, stop and report the missing capability.

## Direct prompt

Pass the complete `PROMPT` directly through the native tool's structured task field. Do not create a prompt or system-prompt file merely for the child to read, and do not ask the child to rediscover delegation instructions from the workspace. Reference existing files only when they are source material the child must inspect.

If the host cannot enforce `ACCESS`, use an isolated clean checkout, compare status after every invocation, reject mutated work, and stop using that session.

## Lifecycle

### Persistent start

Start one persistent child task or subagent with `PROMPT` as its complete task text. Capture the stable session identifier. Wait for completion through the host's normal wake or completion mechanism, then take that turn's result.

### Persistent ask

Resume that exact session by identifier with the new `PROMPT` as its task text. Do not supply execution-contract overrides. Wait for completion and take that turn's result.

Never replace the session after a failed resume. Surface the failure to the caller.

### Stop or retain

Retain the session while the caller has more turns. If the host provides non-destructive logical close, use it only when the caller requests closure. Never delete transcripts, worktrees, branches, or repository changes.

## Return

Return the transport (`native`), host harness, mode, model if specified, stable session identifier, latest invocation reference, result payload, lifecycle state when available, and any access or capability limitation.
