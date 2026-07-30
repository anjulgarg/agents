# Migration and recovery

Use a disposable `--home` first. Do not mutate a live home until temporary-home tests, list, doctor, package inspection, backup, and an explicit operation preview all pass.

## Temporary-home rehearsal

```bash
fixture="$(mktemp -d)"
agents install --home "$fixture" --yes
agents list --home "$fixture"
agents doctor --home "$fixture"
agents remove --home "$fixture" --component skill:foreman-plan --yes
agents install --home "$fixture" --component skill:foreman-plan --yes
```

Legacy direct extension copies are recognized before a receipt. Installing the matching component removes only approved legacy destinations and replaces loading with the filtered local package entry. Unknown skills and unrelated harness files remain untouched. Never invoke the retired Python installer to build a migration fixture; copy current repository resources into the old destination shape.

## Live cutover checklist

1. Stop concurrent installers and coordinate active Pi sessions for `/reload`.
2. Build and link locally with `npm ci`, `npm run build`, and `npm link`.
3. Run `npm run test:e2e` and inspect `npm pack --dry-run --json`.
4. Choose a backup directory outside the repository, `~/.agents`, and `~/.pi`. Create it with user-only permissions, for example `umask 077; mkdir -p "$backup"`.
5. Copy only the managed destination files and their parent metadata needed for exact restoration. Include the prior settings, models, keybindings, MCP, teams, direct extensions, shared instruction destinations, Cursor hook files, skills, and any existing receipt. Do not copy or inspect authentication, credentials, sessions, state, npm/git caches, or unrelated resources.
6. Record the current dotfiles commit for pre-cutover restoration: `git -C "$DOTFILES_ROOT" rev-parse HEAD`.
7. Review `agents install` interactively. Apply the default profile only after the paths and dependency additions are correct.
8. Run `agents list` and `agents doctor`. Resolve every unexplained failure or drift.
9. Run `/reload` in every active Pi session, or start a new Pi process. Verify the theme, prompt, skills, product team, and selected extension entrypoints load once without startup errors.
10. Remove old dotfiles ownership only after every prior check passes. Keep the backup until the migrated configuration has been used successfully.

## Failure recovery

If planning is refused, no destination was changed. Fix the reported unsafe path, malformed JSON, unsupported state, missing requirement, or lock and retry. A transaction failure automatically restores affected paths. Do not delete the operation data while recovery is in progress.

For `rollback-failed`, stop immediately. Preserve the exact recovery path printed by the CLI, copy it to a user-only location, and manually restore each affected path before another install. Run `agents list` and `agents doctor` after restoration.

### Restore the pre-cutover live state

1. Stop active agents and installers.
2. Preserve the failed current state separately for diagnosis.
3. Restore backed-up managed paths to their original absolute destinations. Remove only newly created paths that the backup inventory proves did not exist before cutover.
4. Restore the prior receipt, or remove the new receipt only if the backup proves none existed.
5. Confirm the restored managed-path inventory is byte-for-byte equal to the pre-cutover inventory.
6. Run `/reload` in active Pi sessions or restart Pi, then verify the prior behavior.
7. Unlink the local command with `npm unlink --global @anjulgarg/agents` if the CLI itself must be removed.

Never delete credentials or unknown resources as part of restoration.

### Return dotfiles to pre-cutover ownership

Use the recorded dotfiles commit as the source of truth. In a clean disposable checkout or worktree, inspect that commit and restore its coding package and installer through normal Git operations. Do not reset over unrelated work, publish, add a remote, or create a commit unless separately approved. Run the old repository's focused checks before using that restored installer, then reload Pi.

A failed parity, doctor, or reload check blocks dotfiles removal. Restoration is complete only when the managed files match the backup and the prior Pi configuration loads correctly.
