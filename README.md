# Custoden Check

A GitHub Action that checks new and changed dependencies and workflows with the free [Custoden API](https://docs.custoden.com).

On every pull request it:

- Finds npm and PyPI package versions that the pull request adds or upgrades in your lockfiles, and checks them for malware, suspicious packages and known vulnerabilities.
- Analyzes new and changed files in `.github/workflows` for secret exfiltration, script injection, untrusted checkouts, risky or look-alike actions and indicators of known campaigns.
- Annotates the affected files, writes a job summary, and fails the check when something crosses your threshold.

Only the lines that changed are checked, so the free rate limit goes a long way.

## Usage

```yaml
name: Custoden
on:
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: Custoden/action@v0.1.0
```

Pin `Custoden/action` to the commit SHA of the release too, with the version as a comment.

To also post the results as a pull request comment, add `pull-requests: write` to `permissions` and set `comment: true`. The comment is created when there is something to report and updated on later pushes.

### Pushes and merge queues

On `push` and `merge_group` the action compares against the previous commit. On other events, such as `schedule` and `workflow_dispatch`, there is no base to compare with, so it analyzes every workflow and skips packages.

## Inputs

| Input | Default | Description |
|---|---|---|
| `fail-on` | `suspicious` | Fail when a package verdict is this or worse: `malicious`, `suspicious`, `review` or `never` |
| `workflow-fail-on` | `high` | Fail when a workflow finding has this severity or higher: `critical`, `high`, `medium`, `low` or `never` |
| `fail-on-incomplete` | `false` | Fail when some items could not be checked, for example when the API is unreachable or the rate limit is reached |
| `packages` | `true` | Check lockfiles |
| `workflows` | `true` | Check workflow files |
| `comment` | `false` | Post a pull request comment. Needs `pull-requests: write` |
| `max-packages` | `50` | Most packages to check in one run. The rest are listed as not checked |
| `github-token` | `${{ github.token }}` | Used to read files at the base commit and to post the comment |
| `api-url` | `https://api.custoden.com` | API base URL |

## Outputs

| Output | Description |
|---|---|
| `result` | `pass` or `fail` |
| `packages-checked` | Number of packages checked |
| `workflows-checked` | Number of workflows analyzed |
| `findings` | Flagged packages plus workflow findings |
| `report` | Path to the full JSON report |

## Supported lockfiles

| Ecosystem | Files |
|---|---|
| npm | `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (classic and Berry) |
| PyPI | `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements*.txt` (exact `==` pins) |

Lockfiles in subdirectories are found too. Packages from git, local paths and workspaces are skipped.

## Verdicts

| Verdict | Default handling |
|---|---|
| `malicious` | Fails |
| `suspicious` | Fails |
| `review` | Warning |
| `ok` | Passes. Known vulnerabilities are listed in the summary |

See [package findings](https://docs.custoden.com/reference/package-findings) and [workflow rules](https://docs.custoden.com/reference/workflow-rules) for what each finding means.

## When the API cannot be reached

The action retries, then reports a warning that the Custoden API could not be reached and lists what was not checked. The job still passes unless `fail-on-incomplete` is `true`. The same applies when the [rate limit](https://docs.custoden.com/getting-started/rate-limits) is reached: short waits are retried automatically, and the daily limit stops the run with a warning.

## Privacy

The action sends package names and versions, and the contents of changed workflow files, to the Custoden API. Nothing else from your repository leaves the runner. Workflows and packages are analyzed in memory and not stored.

The action has no dependencies at runtime. It runs on Node 24 and uses only built-in modules.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
