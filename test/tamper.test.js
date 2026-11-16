import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { custodenJobs, tamperFindings } from '../src/tamper.js'

const ci = `name: CI
on: pull_request
jobs:
  custoden:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: Custoden/action@v0.2.0
  lint:
    needs: [custoden]
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
  test:
    needs:
      - custoden
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`

/** @param {import('../src/api.js').FileFinding[]} f */
const rules = (f) => f.map((x) => x.rule)

describe('tamper findings', () => {
  it('finds the jobs that run Custoden', () => {
    assert.deepEqual(custodenJobs(ci), ['custoden'])
  })

  it('flags removing the Custoden job or deleting the workflow', () => {
    const removed = ci.replace(/  custoden:[\s\S]*?(?=  lint:)/, '').replace('needs: [custoden]', '')
    assert.deepEqual(rules(tamperFindings('.github/workflows/ci.yml', ci, removed)), ['custoden-removed'])
    assert.deepEqual(rules(tamperFindings('.github/workflows/custoden-guard.yml', ci, null)), ['custoden-removed'])
  })

  it('flags dropping a needs gate, in inline and list form', () => {
    assert.deepEqual(rules(tamperFindings('.github/workflows/ci.yml', ci, ci.replace('    needs: [custoden]\n', ''))), ['custoden-weakened'])
    assert.deepEqual(rules(tamperFindings('.github/workflows/ci.yml', ci, ci.replace('    needs:\n      - custoden\n', ''))), ['custoden-weakened'])
  })

  it('flags turning the check off through inputs', () => {
    const weakened = ci.replace('      - uses: Custoden/action@v0.2.0', '      - uses: Custoden/action@v0.2.0\n        continue-on-error: true')
    const finding = tamperFindings('.github/workflows/ci.yml', ci, weakened)
    assert.deepEqual(rules(finding), ['custoden-weakened'])
    assert.equal(finding[0].line, 9)
    const never = ci.replace('      - uses: Custoden/action@v0.2.0', '      - uses: Custoden/action@v0.2.0\n        with:\n          fail-on: never')
    assert.deepEqual(rules(tamperFindings('.github/workflows/ci.yml', ci, never)), ['custoden-weakened'])
  })

  it('flags edits to a vendored copy of the action', () => {
    assert.deepEqual(rules(tamperFindings('.github/actions/custoden/src/index.js', 'a', 'b')), ['custoden-modified'])
  })

  it('ignores ordinary edits, upgrades and workflows without Custoden', () => {
    assert.deepEqual(tamperFindings('.github/workflows/ci.yml', ci, ci.replace('npm test', 'npm test -- --coverage')), [])
    assert.deepEqual(tamperFindings('.github/workflows/ci.yml', ci, ci.replace('@v0.2.0', '@v0.3.0')), [])
    assert.deepEqual(tamperFindings('.github/workflows/ci.yml', ci, ci.replace('lint:', 'format:')), [])
    assert.deepEqual(tamperFindings('.github/workflows/release.yml', 'on: push', null), [])
    assert.deepEqual(tamperFindings('.github/workflows/new.yml', null, ci), [])
  })
})
