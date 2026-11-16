import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  changedPackages,
  parseNpmLock,
  parsePipfileLock,
  parsePnpmLock,
  parseRequirements,
  parseTomlLock,
  parseYarnLock,
  parserFor,
} from '../src/lockfiles.js'

/** @param {import('../src/lockfiles.js').Package[]} list */
const names = (list) => list.map((p) => `${p.name}@${p.version}`).sort()

describe('npm lockfiles', () => {
  it('reads v3 packages, nested installs and aliases, and skips links and git sources', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
        'node_modules/a/node_modules/lodash': { version: '3.10.1' },
        'node_modules/my-alias': { name: 'chalk', version: '5.3.0' },
        'node_modules/local': { resolved: 'packages/local', link: true },
        'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc' },
        'packages/local': { version: '0.0.1' },
      },
    })
    assert.deepEqual(names(parseNpmLock(lock)), ['@scope/pkg@2.0.0', 'chalk@5.3.0', 'lodash@3.10.1', 'lodash@4.17.21'])
  })

  it('reads v1 nested dependencies', () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } }, c: { version: 'file:../c' } },
    })
    assert.deepEqual(names(parseNpmLock(lock)), ['a@1.0.0', 'b@2.0.0'])
  })
})

describe('pnpm-lock.yaml', () => {
  it('reads v6 and v9 package keys with peer suffixes', () => {
    const v6 = `lockfileVersion: '6.0'\ndependencies:\n  lodash:\n    specifier: ^4\n    version: 4.17.21\npackages:\n  /lodash@4.17.21:\n    resolution: {integrity: sha512-x}\n  /@babel/core@7.24.0(supports-color@8.1.1):\n    dev: true\n`
    const v9 = `lockfileVersion: '9.0'\npackages:\n  '@types/node@24.1.0':\n    resolution: {integrity: sha512-x}\n  chalk@5.3.0:\n    resolution: {integrity: sha512-y}\nsnapshots:\n  chalk@5.3.0: {}\n`
    assert.deepEqual(names(parsePnpmLock(v6)), ['@babel/core@7.24.0', 'lodash@4.17.21'])
    assert.deepEqual(names(parsePnpmLock(v9)), ['@types/node@24.1.0', 'chalk@5.3.0', 'chalk@5.3.0'])
  })
})

describe('yarn.lock', () => {
  it('reads classic entries', () => {
    const lock = `# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.24.0"\n  resolved "https://registry.yarnpkg.com/x"\n\nlodash@^4.17.21:\n  version "4.17.21"\n`
    assert.deepEqual(names(parseYarnLock(lock)), ['@babel/core@7.24.0', 'lodash@4.17.21'])
  })

  it('reads berry entries and skips workspaces and patches', () => {
    const lock = `__metadata:\n  version: 8\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n\n"lodash@npm:^4.17.21":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n\n"resolve@patch:resolve@npm%3A^1.20.0#~builtin<compat/resolve>":\n  version: 1.22.8\n`
    assert.deepEqual(names(parseYarnLock(lock)), ['lodash@4.17.21'])
  })
})

describe('Python lockfiles', () => {
  it('reads poetry.lock and skips git and directory sources', () => {
    const lock = `[[package]]\nname = "requests"\nversion = "2.32.3"\ndescription = "HTTP"\n\n[package.dependencies]\nidna = ">=2.5"\n\n[[package]]\nname = "mylib"\nversion = "0.1.0"\n\n[package.source]\ntype = "git"\nurl = "https://github.com/x/mylib"\n\n[[package]]\nname = "private"\nversion = "1.0.0"\n\n[package.source]\ntype = "legacy"\nurl = "https://pypi.example.com/simple"\n\n[metadata]\nlock-version = "2.0"\n`
    assert.deepEqual(names(parseTomlLock(lock)), ['private@1.0.0', 'requests@2.32.3'])
  })

  it('reads uv.lock and skips the editable project', () => {
    const lock = `version = 1\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [\n    { name = "httpx" },\n]\n\n[[package]]\nname = "httpx"\nversion = "0.28.1"\nsource = { registry = "https://pypi.org/simple" }\n`
    assert.deepEqual(names(parseTomlLock(lock)), ['httpx@0.28.1'])
  })

  it('reads Pipfile.lock', () => {
    const lock = JSON.stringify({ default: { flask: { version: '==3.0.0' } }, develop: { pytest: { version: '==8.0.0' }, local: { path: '.' } } })
    assert.deepEqual(names(parsePipfileLock(lock)), ['flask@3.0.0', 'pytest@8.0.0'])
  })

  it('reads exact pins from requirements files only', () => {
    const src = `# comment\nrequests==2.32.3 \\\n    --hash=sha256:abc\nuvicorn[standard]==0.30.0 ; python_version >= "3.9"\nflask>=3\n-r other.txt\ngit+https://github.com/x/y\n`
    assert.deepEqual(names(parseRequirements(src)), ['requests@2.32.3', 'uvicorn@0.30.0'])
  })
})

describe('parserFor and changedPackages', () => {
  it('matches lockfile names in subdirectories', () => {
    assert.equal(parserFor('apps/web/package-lock.json')?.ecosystem, 'npm')
    assert.equal(parserFor('requirements-dev.txt')?.ecosystem, 'pypi')
    assert.equal(parserFor('package.json'), undefined)
  })

  it('returns only new versions, once each', () => {
    const before = [{ ecosystem: 'npm', name: 'a', version: '1.0.0' }, { ecosystem: 'npm', name: 'b', version: '1.0.0' }]
    const after = [
      { ecosystem: 'npm', name: 'a', version: '1.0.0' },
      { ecosystem: 'npm', name: 'b', version: '1.1.0' },
      { ecosystem: 'npm', name: 'c', version: '2.0.0' },
      { ecosystem: 'npm', name: 'c', version: '2.0.0' },
    ]
    assert.deepEqual(names(changedPackages(/** @type {any} */ (before), /** @type {any} */ (after))), ['b@1.1.0', 'c@2.0.0'])
  })
})
