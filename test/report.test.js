import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { annotations, evaluate, markdown } from '../src/report.js'

/** @returns {import('../src/report.js').Results} */
function sample() {
  return {
    packages: [
      {
        pkg: { ecosystem: 'npm', name: 'evil-pkg', version: '1.0.0' },
        files: ['package-lock.json'],
        report: /** @type {any} */ ({
          verdict: 'malicious',
          risk: 'critical',
          findings: [{ id: 'known-malware', severity: 'critical', title: 'Known malicious package', detail: 'Listed as malware.' }],
          vulnerabilities: [],
        }),
      },
      {
        pkg: { ecosystem: 'npm', name: 'old-pkg', version: '1.0.0' },
        files: ['package-lock.json'],
        report: /** @type {any} */ ({
          verdict: 'ok',
          risk: 'high',
          findings: [],
          vulnerabilities: [{ id: 'GHSA-xxxx', summary: 'Bug', severity: 'high', fixed_in: ['1.0.1'], url: 'https://osv.dev/GHSA-xxxx' }],
        }),
      },
      { pkg: { ecosystem: 'pypi', name: 'later', version: '2.0.0' }, files: ['uv.lock'], error: 'Rate limit exceeded.' },
    ],
    workflows: [
      {
        file: '.github/workflows/ci.yml',
        report: /** @type {any} */ ({
          summary: { critical: 0, high: 0, medium: 1, low: 0, info: 0, total: 1 },
          findings: [
            {
              rule: 'unpinned-action',
              severity: 'medium',
              title: 'Action pinned to a tag',
              detail: 'Tags can be moved.',
              remediation: 'Pin to a full commit SHA.',
              location: { line: 12, column: 9, job: 'build', step: null },
            },
          ],
        }),
      },
    ],
    notes: [],
  }
}

const defaults = /** @type {import('../src/report.js').FailOn} */ ({ packages: 'suspicious', workflows: 'high', incomplete: false })

describe('evaluate', () => {
  it('fails on a malicious package but not on a medium workflow finding', () => {
    const outcome = evaluate(sample(), defaults)
    assert.equal(outcome.failed, true)
    assert.equal(outcome.failingPackages.length, 1)
    assert.equal(outcome.failingFindings.length, 0)
    assert.equal(outcome.errors, 1)
  })

  it('respects never and incomplete', () => {
    assert.equal(evaluate(sample(), { packages: 'never', workflows: 'never', incomplete: false }).failed, false)
    assert.equal(evaluate(sample(), { packages: 'never', workflows: 'medium', incomplete: false }).failed, true)
    assert.equal(evaluate(sample(), { packages: 'never', workflows: 'never', incomplete: true }).failed, true)
  })
})

describe('output', () => {
  it('renders packages, workflow findings, vulnerabilities and unchecked items', () => {
    const results = sample()
    const md = markdown(results, evaluate(results, defaults))
    assert.match(md, /\*\*Failed\.\*\* Checked 2 packages and 1 workflow\./)
    assert.match(md, /`evil-pkg@1\.0\.0` \(npm\) \| malicious/)
    assert.match(md, /Action pinned to a tag/)
    assert.match(md, /GHSA-xxxx/)
    assert.match(md, /`later@2\.0\.0`: Rate limit exceeded\./)
    assert.doesNotMatch(md, /\u2014/)
  })

  it('escapes workflow command data and picks levels by threshold', () => {
    const results = sample()
    results.workflows[0].report.findings[0].title = 'Bad, really: bad'
    const lines = annotations(evaluate(results, defaults), defaults)
    assert.ok(lines[0].startsWith('::error file=package-lock.json,title=evil-pkg@1.0.0 is malicious::'))
    assert.ok(lines[1].startsWith('::warning file=.github/workflows/ci.yml,line=12,col=9,title=medium%3A Bad%2C really%3A bad::'))
    assert.ok(lines[1].includes('%0A'))
  })
})
