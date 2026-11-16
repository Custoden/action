import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError, BATCH_SIZE, createClient } from './api.js'
import { discover } from './files.js'
import { createGitHub } from './github.js'
import { changedPackages, packageKey, parserFor } from './lockfiles.js'
import { annotations, commentBody, evaluate, markdown } from './report.js'

/**
 * @typedef {import('./lockfiles.js').Package} Package
 * @typedef {import('./report.js').PackageResult} PackageResult
 * @typedef {import('./report.js').WorkflowResult} WorkflowResult
 * @typedef {import('./report.js').FailOn} FailOn
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

/** @param {any} event @param {string} name */
function baseCommit(event, name) {
  if (name === 'pull_request' || name === 'pull_request_target') return event.pull_request?.base?.sha ?? null
  if (name === 'merge_group') return event.merge_group?.base_sha ?? null
  if (name === 'push' && typeof event.before === 'string' && !/^0+$/.test(event.before)) return event.before
  return null
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

  const base = baseCommit(event, eventName)
  if (eventName === 'pull_request_target') {
    console.log('::warning::On pull_request_target the workspace holds whatever you checked out. Make sure it is the pull request head if you want its changes checked.')
  }

  const found = await discover(workspace)
  /** @type {string[]} */
  const notes = []
  if (found.lockfiles.length === 0 && found.workflows.length === 0) {
    notes.push('No lockfiles or workflows found in the workspace. Run actions/checkout before this action.')
  }

  /** @type {Map<string, PackageResult>} */
  const packages = new Map()
  if (checkPackages && found.lockfiles.length > 0) {
    if (!base) {
      notes.push('Packages are checked on pull requests, merge queues and pushes, where new and changed versions can be found.')
    } else {
      for (const file of found.lockfiles) {
        const parser = /** @type {NonNullable<ReturnType<typeof parserFor>>} */ (parserFor(file))
        try {
          const after = parser.parse(await readFile(join(workspace, file), 'utf8'))
          const previous = await github.fileAt(file, base)
          const before = previous === null ? [] : parser.parse(previous)
          for (const p of changedPackages(before, after)) {
            const key = packageKey(p)
            const existing = packages.get(key)
            if (existing) existing.files.push(file)
            else packages.set(key, { pkg: p, files: [file] })
          }
        } catch (err) {
          notes.push(`\`${file}\`: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  /** @type {WorkflowResult[]} */
  const workflows = []
  /** @type {Map<string, string>} */
  const workflowSources = new Map()
  if (checkWorkflows) {
    for (const file of found.workflows) {
      const source = await readFile(join(workspace, file), 'utf8')
      if (base) {
        const previous = await github.fileAt(file, base).catch((err) => {
          notes.push(err instanceof Error ? err.message : String(err))
          return null
        })
        if (previous === source) continue
      }
      workflowSources.set(file, source)
      workflows.push({ file })
    }
  }

  const queue = [...packages.values()]
  if (queue.length > maxPackages) {
    for (const r of queue.slice(maxPackages)) r.error = `Over the max-packages limit of ${maxPackages}.`
  }
  const toCheck = queue.slice(0, maxPackages)
  console.log(`Checking ${toCheck.length} new or changed ${toCheck.length === 1 ? 'package' : 'packages'} and ${workflows.length} ${workflows.length === 1 ? 'workflow' : 'workflows'}${base ? ` against ${base.slice(0, 7)}` : ''}.`)

  /** @type {string | null} */
  let stopped = null
  let unreachable = false
  /** @param {unknown} err */
  const stopOn = (err) => {
    if (!(err instanceof ApiError)) return
    if (err.status === 0 || err.status >= 500) unreachable = true
    if (err.status === 0 || err.status === 429 || err.status >= 500) stopped = err.message
  }
  for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE)
    if (stopped) {
      for (const r of batch) r.error = stopped
      continue
    }
    try {
      const results = await client.checkPackages(batch.map((r) => r.pkg))
      results.forEach((res, j) => {
        if (res.report) batch[j].report = res.report
        else batch[j].error = res.error?.message ?? 'No result.'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      for (const r of batch) r.error = message
      stopOn(err)
    }
  }

  for (const w of workflows) {
    if (stopped) {
      w.error = stopped
      continue
    }
    try {
      w.report = await client.analyzeWorkflow(/** @type {string} */ (workflowSources.get(w.file)))
    } catch (err) {
      w.error = err instanceof Error ? err.message : String(err)
      stopOn(err)
    }
  }

  const results = { packages: queue, workflows, notes }
  const outcome = evaluate(results, failOn)
  const summary = markdown(results, outcome)

  for (const line of annotations(outcome, failOn)) console.log(line)
  if (outcome.errors > 0) {
    const what = `${outcome.errors} ${outcome.errors === 1 ? 'item was' : 'items were'} not checked`
    const level = failOn.incomplete ? 'error' : 'warning'
    if (unreachable) console.log(`::${level}::Custoden API could not be reached, so ${what}. See the job summary.`)
    else console.log(`::${level}::Custoden: ${what}. See the job summary.`)
  }
  for (const r of outcome.flaggedPackages) {
    console.log(`${r.report?.verdict.padEnd(10)} ${r.pkg.ecosystem}:${r.pkg.name}@${r.pkg.version}`)
  }
  await append(process.env.GITHUB_STEP_SUMMARY ?? '', summary)

  const reportPath = join(process.env.RUNNER_TEMP || workspace, 'custoden-report.json')
  await writeFile(reportPath, JSON.stringify({ base, failed: outcome.failed, ...results }, null, 2))

  const output = process.env.GITHUB_OUTPUT ?? ''
  await append(output, `result=${outcome.failed ? 'fail' : 'pass'}`)
  await append(output, `packages-checked=${queue.filter((r) => r.report).length}`)
  await append(output, `workflows-checked=${workflows.filter((r) => r.report).length}`)
  await append(output, `findings=${outcome.flaggedPackages.length + outcome.workflowFindings.length}`)
  await append(output, `report=${reportPath}`)

  const prNumber = event.pull_request?.number
  if (comment && typeof prNumber === 'number') {
    const flagged = outcome.flaggedPackages.length + outcome.workflowFindings.length + outcome.errors
    try {
      await github.upsertComment(prNumber, commentBody(summary), { createIfMissing: flagged > 0 })
    } catch (err) {
      console.log(`::warning::${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (outcome.failed) {
    const parts = []
    if (outcome.failingPackages.length) parts.push(`${outcome.failingPackages.length} ${outcome.failingPackages.length === 1 ? 'package is' : 'packages are'} ${failOn.packages} or worse`)
    if (outcome.failingFindings.length) parts.push(`${outcome.failingFindings.length} workflow ${outcome.failingFindings.length === 1 ? 'finding is' : 'findings are'} ${failOn.workflows} or higher`)
    if (failOn.incomplete && outcome.errors) parts.push(`${outcome.errors} ${outcome.errors === 1 ? 'item' : 'items'} could not be checked`)
    console.log(`::error::Custoden: ${parts.join(', ')}.`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.log(`::error::Custoden: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
