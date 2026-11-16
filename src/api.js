/**
 * @typedef {import('./lockfiles.js').Package} Package
 * @typedef {'critical' | 'high' | 'medium' | 'low' | 'info'} Severity
 * @typedef {{ id: string, severity: Severity, title: string, detail: string, references?: string[] }} PackageFinding
 * @typedef {{ id: string, summary: string, severity: string, fixed_in: string[], url: string }} Vulnerability
 * @typedef {{ name: string, version: string, verdict: 'malicious' | 'suspicious' | 'review' | 'ok', risk: Severity | 'none', findings: PackageFinding[], vulnerabilities: Vulnerability[] }} PackageReport
 * @typedef {{ rule: string, severity: Severity, title: string, detail: string, remediation: string, location: { line: number, column: number, job: string | null, step: string | null } }} WorkflowFinding
 * @typedef {{ summary: Record<Severity, number> & { total: number }, findings: WorkflowFinding[] }} WorkflowReport
 * @typedef {{ input: Package, report?: PackageReport, error?: { code: string, message: string } }} BatchResult
 */

export const BATCH_SIZE = 10

export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * @typedef {object} ClientOptions
 * @property {string} baseUrl
 * @property {string} userAgent
 * @property {number} [maxWaitSeconds] Longest single wait for a rate limit or retry before giving up.
 * @property {typeof fetch} [fetch]
 * @property {(seconds: number) => Promise<void>} [sleep]
 * @property {(message: string) => void} [log]
 */

/** @param {ClientOptions} options */
export function createClient(options) {
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)))
  const log = options.log ?? (() => {})
  const maxWait = options.maxWaitSeconds ?? 65
  const base = options.baseUrl.replace(/\/+$/, '')

  /**
   * @param {string} path
   * @param {RequestInit} init
   * @returns {Promise<any>}
   */
  async function request(path, init) {
    for (let attempt = 1; ; attempt++) {
      /** @type {Response} */
      let res
      try {
        res = await doFetch(`${base}${path}`, {
          ...init,
          headers: { 'user-agent': options.userAgent, ...init.headers },
          signal: AbortSignal.timeout(120_000),
        })
      } catch (err) {
        if (attempt < 3) {
          log(`Request failed (${err instanceof Error ? err.message : err}). Retrying.`)
          await sleep(5 * attempt)
          continue
        }
        throw new ApiError('network_error', 'Could not reach the Custoden API.', 0)
      }

      /** @type {any} */
      const body = await res.json().catch(() => null)
      if (res.ok) return body

      const error = body?.error ?? {}
      const retryAfter = Number(res.headers.get('retry-after') ?? error.details?.retry_after ?? NaN)
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = Number.isFinite(retryAfter) ? retryAfter : 5 * attempt
        if (wait <= maxWait) {
          log(`${error.message ?? `HTTP ${res.status}`} Waiting ${wait} seconds.`)
          await sleep(wait)
          continue
        }
      }
      throw new ApiError(error.code ?? `http_${res.status}`, error.message ?? `HTTP ${res.status}`, res.status)
    }
  }

  return {
    /**
     * @param {Package[]} packages At most BATCH_SIZE packages.
     * @returns {Promise<BatchResult[]>}
     */
    async checkPackages(packages) {
      const body = await request('/v1/packages/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packages }),
      })
      return body.results
    },

    /**
     * @param {string} source Workflow YAML.
     * @returns {Promise<WorkflowReport>}
     */
    async analyzeWorkflow(source) {
      return request('/v1/github/workflows/analyze', {
        method: 'POST',
        headers: { 'content-type': 'text/yaml' },
        body: source,
      })
    },
  }
}
