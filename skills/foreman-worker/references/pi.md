# Pi adapter

Use only when `pi` is selected and available on `PATH`.

Set access and optional model arguments. Use a clean review checkout and compare status because Bash is enabled for Git inspection.

```bash
COMMON=(-p --no-extensions --no-skills --no-prompt-templates --no-context-files)
if test "$ACCESS" = read-only; then
    COMMON+=(--no-approve --tools read,grep,find,ls,bash)
else
    COMMON+=(--approve --tools read,grep,find,ls,bash,edit,write)
fi
MODEL_ARGS=()
test -z "${MODEL:-}" || MODEL_ARGS+=(--model "$MODEL")
test -z "${EFFORT:-}" || MODEL_ARGS+=(--thinking "$EFFORT")
```

## Invoke

### Ephemeral

```bash
cd "$CWD"
env PI_SUBAGENT_CHILD=1 pi "${COMMON[@]}" --no-session \
  "${MODEL_ARGS[@]}" @"$PROMPT_FILE" \
  "Follow the attached prompt." > "$OUTPUT_FILE"
```

### Persistent start

```bash
SESSION_ID="$(uuidgen 2>/dev/null || node -e 'console.log(require("node:crypto").randomUUID())')"
test -n "$SESSION_ID"
cd "$CWD"
env PI_SUBAGENT_CHILD=1 pi "${COMMON[@]}" --session-id "$SESSION_ID" \
  "${MODEL_ARGS[@]}" @"$PROMPT_FILE" \
  "Follow the attached prompt." > "$OUTPUT_FILE"
```

### Persistent ask

```bash
cd "$CWD"
env PI_SUBAGENT_CHILD=1 pi "${COMMON[@]}" --session-id "$SESSION_ID" \
  "${MODEL_ARGS[@]}" @"$PROMPT_FILE" \
  "Follow the attached prompt using retained session context." > "$OUTPUT_FILE"
```

Use write access only when parent-authorized. Never enable worker extensions, skills, prompt templates, context files, or delegation. Verify status after every invocation.
