# Claude Code adapter

Use only when `claude` is selected and available on `PATH`.

## Configure

Set access and optional model arguments:

```bash
if test "$ACCESS" = read-only; then
    ACCESS_ARGS=(--permission-mode plan)
else
    ACCESS_ARGS=(--permission-mode auto)
fi
MODEL_ARGS=()
test -z "${MODEL:-}" || MODEL_ARGS+=(--model "$MODEL")
test -z "${EFFORT:-}" || MODEL_ARGS+=(--effort "$EFFORT")
```

### Ephemeral

```bash
cd "$CWD"
claude -p "${ACCESS_ARGS[@]}" --output-format text \
  --no-session-persistence "${MODEL_ARGS[@]}" \
  < "$PROMPT_FILE" > "$OUTPUT_FILE"
```

### Persistent start

Preallocate a UUID and retain it:

```bash
SESSION_ID="$(uuidgen 2>/dev/null || node -e 'console.log(require("node:crypto").randomUUID())')"
test -n "$SESSION_ID"
cd "$CWD"
claude -p "${ACCESS_ARGS[@]}" --output-format text \
  --session-id "$SESSION_ID" "${MODEL_ARGS[@]}" \
  < "$PROMPT_FILE" > "$OUTPUT_FILE"
```

### Persistent ask

```bash
cd "$CWD"
claude -p "${ACCESS_ARGS[@]}" --output-format text \
  --resume "$SESSION_ID" "${MODEL_ARGS[@]}" \
  < "$PROMPT_FILE" > "$OUTPUT_FILE"
```

Use write access only when parent-authorized. Never use bypass permissions unless an external sandbox grants equivalent authority. Verify status after every invocation.
