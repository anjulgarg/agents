# Copilot CLI adapter

Use only when `copilot` is selected and available on `PATH`.

Set base, access, and optional model arguments:

```bash
BASE_ARGS=(-C "$CWD" -s --no-color --no-ask-user)
if test "$ACCESS" = read-only; then
    ACCESS_ARGS=(--allow-all-tools --deny-tool write --deny-tool shell)
else
    ACCESS_ARGS=(--allow-all-tools)
fi
MODEL_ARGS=()
test -z "${MODEL:-}" || MODEL_ARGS+=(--model "$MODEL")
test -z "${EFFORT:-}" || MODEL_ARGS+=(--effort "$EFFORT")
```

Denials outrank `--allow-all-tools`, so read-only keeps file reads and search while blocking every edit and shell command, including redirection. Put required git history in the prompt file. `--allow-all-tools` is what makes a non-interactive run answer its own approvals; file access still stays inside `$CWD`, and URLs remain unapproved.

`--effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Omit unsupported recommendations.

## Invoke

### Ephemeral

```bash
copilot "${BASE_ARGS[@]}" "${ACCESS_ARGS[@]}" "${MODEL_ARGS[@]}" \
  -p "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

Copilot always records the session locally. Ephemeral means the Foreman never captures or reuses its identifier.

### Persistent start

Preallocate a UUID and retain it:

```bash
SESSION_ID="$(uuidgen 2>/dev/null || node -e 'console.log(require("node:crypto").randomUUID())')"
test -n "$SESSION_ID"
copilot "${BASE_ARGS[@]}" "${ACCESS_ARGS[@]}" "${MODEL_ARGS[@]}" \
  --session-id "$SESSION_ID" -p "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

### Persistent ask

```bash
copilot "${BASE_ARGS[@]}" "${ACCESS_ARGS[@]}" "${MODEL_ARGS[@]}" \
  --resume="$SESSION_ID" -p "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

Never use `--continue`; it resumes the most recent session instead of the recorded one. Never use `--allow-all`, `--yolo`, or `--allow-all-paths`; they drop the path and URL boundaries this adapter depends on. Use write access only when parent-authorized. Verify status after every invocation.
