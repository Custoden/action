# Custoden Check

A GitHub Action that checks new and changed dependencies, workflows and CI files with the free [Custoden API](https://docs.custoden.com), and can stop other runs when it finds an attack.

On every pull request it:

- Finds npm and PyPI package versions that the pull request adds or upgrades in your lockfiles, and checks them for malware, suspicious packages and known vulnerabilities.
- Analyzes new and changed files in `.github/workflows` for secret exfiltration, script injection, untrusted checkouts, risky or look-alike actions and indicators of known campaigns.
- Analyzes new and changed files that run during CI, such as `package.json` scripts, `conftest.py`, `setup.py`, Makefiles and shell scripts, where campaigns like prt-scan and wfx-loot hid their payloads.
- Annotates the affected files, writes a job summary, and fails the check when something crosses your threshold.
- Optionally cancels the other workflow runs for the same commit.

Only what changed is checked, so the free rate limit goes a long way.

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
      - uses: Custoden/action@v0.3.0
```

Pin `Custoden/action` to the commit SHA of the release too, with the version as a comment.

To also post the results as a pull request comment, add `pull-requests: write` to `permissions` and set `comment: true`. The comment is created when there is something to report and updated on later pushes.

## Stopping attacks

### Gate your jobs

Run Custoden as the first job and make the jobs that install dependencies or run code depend on it. When the check fails, they never start, so a malicious `postinstall` hook, test setup file or package never runs.

```yaml
jobs:
  custoden:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: Custoden/action@v0.3.0
  test:
    needs: custoden
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: npm ci
      - run: npm test
```

### Guard every pull request

A pull request can edit the workflows it triggers. A guard on `pull_request_target` always runs from your default branch, so the pull request cannot change or remove it. The action reads the pull request's changed files through the GitHub API and never checks out or runs them.

```yaml
name: Custoden guard
on:
  pull_request_target:
permissions:
  contents: read
  actions: write
  pull-requests: write
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: Custoden/action@v0.3.0
        with:
          cancel-runs: true
          comment: true
```

With `cancel-runs: true`, a failed check cancels every other run for the pull request's commit, including workflows the pull request added, and lists them in the summary and comment. Do not add a checkout of the pull request head to this workflow.

### If a pull request removes Custoden

A pull request can delete the gate from the workflows it triggers, but not the guard, which runs from your default branch. The guard reports these changes as `high` findings, so they fail the check and, with `cancel-runs`, stop the pull request's runs:

| Rule | When |
|---|---|
| `custoden-removed` | A workflow that ran Custoden no longer does, or is deleted |
| `custoden-weakened` | Fewer jobs wait for the Custoden job, or the step gets `continue-on-error`, a `never` threshold or a check turned off |
| `custoden-modified` | A copy of the action vendored in `.github/actions/custoden` is changed |

If you remove Custoden on purpose, merge the change and the guard stops reporting it.

### What this can and cannot stop

- Jobs gated with `needs` never start, so their code never runs, unless the pull request also removes the gate. The guard then reports the removal and cancels the run, which is a race.
- Cancelling is a race. A run that starts at the same moment as the guard may execute its first steps before it is stopped. Payloads that collect for a while before sending are usually stopped in time, but rotate any secret a cancelled run could read.
- Someone with write access can push to a branch and trigger `push` workflows directly. Protect your default branch, require pull requests, and keep secrets in environments with required reviewers.
- Do not rely on required status checks alone. Some payloads post forged `success` statuses for the check names a repository requires.

### Pushes and merge queues

On `push` and `merge_group` the action compares against the previous commit. On other events, such as `schedule` and `workflow_dispatch`, there is no base to compare with, so it analyzes every workflow and skips packages and CI files.

## Inputs

| Input | Default | Description |
|---|---|---|
| `fail-on` | `suspicious` | Fail when a package verdict is this or worse: `malicious`, `suspicious`, `review` or `never` |
| `workflow-fail-on` | `high` | Fail when a workflow or CI file finding has this severity or higher: `critical`, `high`, `medium`, `low` or `never` |
| `fail-on-incomplete` | `false` | Fail when some items could not be checked, for example when the API is unreachable or the rate limit is reached |
| `packages` | `true` | Check lockfiles |
| `workflows` | `true` | Check workflow files |
| `ci-files` | `true` | Check files that run during CI |
| `cancel-runs` | `false` | When the check fails, cancel other runs for the same commit. Needs `actions: write` |
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
| `files-checked` | Number of CI files analyzed |
| `findings` | Flagged packages plus workflow and CI file findings |
| `cancelled-runs` | Number of other runs that were cancelled |
| `report` | Path to the full JSON report |

## Supported lockfiles

| Ecosystem | Files |
|---|---|
| npm | `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (classic and Berry) |
| PyPI | `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements*.txt` (exact `==` pins) |

Lockfiles in subdirectories are found too. Packages from git, local paths and workspaces are skipped.

## CI files

`package.json`, `setup.py`, `setup.cfg`, `pyproject.toml`, `conftest.py`, `noxfile.py`, `tox.ini`, Makefiles, `build.rs`, `action.yml`, `Rakefile`, `Taskfile.yml`, `justfile`, shell and PowerShell scripts (including hidden ones), and Git hooks in `.husky/`.

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

The action sends package names and versions, and the contents of changed workflow files and CI files, to the Custoden API. Nothing else from your repository leaves the runner. Workflows and packages are analyzed in memory and not stored.

The action has no dependencies at runtime. It runs on Node 24 and uses only built-in modules.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
