import { COMMENT_MARKER } from './github.js'

/**
 * @typedef {import('./api.js').PackageReport} PackageReport
 * @typedef {import('./api.js').WorkflowReport} WorkflowReport
 * @typedef {import('./api.js').FileFinding} FileFinding
 * @typedef {import('./api.js').Severity} Severity
 * @typedef {import('./lockfiles.js').Package} Package
 * @typedef {{ pkg: Package, files: string[], report?: PackageReport, error?: string }} PackageResult
 * @typedef {{ file: string, report?: WorkflowReport, error?: string }} WorkflowResult
 * @typedef {{ file: string, findings?: FileFinding[], error?: string, tamper?: boolean }} FileResult
 * @typedef {{ id: number, name: string, url: string, cancelled: boolean }} CancelledRun
 * @typedef {{ packages: PackageResult[], workflows: WorkflowResult[], files: FileResult[], notes: string[], cancelled: CancelledRun[] }} Results
 * @typedef {{ packages: 'malicious' | 'suspicious' | 'review' | 'never', workflows: Severity | 'never', incomplete: boolean }} FailOn
 * @typedef {{ file: string, line: number, column: number, severity: Severity, title: string, rule: string, detail: string, remediation: string }} CodeFinding
 */

export const verdictRank = { ok: 0, review: 1, suspicious: 2, malicious: 3, never: 99 }
export const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4, never: 99 }

/** @param {Results} results @returns {CodeFinding[]} */
function codeFindings(results) {
  return [
    ...results.workflows.flatMap((w) =>
      (w.report?.findings ?? []).map((f) => ({
        file: w.file,
        line: f.location.line,
        column: f.location.column,
        severity: f.severity,
        title: f.title,
        rule: f.rule,
        detail: f.detail,
        remediation: f.remediation,
      })),
    ),
    ...results.files.flatMap((r) =>
      (r.findings ?? []).map((f) => ({
        file: f.path,
        line: f.line,
        column: 1,
        severity: f.severity,
        title: f.title,
        rule: f.rule,
        detail: f.detail,
        remediation: '',
      })),
    ),
  ]
}

/** @param {Results} results @param {FailOn} failOn */
export function evaluate(results, failOn) {
  const flaggedPackages = results.packages.filter((r) => r.report && r.report.verdict !== 'ok')
  const failingPackages = flaggedPackages.filter((r) => r.report && verdictRank[r.report.verdict] >= verdictRank[failOn.packages])
  const findings = codeFindings(results)
  const failingFindings = findings.filter((f) => severityRank[f.severity] >= severityRank[failOn.workflows])
  const errors = [...results.packages, ...results.workflows, ...results.files].filter((r) => r.error).length
  const failed = failingPackages.length > 0 || failingFindings.length > 0 || (failOn.incomplete && errors > 0)
  return { flaggedPackages, failingPackages, findings, failingFindings, errors, failed }
}

/** @param {string} s */
const cell = (s) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

/** @param {Package} p */
const label = (p) => `${p.name}@${p.version}`

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** @param {string} file @param {number} [line] */
function fileLink(file, line) {
  const server = process.env.GITHUB_SERVER_URL
  const repo = process.env.GITHUB_REPOSITORY
  const sha = process.env.CUSTODEN_HEAD_SHA || process.env.GITHUB_SHA
  const text = line ? `${file}:${line}` : file
  if (!server || !repo || !sha) return `\`${text}\``
  return `[\`${text}\`](${server}/${repo}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''})`
}

/**
 * Markdown for the job summary and pull request comment.
 * @param {Results} results
 * @param {ReturnType<typeof evaluate>} outcome
 */
export function markdown(results, outcome) {
  const scope = [
    count(results.packages.filter((r) => r.report).length, 'package', 'packages'),
    count(results.workflows.filter((r) => r.report).length, 'workflow', 'workflows'),
    count(results.files.filter((r) => r.findings && !r.tamper).length, 'CI file', 'CI files'),
  ]
  const scopeText = `${scope[0]}, ${scope[1]} and ${scope[2]}`
  const lines = ['## Custoden', '']

  const flagged = outcome.flaggedPackages.length + outcome.findings.length
  if (outcome.failed) lines.push(`**Failed.** Checked ${scopeText}.`)
  else if (outcome.errors > 0) lines.push(`**Incomplete.** Checked ${scopeText}. ${count(outcome.errors, 'item was', 'items were')} not checked.`)
  else if (flagged > 0) lines.push(`**Passed with warnings.** Checked ${scopeText}.`)
  else lines.push(`**Passed.** Checked ${scopeText}. No issues found.`)
  lines.push('')

  const stopped = results.cancelled.filter((r) => r.cancelled)
  const failedToStop = results.cancelled.filter((r) => !r.cancelled)
  if (stopped.length || failedToStop.length) {
    lines.push('### Stopped runs', '')
    if (stopped.length) lines.push(`Cancelled ${count(stopped.length, 'other workflow run', 'other workflow runs')} on this commit:`, '')
    for (const r of stopped) lines.push(`- [${cell(r.name)}](${r.url})`)
    for (const r of failedToStop) lines.push(`- Could not cancel [${cell(r.name)}](${r.url})`)
    lines.push('', 'Check those runs. If any step ran before it was cancelled, rotate the secrets it could read.', '')
  }

  if (outcome.flaggedPackages.length > 0) {
    lines.push('### Packages', '', '| Package | Verdict | Findings | Lockfile |', '|---|---|---|---|')
    const sorted = [...outcome.flaggedPackages].sort((a, b) => verdictRank[b.report?.verdict ?? 'ok'] - verdictRank[a.report?.verdict ?? 'ok'])
    for (const r of sorted) {
      const report = /** @type {PackageReport} */ (r.report)
      const findings = report.findings.map((f) => `${f.severity}: ${f.title}`).join('<br>')
      lines.push(`| \`${cell(label(r.pkg))}\` (${r.pkg.ecosystem}) | ${report.verdict} | ${cell(findings)} | ${r.files.map((f) => fileLink(f)).join('<br>')} |`)
    }
    lines.push('')
  }

  if (outcome.findings.length > 0) {
    lines.push('### Workflows and CI files', '', '| Location | Severity | Finding |', '|---|---|---|')
    const sorted = [...outcome.findings].sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    for (const f of sorted) {
      lines.push(`| ${fileLink(f.file, f.line)} | ${f.severity} | **${cell(f.title)}** (\`${f.rule}\`)<br>${cell(f.remediation || f.detail)} |`)
    }
    lines.push('')
  }

  const vulnerable = results.packages.filter((r) => (r.report?.vulnerabilities.length ?? 0) > 0)
  if (vulnerable.length > 0) {
    lines.push(`<details><summary>Known vulnerabilities in ${count(vulnerable.length, 'package', 'packages')}</summary>`, '')
    lines.push('| Package | Advisories | Fixed in |', '|---|---|---|')
    for (const r of vulnerable) {
      const vulns = /** @type {PackageReport} */ (r.report).vulnerabilities
      const ids = vulns.slice(0, 5).map((v) => `[${v.id}](${v.url})`).join(', ') + (vulns.length > 5 ? ` and ${vulns.length - 5} more` : '')
      const fixed = [...new Set(vulns.flatMap((v) => v.fixed_in))].slice(0, 3).join(', ') || 'no fix yet'
      lines.push(`| \`${cell(label(r.pkg))}\` | ${ids} | ${cell(fixed)} |`)
    }
    lines.push('', '</details>', '')
  }

  const errored = [
    ...results.packages.filter((r) => r.error).map((r) => ({ what: label(r.pkg), error: r.error })),
    ...results.workflows.filter((r) => r.error).map((r) => ({ what: r.file, error: r.error })),
    ...results.files.filter((r) => r.error).map((r) => ({ what: r.file, error: r.error })),
  ]
  if (errored.length > 0 || results.notes.length > 0) {
    lines.push('### Not checked', '')
    for (const note of results.notes) lines.push(`- ${note}`)
    const shown = errored.slice(0, 20)
    for (const e of shown) lines.push(`- \`${cell(e.what)}\`: ${cell(e.error ?? '')}`)
    if (errored.length > shown.length) lines.push(`- ${errored.length - shown.length} more`)
    lines.push('')
  }

  lines.push('<sub>[Custoden](https://docs.custoden.com) checks new and changed dependencies, workflows and CI files.</sub>')
  return lines.join('\n')
}

/** @param {string} s */
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
/** @param {string} s */
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/**
 * Workflow commands that annotate files in the run and pull request.
 * @param {ReturnType<typeof evaluate>} outcome
 * @param {FailOn} failOn
 */
export function annotations(outcome, failOn) {
  /** @type {string[]} */
  const out = []
  for (const r of outcome.flaggedPackages) {
    const report = /** @type {PackageReport} */ (r.report)
    const level = verdictRank[report.verdict] >= verdictRank[failOn.packages] ? 'error' : 'warning'
    const detail = report.findings.map((f) => `${f.severity}: ${f.title}. ${f.detail}`).join('\n')
    for (const file of r.files) {
      out.push(`::${level} file=${escapeProperty(file)},title=${escapeProperty(`${label(r.pkg)} is ${report.verdict}`)}::${escapeData(detail)}`)
    }
  }
  for (const f of outcome.findings) {
    const level = severityRank[f.severity] >= severityRank[failOn.workflows] ? 'error' : f.severity === 'info' || f.severity === 'low' ? 'notice' : 'warning'
    const props = `file=${escapeProperty(f.file)},line=${f.line},col=${f.column},title=${escapeProperty(`${f.severity}: ${f.title}`)}`
    out.push(`::${level} ${props}::${escapeData(`${f.detail}\n${f.remediation}`.trim())}`)
  }
  return out
}

/** @param {string} body */
export const commentBody = (body) => `${COMMENT_MARKER}\n${body}`
