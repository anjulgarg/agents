# Cursor Agent adapter

Use only when `cursor` or `agent` is selected and the `agent` executable is available.

Set access and optional model arguments:

```bash
if test "$ACCESS" = read-only; then
    ACCESS_ARGS=(--mode ask)
else
    ACCESS_ARGS=(--force)
fi
MODEL_ARGS=()
test -z "${MODEL:-}" || MODEL_ARGS+=(--model "$MODEL")
```

Cursor model strings may encode effort. Omit unsupported standalone effort recommendations.

## Invoke

### Ephemeral

```bash
agent -p --trust --workspace "$CWD" "${ACCESS_ARGS[@]}" --output-format text \
  "${MODEL_ARGS[@]}" "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

Cursor may retain its internal chat, but ephemeral mode means the Foreman never captures or reuses it.

### Persistent start

```bash
SESSION_ID="$(agent create-chat)"
test -n "$SESSION_ID"
agent -p --trust --workspace "$CWD" "${ACCESS_ARGS[@]}" --output-format text \
  --resume "$SESSION_ID" "${MODEL_ARGS[@]}" \
  "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

### Persistent ask

```bash
agent -p --trust --workspace "$CWD" "${ACCESS_ARGS[@]}" --output-format text \
  --resume "$SESSION_ID" "${MODEL_ARGS[@]}" \
  "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

Use write access only when parent-authorized. Do not use `--force` for read-only work. Verify status after every invocation.
