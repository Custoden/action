/**
 * Findings for changes that remove or weaken Custoden itself. A pull request can edit the workflows it
 * triggers, so these are reported by the guard that runs from the default branch.
 * @typedef {import('./api.js').FileFinding} FileFinding
 */

const USES_CUSTODEN = /uses:\s*['"]?(custoden\/action\b|\.\/\.github\/actions\/custoden\b)/i
const VENDORED = /^\.github\/actions\/custoden\//i

const WEAKENING = [
  { pattern: /^\s*(fail-on|workflow-fail-on):\s*['"]?never\b/gim, what: 'sets a fail threshold to never' },
  { pattern: /^\s*(packages|workflows|ci-files|cancel-runs):\s*['"]?false\b/gim, what: 'turns off part of the check' },
  { pattern: /^\s*continue-on-error:\s*['"]?true\b/gim, what: 'lets a failing step pass' },
]

/** @param {string} text @param {number} index */
const lineOf = (text, index) => (index <= 0 ? 1 : text.slice(0, index).split('\n').length)

/**
 * Job IDs whose steps use Custoden, found by indentation: the nearest less-indented `name:` key below `jobs:`.
 * @param {string} source
 */
export function custodenJobs(source) {
  const lines = source.split(/\r?\n/)
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsAt === -1) return []
  const jobIndent = /^(\s+)\S/.exec(lines.slice(jobsAt + 1).find((l) => /^\s+[\w-]+:\s*$/.test(l)) ?? '')?.[1].length
  if (!jobIndent) return []
  /** @type {Set<string>} */
  const jobs = new Set()
  /** @type {string | null} */
  let current = null
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break
    const key = new RegExp(`^ {${jobIndent}}([\\w-]+):\\s*$`).exec(line)
    if (key) current = key[1]
    else if (current && USES_CUSTODEN.test(line)) jobs.add(current)
  }
  return [...jobs]
}

/** Lines that make a job wait for one of the given jobs. @param {string} source @param {string[]} jobs */
function gateCount(source, jobs) {
  let count = 0
  /** @type {number | null} */
  let listIndent = null
  /** @param {string} s */
  const mentions = (s) => s.split(/[\s,[\]'"]+/).filter((w) => jobs.includes(w)).length
  for (const line of source.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length
    if (listIndent !== null) {
      const item = /^\s*-\s*(.+)$/.exec(line)
      if (item && indent >= listIndent) {
        count += mentions(item[1])
        continue
      }
      listIndent = null
    }
    const m = /^(\s*)needs:\s*(.*)$/.exec(line)
    if (!m) continue
    if (m[2].trim()) count += mentions(m[2])
    else listIndent = m[1].length
  }
  return count
}

/**
 * @param {string} path
 * @param {string | null} before Content at the base commit, or null if the file is new.
 * @param {string | null} after Content at the head commit, or null if the file was removed.
 * @returns {FileFinding[]}
 */
export function tamperFindings(path, before, after) {
  if (VENDORED.test(path)) {
    return [
      {
        rule: 'custoden-modified',
        severity: 'high',
        title: 'Changes the Custoden action vendored in this repository',
        detail: `${after === null ? 'Removes' : 'Edits'} ${path}. A pull request that changes the check it is checked by should be reviewed by a maintainer.`,
        path,
        line: 1,
      },
    ]
  }
  if (before === null || !USES_CUSTODEN.test(before)) return []

  if (after === null || !USES_CUSTODEN.test(after)) {
    return [
      {
        rule: 'custoden-removed',
        severity: 'high',
        title: 'Removes the Custoden check',
        detail: after === null ? `Deletes ${path}, which ran Custoden.` : `${path} ran Custoden before this change and no longer does.`,
        path,
        line: 1,
      },
    ]
  }

  /** @type {FileFinding[]} */
  const findings = []
  for (const w of WEAKENING) {
    const was = before.match(w.pattern)?.length ?? 0
    const now = [...after.matchAll(w.pattern)]
    if (now.length > was) {
      const at = now[now.length - 1].index ?? 0
      findings.push({ rule: 'custoden-weakened', severity: 'high', title: 'Weakens the Custoden check', detail: `${path} ${w.what}.`, path, line: lineOf(after, at) })
      break
    }
  }
  const jobs = custodenJobs(before)
  if (findings.length === 0 && gateCount(after, jobs) < gateCount(before, jobs)) {
    findings.push({
      rule: 'custoden-weakened',
      severity: 'high',
      title: 'Weakens the Custoden check',
      detail: `Fewer jobs in ${path} wait for the ${jobs.join(', ')} job, so they can run before or without the check.`,
      path,
      line: 1,
    })
  }
  return findings
}
