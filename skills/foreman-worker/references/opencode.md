# OpenCode adapter

Use only when `opencode` is selected and available on `PATH`.

Set access and optional model arguments:

```bash
if test "$ACCESS" = read-only; then
    test -n "${READ_ONLY_AGENT:-}"
    ACCESS_ARGS=(--agent "$READ_ONLY_AGENT")
else
    ACCESS_ARGS=(--auto)
    test -z "${WRITE_AGENT:-}" || ACCESS_ARGS+=(--agent "$WRITE_AGENT")
fi
MODEL_ARGS=()
test -z "${MODEL:-}" || MODEL_ARGS+=(-m "$MODEL")
test -z "${EFFORT:-}" || MODEL_ARGS+=(--variant "$EFFORT")
```

Require a verified read-only agent for review work. If none exists, select another harness or use an externally read-only checkout.

## Invoke

### Ephemeral

```bash
opencode run --dir "$CWD" "${ACCESS_ARGS[@]}" --format default \
  "${MODEL_ARGS[@]}" "$(cat "$PROMPT_FILE")" > "$OUTPUT_FILE"
```

OpenCode may retain its internal session, but ephemeral mode means the Foreman never captures or reuses it.

### Persistent start

```bash
opencode run --dir "$CWD" "${ACCESS_ARGS[@]}" --format json \
  "${MODEL_ARGS[@]}" "$(cat "$PROMPT_FILE")" > "$EVENTS_FILE"
SESSION_ID="$(jq -r 'select(.sessionID) | .sessionID' "$EVENTS_FILE" | head -n1)"
test -n "$SESSION_ID" && test "$SESSION_ID" != null
jq -rs '[.[] | select(.type == "text") | .part.text] | join("")' \
  "$EVENTS_FILE" > "$OUTPUT_FILE"
```

### Persistent ask

```bash
opencode run --dir "$CWD" "${ACCESS_ARGS[@]}" --session "$SESSION_ID" \
  --format json "${MODEL_ARGS[@]}" "$(cat "$PROMPT_FILE")" > "$EVENTS_FILE"
jq -rs '[.[] | select(.type == "text") | .part.text] | join("")' \
  "$EVENTS_FILE" > "$OUTPUT_FILE"
```

Use write access only when parent-authorized. Do not rely on prompt wording as a permission boundary. Verify status after every invocation.
