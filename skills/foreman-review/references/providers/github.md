# GitHub pull request metadata

Read only for a GitHub PR whose base and head cannot be pinned safely with Git alone. Require authenticated `gh`.

```bash
gh pr view "$PR" --repo "$REPOSITORY" \
  --json baseRefName,baseRefOid,headRefName,headRefOid,headRepository,isCrossRepository,url
```

Use `baseRefOid` and `headRefOid` as the pinned provider snapshots. Fetch the corresponding refs without pulling. For a same-repository PR, GitHub exposes the source snapshot as:

```bash
git fetch --no-tags origin "+refs/pull/$PR/head:refs/foreman/github/$PR/head"
```

For a fork, use `headRepository` metadata or an existing matching remote. Verify the fetched commit equals `headRefOid`. Fetch the target branch and verify its commit equals `baseRefOid`; if it moved between metadata and fetch, query metadata again rather than mixing snapshots.

Use `git diff BASE...HEAD` for review. Use `gh pr diff` only when Git cannot fetch the pinned objects and record that limitation. Before synthesis, rerun `gh pr view` and compare `headRefOid` with pinned `HEAD`.
