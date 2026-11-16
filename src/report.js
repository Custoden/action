import { COMMENT_MARKER } from './github.js'

/**
 * @typedef {import('./api.js').PackageReport} PackageReport
 * @typedef {import('./api.js').WorkflowReport} WorkflowReport
 * @typedef {import('./api.js').Severity} Severity
 * @typedef {import('./lockfiles.js').Package} Package
 * @typedef {{ pkg: Package, files: string[], report?: PackageReport, error?: string }} PackageResult
 * @typedef {{ file: string, report?: WorkflowReport, error?: string }} WorkflowResult
 * @typedef {{ packages: PackageResult[], workflows: WorkflowResult[], notes: string[] }} Results
 * @typedef {{ packages: 'malicious' | 'suspicious' | 'review' | 'never', workflows: Severity | 'never', incomplete: boolean }} FailOn
 */

export const verdictRank = { ok: 0, review: 1, suspicious: 2, malicious: 3, never: 99 }
export const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4, never: 99 }

/** @param {Results} results @param {FailOn} failOn */
export function evaluate(results, failOn) {
  const packageThreshold = verdictRank[failOn.packages]
  const workflowThreshold = severityRank[failOn.workflows]
  const flaggedPackages = results.packages.filter((r) => r.report && r.report.verdict !== 'ok')
  const failingPackages = flaggedPackages.filter((r) => r.report && verdictRank[r.report.verdict] >= packageThreshold)
  const workflowFindings = results.workflows.flatMap((w) => (w.report?.findings ?? []).map((f) => ({ file: w.file, finding: f })))
  const failingFindings = workflowFindings.filter((x) => severityRank[x.finding.severity] >= workflowThreshold)
  const errors = [...results.packages, ...results.workflows].filter((r) => r.error).length
  const failed = failingPackages.length > 0 || failingFindings.length > 0 || (failOn.incomplete && errors > 0)
  return { flaggedPackages, failingPackages, workflowFindings, failingFindings, errors, failed }
}

/** @param {string} s */
const cell = (s) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

/** @param {Package} p */
const label = (p) => `${p.name}@${p.version}`

/** @param {string} file @param {number} [line] */
function fileLink(file, line) {
  const server = process.env.GITHUB_SERVER_URL
  const repo = process.env.GITHUB_REPOSITORY
  const sha = process.env.GITHUB_SHA
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
  const checkedPackages = results.packages.filter((r) => r.report).length
  const checkedWorkflows = results.workflows.filter((r) => r.report).length
  const lines = ['## Custoden', '']

  const scope = [
    `${checkedPackages} ${checkedPackages === 1 ? 'package' : 'packages'}`,
    `${checkedWorkflows} ${checkedWorkflows === 1 ? 'workflow' : 'workflows'}`,
  ].join(' and ')
  const flagged = outcome.flaggedPackages.length + outcome.workflowFindings.length
  if (outcome.failed) lines.push(`**Failed.** Checked ${scope}.`)
  else if (outcome.errors > 0) lines.push(`**Incomplete.** Checked ${scope}. ${outcome.errors} ${outcome.errors === 1 ? 'item was' : 'items were'} not checked.`)
  else if (flagged > 0) lines.push(`**Passed with warnings.** Checked ${scope}.`)
  else lines.push(`**Passed.** Checked ${scope}. No issues found.`)
  lines.push('')

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

  if (outcome.workflowFindings.length > 0) {
    lines.push('### Workflows', '', '| Location | Severity | Finding |', '|---|---|---|')
    const sorted = [...outcome.workflowFindings].sort((a, b) => severityRank[b.finding.severity] - severityRank[a.finding.severity])
    for (const { file, finding } of sorted) {
      lines.push(`| ${fileLink(file, finding.location.line)} | ${finding.severity} | **${cell(finding.title)}** (\`${finding.rule}\`)<br>${cell(finding.remediation || finding.detail)} |`)
    }
    lines.push('')
  }

  const vulnerable = results.packages.filter((r) => (r.report?.vulnerabilities.length ?? 0) > 0)
  if (vulnerable.length > 0) {
    lines.push('<details><summary>Known vulnerabilities in ' + vulnerable.length + (vulnerable.length === 1 ? ' package' : ' packages') + '</summary>', '')
    lines.push('| Package | Advisories | Fixed in |', '|---|---|---|')
    for (const r of vulnerable) {
      const vulns = /** @type {PackageReport} */ (r.report).vulnerabilities
      const ids = vulns.slice(0, 5).map((v) => `[${v.id}](${v.url})`).join(', ') + (vulns.length > 5 ? ` and ${vulns.length - 5} more` : '')
      const fixed = [...new Set(vulns.flatMap((v) => v.fixed_in))].slice(0, 3).join(', ') || 'no fix yet'
      lines.push(`| \`${cell(label(r.pkg))}\` | ${ids} | ${cell(fixed)} |`)
    }
    lines.push('', '</details>', '')
  }

  const errored = [...results.packages.filter((r) => r.error).map((r) => ({ what: label(r.pkg), error: r.error })),
    ...results.workflows.filter((r) => r.error).map((r) => ({ what: r.file, error: r.error }))]
  if (errored.length > 0 || results.notes.length > 0) {
    lines.push('### Not checked', '')
    for (const note of results.notes) lines.push(`- ${note}`)
    const shown = errored.slice(0, 20)
    for (const e of shown) lines.push(`- \`${cell(e.what)}\`: ${cell(e.error ?? '')}`)
    if (errored.length > shown.length) lines.push(`- ${errored.length - shown.length} more`)
    lines.push('')
  }

  lines.push('<sub>[Custoden](https://docs.custoden.com) checks new and changed dependencies and workflows.</sub>')
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
  for (const { file, finding } of outcome.workflowFindings) {
    const level = severityRank[finding.severity] >= severityRank[failOn.workflows] ? 'error' : finding.severity === 'info' || finding.severity === 'low' ? 'notice' : 'warning'
    const props = `file=${escapeProperty(file)},line=${finding.location.line},col=${finding.location.column},title=${escapeProperty(`${finding.severity}: ${finding.title}`)}`
    out.push(`::${level} ${props}::${escapeData(`${finding.detail}\n${finding.remediation}`.trim())}`)
  }
  return out
}

/** @param {string} body */
export const commentBody = (body) => `${COMMENT_MARKER}\n${body}`
