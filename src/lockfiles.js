/**
 * @typedef {'npm' | 'pypi'} Ecosystem
 * @typedef {{ ecosystem: Ecosystem, name: string, version: string }} Package
 * @typedef {(source: string) => Package[]} Parser
 */

const VERSION = /^\d+(\.\d+)*([.+-]?[0-9A-Za-z.+-]*)?$/
const NON_REGISTRY = /^(git\+|git:|github:|file:|link:|workspace:|portal:|patch:|https?:\/\/(?!registry\.))/

/** @type {Record<string, { ecosystem: Ecosystem, parse: Parser }>} */
export const lockfiles = {
  'package-lock.json': { ecosystem: 'npm', parse: parseNpmLock },
  'npm-shrinkwrap.json': { ecosystem: 'npm', parse: parseNpmLock },
  'pnpm-lock.yaml': { ecosystem: 'npm', parse: parsePnpmLock },
  'yarn.lock': { ecosystem: 'npm', parse: parseYarnLock },
  'poetry.lock': { ecosystem: 'pypi', parse: parseTomlLock },
  'uv.lock': { ecosystem: 'pypi', parse: parseTomlLock },
  'Pipfile.lock': { ecosystem: 'pypi', parse: parsePipfileLock },
}

/** @param {string} file */
export function parserFor(file) {
  const base = file.slice(file.lastIndexOf('/') + 1)
  if (lockfiles[base]) return lockfiles[base]
  if (/^requirements.*\.txt$/.test(base)) return { ecosystem: /** @type {Ecosystem} */ ('pypi'), parse: parseRequirements }
  return undefined
}

/** @param {Package} p */
export const packageKey = (p) => `${p.ecosystem}:${p.name.toLowerCase()}@${p.version}`

/**
 * Packages in `after` that are new or at a different version than in `before`.
 * @param {Package[]} before
 * @param {Package[]} after
 */
export function changedPackages(before, after) {
  const seen = new Set(before.map(packageKey))
  /** @type {Map<string, Package>} */
  const changed = new Map()
  for (const p of after) {
    const key = packageKey(p)
    if (!seen.has(key)) changed.set(key, p)
  }
  return [...changed.values()]
}

/** @type {Parser} */
export function parseNpmLock(source) {
  const lock = JSON.parse(source)
  /** @type {Package[]} */
  const out = []
  const add = (/** @type {string} */ name, /** @type {unknown} */ version, /** @type {unknown} */ resolved) => {
    if (typeof version !== 'string' || !VERSION.test(version)) return
    if (typeof resolved === 'string' && NON_REGISTRY.test(resolved)) return
    out.push({ ecosystem: 'npm', name, version })
  }

  if (lock.packages && typeof lock.packages === 'object') {
    for (const [path, meta] of Object.entries(lock.packages)) {
      if (!path || !meta || typeof meta !== 'object' || meta.link) continue
      const at = path.lastIndexOf('node_modules/')
      if (at === -1) continue
      add(meta.name ?? path.slice(at + 'node_modules/'.length), meta.version, meta.resolved)
    }
    return out
  }

  /** @param {Record<string, any> | undefined} deps */
  const walk = (deps) => {
    for (const [name, meta] of Object.entries(deps ?? {})) {
      if (!meta || typeof meta !== 'object') continue
      add(name, meta.version, meta.resolved)
      walk(meta.dependencies)
    }
  }
  walk(lock.dependencies)
  return out
}

/** @type {Parser} */
export function parsePnpmLock(source) {
  /** @type {Package[]} */
  const out = []
  let inPackages = false
  for (const line of source.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^(packages|snapshots):\s*$/.test(line)
      continue
    }
    if (!inPackages) continue
    const m = /^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^/@\s('"]+)[@/](\d[^:('"\s]*)/.exec(line)
    if (m && VERSION.test(m[2])) out.push({ ecosystem: 'npm', name: m[1], version: m[2] })
  }
  return out
}

/** @type {Parser} */
export function parseYarnLock(source) {
  /** @type {Package[]} */
  const out = []
  /** @type {string | null} */
  let name = null
  for (const line of source.split(/\r?\n/)) {
    if (/^\S/.test(line) && line.trimEnd().endsWith(':') && !line.startsWith('#')) {
      const spec = line.slice(0, -1).split(',')[0].trim().replace(/^"|"$/g, '')
      const at = spec.indexOf('@', 1)
      const range = at === -1 ? '' : spec.slice(at + 1)
      const nonRegistry = NON_REGISTRY.test(range) || (range.includes(':') && !range.startsWith('npm:'))
      name = at === -1 || spec.startsWith('__') || nonRegistry ? null : spec.slice(0, at)
      continue
    }
    if (!name) continue
    const m = /^ {2}version:? "?([^"\s]+)"?/.exec(line)
    if (m) {
      if (VERSION.test(m[1])) out.push({ ecosystem: 'npm', name, version: m[1] })
      name = null
    }
  }
  return out
}

/** poetry.lock and uv.lock: `[[package]]` tables with `name` and `version`. @type {Parser} */
export function parseTomlLock(source) {
  /** @type {Package[]} */
  const out = []
  for (const block of source.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const table = block.split(/^\[(?!package\.source\])/m)[0]
    const name = /^name\s*=\s*"([^"]+)"/m.exec(table)?.[1]
    const version = /^version\s*=\s*"([^"]+)"/m.exec(table)?.[1]
    if (!name || !version || !VERSION.test(version)) continue
    const inlineSource = /^source\s*=\s*\{([^}]*)\}/m.exec(table)?.[1]
    if (inlineSource && !/\bregistry\s*=/.test(inlineSource)) continue
    const sourceType = /^\[package\.source\][^[]*?^type\s*=\s*"([^"]+)"/ms.exec(block)?.[1]
    if (sourceType && sourceType !== 'legacy') continue
    out.push({ ecosystem: 'pypi', name, version })
  }
  return out
}

/** @type {Parser} */
export function parsePipfileLock(source) {
  const lock = JSON.parse(source)
  /** @type {Package[]} */
  const out = []
  for (const section of ['default', 'develop']) {
    for (const [name, meta] of Object.entries(lock[section] ?? {})) {
      const version = typeof meta?.version === 'string' ? meta.version.replace(/^==/, '') : ''
      if (VERSION.test(version)) out.push({ ecosystem: 'pypi', name, version })
    }
  }
  return out
}

/** Only exact `name==version` pins. @type {Parser} */
export function parseRequirements(source) {
  /** @type {Package[]} */
  const out = []
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*===?\s*([^\s;\\]+)/.exec(line)
    if (m && VERSION.test(m[3])) out.push({ ecosystem: 'pypi', name: m[1], version: m[3] })
  }
  return out
}
