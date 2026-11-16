# Changelog

All notable changes to Custoden Check. Versions follow [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-11-16

### Added

- Checks npm and PyPI package versions that a pull request, push or merge queue adds or upgrades in `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock` and `requirements*.txt`.
- Analyzes new and changed workflow files.
- File annotations, a job summary and an optional pull request comment.
- `fail-on`, `workflow-fail-on` and `fail-on-incomplete` thresholds.
- Automatic retries for short rate limits, and a warning instead of a failure when the API cannot be reached.
