# Azure DevOps pull request metadata

Read only for an Azure Repos PR whose base and head cannot be pinned safely with Git alone. Require authenticated Azure CLI with the `azure-devops` extension.

```bash
az repos pr show --id "$PR" --organization "$ORGANIZATION" \
  --output json --query '{sourceRefName:sourceRefName,targetRefName:targetRefName,head:lastMergeSourceCommit.commitId,base:lastMergeTargetCommit.commitId,repositoryUrl:repository.remoteUrl}'
```

Treat `lastMergeSourceCommit.commitId` and `lastMergeTargetCommit.commitId` as one provider snapshot. Fetch the named source and target refs without pulling, using `repositoryUrl` or an existing matching remote, then verify the fetched objects equal the reported SHAs. If either branch moved during fetch, query metadata again rather than mixing snapshots.

Azure DevOps may expose `refs/pull/<id>/merge`, but that is a synthetic merge commit. Do not use it as the reviewed head. Review the pinned source snapshot with `git diff BASE...HEAD`.

Before synthesis, rerun `az repos pr show` and compare `lastMergeSourceCommit.commitId` with pinned `HEAD`. Stop and require re-review when it changed.
