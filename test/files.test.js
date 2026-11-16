import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCiFile, isLockfile, isWorkflow } from '../src/files.js'

describe('file selection', () => {
  it('selects files that run during CI', () => {
    for (const p of ['package.json', 'tests/conftest.py', 'setup.py', 'Makefile', '.ci-4f9a2c.sh', '.github/prt_exfil.sh', 'actions/x/action.yml', '.husky/pre-commit', 'build.rs']) {
      assert.equal(isCiFile(p), true, p)
    }
    for (const p of ['src/index.ts', 'README.md', '.github/workflows/ci.yml', 'node_modules/a/package.json', 'package-lock.json']) {
      assert.equal(isCiFile(p), false, p)
    }
  })

  it('separates workflows and lockfiles', () => {
    assert.equal(isWorkflow('.github/workflows/build-audit-1a2b3c.yml'), true)
    assert.equal(isWorkflow('.github/workflows/sub/ci.yml'), false)
    assert.equal(isLockfile('apps/web/pnpm-lock.yaml'), true)
    assert.equal(isLockfile('node_modules/x/package-lock.json'), false)
  })
})
