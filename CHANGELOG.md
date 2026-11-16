# Changelog

All notable changes to Custoden Check. Versions follow [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-11-16

### Added

- Analyzes new and changed files that run during CI (`package.json`, `conftest.py`, `setup.py`, Makefiles, shell scripts, composite actions and others). Turn off with `ci-files: false`.
- `cancel-runs`: when the check fails, cancel the other workflow runs for the same commit and list them in the summary and comment.
- `pull_request_target` support: changed files are read from the pull request through the GitHub API, so a guard workflow on the default branch can check pull requests without checking out their code.
- `files-checked` and `cancelled-runs` outputs.

### Changed

- Changed files are found with the GitHub compare API instead of scanning the workspace, so the action also works without a checkout on pull requests and pushes.

## [0.1.0] - 2026-11-16

### Added

- Checks npm and PyPI package versions that a pull request, push or merge queue adds or upgrades in `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock` and `requirements*.txt`.
- Analyzes new and changed workflow files.
- File annotations, a job summary and an optional pull request comment.
- `fail-on`, `workflow-fail-on` and `fail-on-incomplete` thresholds.
- Automatic retries for short rate limits, and a warning instead of a failure when the API cannot be reached.
