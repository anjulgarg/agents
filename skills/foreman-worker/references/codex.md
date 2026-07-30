# Codex adapter

Use only when `codex` is selected and available on `PATH`.

Set access and optional model arguments:

```bash
if test "$ACCESS" = read-only; then
    SANDBOX=read-only
else
    SANDBOX=workspace-write
fi
MODEL_ARGS=()
test -z "${MODEL:-}" || MODEL_ARGS+=(-m "$MODEL")
```

Codex CLI has no portable reasoning flag here; omit unsupported effort recommendations.

## Invoke

### Ephemeral

```bash
codex exec -C "$CWD" --sandbox "$SANDBOX" --ephemeral --color never \
  -o "$OUTPUT_FILE" "${MODEL_ARGS[@]}" - < "$PROMPT_FILE"
```

### Persistent start

```bash
codex exec -C "$CWD" --sandbox "$SANDBOX" --color never --json \
  -o "$OUTPUT_FILE" "${MODEL_ARGS[@]}" - \
  < "$PROMPT_FILE" > "$EVENTS_FILE"
SESSION_ID="$(jq -r 'select(.type == "thread.started") | .thread_id' \
  "$EVENTS_FILE" | head -n1)"
test -n "$SESSION_ID" && test "$SESSION_ID" != null
```

### Persistent ask

```bash
cd "$CWD"
codex exec resume --json -o "$OUTPUT_FILE" "${MODEL_ARGS[@]}" \
  "$SESSION_ID" - < "$PROMPT_FILE" > "$EVENTS_FILE"
```

The resumed thread retains its original checkout and sandbox. Use write access only when parent-authorized. Never bypass approvals and sandboxing. Verify status after every invocation.
