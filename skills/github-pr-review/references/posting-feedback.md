# Feedback posting (conditional)

Read this only when posting findings. Use the checked-out PR head and the individual comment API; do not calculate diff `position` manually.

`````bash
HEAD_SHA=$(gh pr view <number> --repo <owner>/<repo> --json headRefOid --jq '.headRefOid')
gh api --method POST repos/<owner>/<repo>/pulls/<number>/comments \
  -F commit_id="$HEAD_SHA" -F path="path/to/file.ts" \
  -F start_line=30 -F start_side="RIGHT" -F line=32 -F side="RIGHT" \
  --body-file - <<'EOF'
**Issue title**

Rationale: one sentence.

Proof: `path/to/file.ts:30-32`.

````suggestion
exact replacement for lines 30-32
`````

EOF

`````

Every finding has a short title, one-line rationale, and file/line proof. For a line-local fix, use a `suggestion`; use **Resolution** for cross-file, design, or ambiguous fixes.

## Suggestions

1. Before writing one, reread the exact current slice from the checked-out PR branch, e.g. `sed -n '30,32p' path/to/file.ts`.
2. Comment the smallest contiguous changed range. Set `start_line` through `line`, both `side="RIGHT"` on added/changed lines; the suggestion has exactly one replacement line per commented line, with no missing or extra lines.
3. Include unchanged context only when GitHub requires it. Never span non-contiguous lines. Replacement code must be syntactically valid.
4. Make the outer fence longer than any inner fence. Use four or more backticks or tildes if replacement text contains backticks/fenced code:

   ````markdown
   ~~~suggestion
   ```ts
   const x = 1
`````

`````
````

Count delimiters before posting; a broken fence renders as prose and disables one-click apply.
`````
