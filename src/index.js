import { access, appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError, BATCH_SIZE, FILES_BATCH_BYTES, FILES_BATCH_SIZE, createClient } from './api.js'
import { discover, isCiFile, isLockfile, isWorkflow } from './files.js'
import { createGitHub } from './github.js'
import { changedPackages, packageKey, parserFor } from './lockfiles.js'
import { annotations, commentBody, evaluate, markdown } from './report.js'

/**
 * @typedef {import('./report.js').PackageResult} PackageResult
 * @typedef {import('./report.js').WorkflowResult} WorkflowResult
 * @typedef {import('./report.js').FileResult} FileResult
 * @typedef {import('./report.js').CancelledRun} CancelledRun
 * @typedef {import('./report.js').FailOn} FailOn
 * @typedef {import('./report.js').Results} Results
 */

/** @param {string} name @param {string} [fallback] */
function input(name, fallback = '') {
  return (process.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] ?? '').trim() || fallback
}

/** @param {string} name @param {boolean} fallback */
function boolInput(name, fallback) {
  const value = input(name).toLowerCase()
  if (!value) return fallback
  if (['true', 'yes', '1'].includes(value)) return true
  if (['false', 'no', '0'].includes(value)) return false
  throw new Error(`Input ${name} must be true or false.`)
}

/** @template {string} T @param {string} name @param {readonly T[]} allowed @returns {T} */
function choiceInput(name, allowed) {
  const value = /** @type {T} */ (input(name, allowed[0]).toLowerCase())
  if (!allowed.includes(value)) throw new Error(`Input ${name} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** @param {string} file @param {string} text */
async function append(file, text) {
  if (file) await appendFile(file, text.endsWith('\n') ? text : `${text}\n`)
}

/** @param {unknown} err */
const message = (err) => (err instanceof Error ? err.message : String(err))

/**
 * Which commits to compare, where to read changed files from, and which commit's runs to cancel.
 * @param {any} event
 * @param {string} name
 */
function commits(event, name) {
  const sha = process.env.GITHUB_SHA ?? ''
  if (name === 'pull_request' || name === 'pull_request_target') {
    const remote = name === 'pull_request_target'
    const head = event.pull_request?.head?.sha ?? sha
    return { base: event.pull_request?.base?.sha ?? null, head: remote ? head : sha, runs: head, remote }
  }
  if (name === 'merge_group') return { base: event.merge_group?.base_sha ?? null, head: event.merge_group?.head_sha ?? sha, runs: sha, remote: false }
  if (name === 'push' && typeof event.before === 'string' && !/^0+$/.test(event.before)) return { base: event.before, head: sha, runs: sha, remote: false }
  return { base: null, head: sha, runs: sha, remote: false }
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  /** @type {FailOn} */
  const failOn = {
    packages: choiceInput('fail-on', /** @type {const} */ (['suspicious', 'malicious', 'review', 'never'])),
    workflows: choiceInput('workflow-fail-on', /** @type {const} */ (['high', 'critical', 'medium', 'low', 'never'])),
    incomplete: boolInput('fail-on-incomplete', false),
  }
  const checkPackages = boolInput('packages', true)
  const checkWorkflows = boolInput('workflows', true)
  const checkFiles = boolInput('ci-files', true)
  const cancel = boolInput('cancel-runs', false)
  const comment = boolInput('comment', false)
  const maxPackages = Number(input('max-packages', '50'))
  if (!Number.isInteger(maxPackages) || maxPackages < 1) throw new Error('Input max-packages must be a positive integer.')

  const client = createClient({
    baseUrl: input('api-url', 'https://api.custoden.com'),
    userAgent: `custoden-action/${pkg.version} (+https://github.com/Custoden/action)`,
    log: (m) => console.log(m),
  })
  const github = createGitHub({
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    token: input('github-token'),
  })

  const { base, head, runs: runsSha, remote } = commits(event, eventName)
  process.env.CUSTODEN_HEAD_SHA = head

  /** @type {Results} */
  const results = { packages: [], workflows: [], files: [], notes: [], cancelled: [] }

  /** @type {string[]} */
  let changed = []
  if (base) {
    try {
      const diff = await github.changedFiles(base, head)
      changed = diff.files
      if (!diff.complete) results.notes.push('The change touches more files than can be listed. Only the first 3,000 were considered.')
    } catch (err) {
      results.notes.push(message(err))
    }
  } else {
    const found = await discover(workspace)
    changed = found.workflows
    if (found.workflows.length === 0 && found.lockfiles.length === 0) {
      results.notes.push('No lockfiles or workflows found in the workspace. Run actions/checkout before this action.')
    } else if (checkPackages && found.lockfiles.length > 0) {
      results.notes.push('Packages and CI files are checked on pull requests, merge queues and pushes, where changes can be found.')
    }
  }

  /** @param {string} path */
  const readHead = async (path) => {
    if (!remote) {
      const local = join(workspace, path)
      if (await access(local).then(() => true, () => false)) return readFile(local, 'utf8')
    }
    const content = await github.fileAt(path, head)
    if (content === null) throw new Error('File not found at the head commit.')
    return content
  }

  /** @type {string | null} */
  let stopped = null
  let unreachable = false
  /** @param {unknown} err */
  const stopOn = (err) => {
    if (!(err instanceof ApiError)) return
    if (err.status === 0 || err.status >= 500) unreachable = true
    if (err.status === 0 || err.status === 429 || err.status >= 500) stopped = err.message
  }

  const workflowPaths = checkWorkflows ? changed.filter(isWorkflow) : []
  const filePaths = checkFiles && base ? changed.filter(isCiFile) : []
  const lockfilePaths = checkPackages && base ? changed.filter(isLockfile) : []
  console.log(
    `Checking ${workflowPaths.length} workflows, ${filePaths.length} CI files and ${lockfilePaths.length} lockfiles${base ? ` changed since ${base.slice(0, 7)}` : ''}.`,
  )

  for (const file of workflowPaths) {
    /** @type {WorkflowResult} */
    const result = { file }
    results.workflows.push(result)
    if (stopped) {
      result.error = stopped
      continue
    }
    try {
      result.report = await client.analyzeWorkflow(await readHead(file))
    } catch (err) {
      result.error = message(err)
      stopOn(err)
    }
  }

  /** @type {Array<{ result: FileResult, content: string }>} */
  const pending = []
  for (const file of filePaths) {
    /** @type {FileResult} */
    const result = { file }
    results.files.push(result)
    try {
      const content = await readHead(file)
      if (content.length > FILES_BATCH_BYTES) result.error = 'File is too large to analyze.'
      else pending.push({ result, content })
    } catch (err) {
      result.error = message(err)
    }
  }
  while (pending.length > 0) {
    /** @type {typeof pending} */
    const batch = []
    let bytes = 0
    while (pending.length > 0 && batch.length < FILES_BATCH_SIZE && bytes + pending[0].content.length <= FILES_BATCH_BYTES) {
      const next = /** @type {(typeof pending)[number]} */ (pending.shift())
      bytes += next.content.length
      batch.push(next)
    }
    if (stopped) {
      for (const b of batch) b.result.error = stopped
      continue
    }
    try {
      const report = await client.analyzeFiles(batch.map((b) => ({ path: b.result.file, content: b.content })))
      for (const b of batch) b.result.findings = report.findings.filter((f) => f.path === b.result.file)
    } catch (err) {
      for (const b of batch) b.result.error = message(err)
      stopOn(err)
    }
  }

  const stopRuns = async () => {
    if (!cancel || results.cancelled.length > 0 || !evaluate(results, failOn).failed) return
    const runId = Number(process.env.GITHUB_RUN_ID)
    try {
      results.cancelled.push(...(await github.cancelRuns(runsSha, runId)))
      await new Promise((r) => setTimeout(r, 10_000))
      const seen = new Set(results.cancelled.map((r) => r.id))
      for (const r of await github.cancelRuns(runsSha, runId)) if (!seen.has(r.id)) results.cancelled.push(r)
      const done = results.cancelled.filter((r) => r.cancelled).length
      console.log(`Cancelled ${done} other ${done === 1 ? 'run' : 'runs'} on ${runsSha.slice(0, 7)}.`)
    } catch (err) {
      console.log(`::warning::${message(err)}`)
    }
  }
  await stopRuns()

  /** @type {Map<string, PackageResult>} */
  const packages = new Map()
  for (const file of lockfilePaths) {
    const parser = /** @type {NonNullable<ReturnType<typeof parserFor>>} */ (parserFor(file))
    try {
      const after = parser.parse(await readHead(file))
      const previous = await github.fileAt(file, /** @type {string} */ (base))
      const before = previous === null ? [] : parser.parse(previous)
      for (const p of changedPackages(before, after)) {
        const key = packageKey(p)
        const existing = packages.get(key)
        if (existing) existing.files.push(file)
        else packages.set(key, { pkg: p, files: [file] })
      }
    } catch (err) {
      results.notes.push(`\`${file}\`: ${message(err)}`)
    }
  }
  results.packages = [...packages.values()]
  for (const r of results.packages.slice(maxPackages)) r.error = `Over the max-packages limit of ${maxPackages}.`
  const toCheck = results.packages.slice(0, maxPackages)

  for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE)
    if (stopped) {
      for (const r of batch) r.error = stopped
      continue
    }
    try {
      const res = await client.checkPackages(batch.map((r) => r.pkg))
      res.forEach((item, j) => {
        if (item.report) batch[j].report = item.report
        else batch[j].error = item.error?.message ?? 'No result.'
      })
    } catch (err) {
      for (const r of batch) r.error = message(err)
      stopOn(err)
    }
  }
  await stopRuns()

  const outcome = evaluate(results, failOn)
  const summary = markdown(results, outcome)

  for (const line of annotations(outcome, failOn)) console.log(line)
  if (outcome.errors > 0) {
    const what = `${outcome.errors} ${outcome.errors === 1 ? 'item was' : 'items were'} not checked`
    const level = failOn.incomplete ? 'error' : 'warning'
    if (unreachable) console.log(`::${level}::Custoden API could not be reached, so ${what}. See the job summary.`)
    else console.log(`::${level}::Custoden: ${what}. See the job summary.`)
  }
  await append(process.env.GITHUB_STEP_SUMMARY ?? '', summary)

  const reportPath = join(process.env.RUNNER_TEMP || workspace, 'custoden-report.json')
  await writeFile(reportPath, JSON.stringify({ base, head, failed: outcome.failed, ...results }, null, 2))

  const output = process.env.GITHUB_OUTPUT ?? ''
  await append(output, `result=${outcome.failed ? 'fail' : 'pass'}`)
  await append(output, `packages-checked=${results.packages.filter((r) => r.report).length}`)
  await append(output, `workflows-checked=${results.workflows.filter((r) => r.report).length}`)
  await append(output, `files-checked=${results.files.filter((r) => r.findings).length}`)
  await append(output, `findings=${outcome.flaggedPackages.length + outcome.findings.length}`)
  await append(output, `cancelled-runs=${results.cancelled.filter((r) => r.cancelled).length}`)
  await append(output, `report=${reportPath}`)

  const prNumber = event.pull_request?.number
  if (comment && typeof prNumber === 'number') {
    const flagged = outcome.flaggedPackages.length + outcome.findings.length + outcome.errors
    try {
      await github.upsertComment(prNumber, commentBody(summary), { createIfMissing: flagged > 0 })
    } catch (err) {
      console.log(`::warning::${message(err)}`)
    }
  }

  if (outcome.failed) {
    const parts = []
    if (outcome.failingPackages.length) parts.push(`${outcome.failingPackages.length} ${outcome.failingPackages.length === 1 ? 'package is' : 'packages are'} ${failOn.packages} or worse`)
    if (outcome.failingFindings.length) parts.push(`${outcome.failingFindings.length} ${outcome.failingFindings.length === 1 ? 'finding is' : 'findings are'} ${failOn.workflows} or higher`)
    if (failOn.incomplete && outcome.errors) parts.push(`${outcome.errors} ${outcome.errors === 1 ? 'item' : 'items'} could not be checked`)
    console.log(`::error::Custoden: ${parts.join(', ')}.`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.log(`::error::Custoden: ${message(err)}`)
  process.exitCode = 1
})
