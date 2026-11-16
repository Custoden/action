import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parserFor } from './lockfiles.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'vendor', '.tox', '.next', 'coverage'])
const MAX_DEPTH = 8

/**
 * Lockfiles and workflow files in the workspace, as repository-relative paths with forward slashes.
 * @param {string} root
 * @returns {Promise<{ lockfiles: string[], workflows: string[] }>}
 */
export async function discover(root) {
  /** @type {string[]} */
  const lockfiles = []
  /** @type {string[]} */
  const workflows = []
  const toRepoPath = (/** @type {string} */ abs) => relative(root, abs).split(sep).join('/')

  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) await walk(abs, depth + 1)
      } else if (entry.isFile() && parserFor(entry.name)) {
        lockfiles.push(toRepoPath(abs))
      }
    }
  }

  await walk(root, 0)
  const wfDir = join(root, '.github', 'workflows')
  for (const entry of await readdir(wfDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) workflows.push(toRepoPath(join(wfDir, entry.name)))
  }
  return { lockfiles: lockfiles.sort(), workflows: workflows.sort() }
}
