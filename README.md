# enqueue-pullrequest

A GitHub Action that automatically enqueues pull requests into [GitHub's native merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) based on labels and review status.

## How it works

1. The action is triggered by PR events, review events, check completions, or a periodic schedule.
2. For each relevant PR it checks:
   - PR is open and not a draft (configurable)
   - PR has the trigger label (default: `enqueue-pullrequest`; set to empty string to enqueue all open PRs)
   - PR has no blocking labels (e.g. `wip`, `do-not-merge`)
   - PR targets an allowed base branch (if configured)
   - PR has the required number of approving reviews (if configured)
   - PR is not already in the merge queue
3. Eligible PRs are enqueued via the GitHub GraphQL API (`enqueuePullRequest` mutation).
4. GitHub's merge queue then handles testing and merging according to your branch protection rules.

## Prerequisites

Your repository **must** have the merge queue feature enabled:

1. Go to **Settings → Branches**
2. Edit your branch protection rule (e.g. for `main`)
3. Enable **"Require merge queue"**
4. Configure which status checks must pass

## Usage

Add the following workflow file to your repository at `.github/workflows/enqueue-pullrequest.yml`:

```yaml
name: Enqueue Pull Request

on:
  pull_request:

jobs:
  enqueue-pullrequest:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: waheedahmed/enqueue-pullrequest@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          label: "enqueue-pullrequest"
          skip-labels: "wip,do-not-merge"
```
### Merge Retry Options

Sometimes, the pull request check runs haven't finished yet, so the action will retry the merge after some time. You can control this behavior with the following options:

- `merge-retries`: Number of times to retry enqueueing if it fails. Default is 6. Set to 0 to disable retry logic.
- `merge-retry-sleep`: Time (in milliseconds) to sleep between retries. Default is 5000 (5 seconds). Set to 0 to disable sleeping between retries.

Example usage:

```yaml
      - uses: waheedahmed/enqueue-pullrequest@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          merge-retries: 8
          merge-retry-sleep: 7000
```

Then add the `enqueue-pullrequest` label to any PR you want automatically enqueued once it's ready.

To process only PRs from a specific branch (useful for `schedule` or `workflow_dispatch` triggers), set `branch`:

```yaml
      - uses: waheedahmed/enqueue-pullrequest@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          branch: "feature/my-branch"
```

To enqueue **all** open PRs without requiring a label, set `label` to an empty string:

```yaml
      - uses: waheedahmed/enqueue-pullrequest@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          label: ""
          skip-labels: "wip,do-not-merge"
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `github-token` | Token for GitHub API access. Needs `pull-requests: write`. | `${{ github.token }}` |
| `label` | Label that triggers enqueuing. Set to `""` to process every open PR regardless of labels. | `enqueue-pullrequest` |
| `branch` | Head branch name to filter PRs by for broad events (`schedule`, `workflow_dispatch`, `push`, etc.). Leave empty to process all open PRs. | `""` |
| `skip-labels` | Comma-separated blocking labels (e.g. `wip,do-not-merge`). | `""` |
| `base-branches` | Comma-separated list of allowed base branches. Empty = all branches. | `""` |
| `skip-drafts` | Skip draft pull requests. | `true` |
| `required-approvals` | Minimum approving reviews before enqueuing. `0` = rely on branch protection rules. | `0` |
| `merge-retries` | Number of times to retry enqueueing if it fails. Set to `0` to disable retry logic. | `6` |
| `merge-retry-sleep` | Time (in milliseconds) to sleep between retries. Set to `0` to disable sleeping between retries. | `5000` |

## Token permissions

The default `GITHUB_TOKEN` works for most cases. Use a **Personal Access Token (PAT)** if you need the enqueue action to trigger other workflows (the GitHub platform prevents `GITHUB_TOKEN`-triggered events from starting new workflow runs).

Required scopes for a PAT: `repo` (for private repos) or `public_repo` (for public repos).

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Lint
npm run lint

# Build the distributable (required before committing)
npm run build

# All of the above
npm run all
```

> **Important:** Always run `npm run build` and commit the resulting `dist/` directory before tagging a release. The action runs from `dist/index.js`.

## How GitHub's merge queue differs from auto-merge

| | Merge queue | Auto-merge |
|---|---|---|
| Tests PRs together | Yes — can batch multiple PRs | No — each PR tested in isolation |
| Ordering guarantee | Yes | No |
| Requires branch protection | Yes | Yes |
| Built into GitHub | Yes | Yes |
| Conflict resolution | Handles automatically | Requires manual update |

## License

[MIT](./LICENSE)
