export const COMMENT_MARKER = '<!-- custoden-action -->'

/**
 * @typedef {object} GitHubOptions
 * @property {string} apiUrl
 * @property {string} repository owner/name
 * @property {string} token
 * @property {typeof fetch} [fetch]
 */

/** @param {GitHubOptions} options */
export function createGitHub(options) {
  const doFetch = options.fetch ?? fetch
  const api = options.apiUrl.replace(/\/+$/, '')

  /**
   * @param {string} path
   * @param {RequestInit & { accept?: string }} [init]
   */
  async function call(path, init = {}) {
    const { accept, ...rest } = init
    return doFetch(`${api}${path}`, {
      ...rest,
      headers: {
        accept: accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'custoden-action',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(60_000),
    })
  }

  return {
    /**
     * Files changed between two commits, excluding removed files.
     * @param {string} base
     * @param {string} head
     * @returns {Promise<{ files: string[], complete: boolean }>}
     */
    async changedFiles(base, head) {
      /** @type {string[]} */
      const files = []
      for (let page = 1; page <= 30; page++) {
        const res = await call(`/repos/${options.repository}/compare/${base}...${head}?per_page=100&page=${page}`)
        if (!res.ok) throw new Error(`Could not compare ${base.slice(0, 7)}...${head.slice(0, 7)} (HTTP ${res.status}). The token needs contents: read.`)
        const body = /** @type {any} */ (await res.json())
        /** @type {Array<{ filename: string, status: string }>} */
        const list = body.files ?? []
        for (const f of list) if (f.status !== 'removed') files.push(f.filename)
        if (list.length < 100) return { files, complete: true }
      }
      return { files, complete: false }
    },

    /**
     * Cancel other runs for a commit that have not finished.
     * @param {string} sha
     * @param {number} exceptRunId
     * @returns {Promise<Array<{ id: number, name: string, url: string, cancelled: boolean }>>}
     */
    async cancelRuns(sha, exceptRunId) {
      const res = await call(`/repos/${options.repository}/actions/runs?head_sha=${sha}&per_page=100`)
      if (!res.ok) throw new Error(`Could not list workflow runs (HTTP ${res.status}). The token needs actions: write.`)
      const body = /** @type {any} */ (await res.json())
      /** @type {Array<{ id: number, name: string, event: string, html_url: string, status: string }>} */
      const runs = body.workflow_runs ?? []
      const active = runs.filter((r) => r.id !== exceptRunId && r.status !== 'completed')
      const results = await Promise.all(
        active.map(async (r) => {
          const base = `/repos/${options.repository}/actions/runs/${r.id}`
          let ok = (await call(`${base}/cancel`, { method: 'POST' })).status === 202
          if (!ok) {
            const current = await call(base)
            const run = current.ok ? /** @type {any} */ (await current.json()) : null
            if (run?.status === 'completed') return null
            ok = (await call(`${base}/force-cancel`, { method: 'POST' })).status === 202
          }
          return { id: r.id, name: `${r.name} (${r.event})`, url: r.html_url, cancelled: ok }
        }),
      )
      return results.filter((r) => r !== null)
    },

    /**
     * File content at a commit, or null when the file does not exist there.
     * @param {string} path
     * @param {string} ref
     * @returns {Promise<string | null>}
     */
    async fileAt(path, ref) {
      const encoded = path.split('/').map(encodeURIComponent).join('/')
      const res = await call(`/repos/${options.repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
        accept: 'application/vnd.github.raw+json',
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`Could not read ${path} at ${ref.slice(0, 7)} (HTTP ${res.status}). The token needs contents: read.`)
      return res.text()
    },

    /**
     * Create or update this action's comment on a pull request.
     * @param {number} number
     * @param {string} body Must contain COMMENT_MARKER.
     * @param {{ createIfMissing: boolean }} mode
     */
    async upsertComment(number, body, mode) {
      const list = await call(`/repos/${options.repository}/issues/${number}/comments?per_page=100`)
      if (!list.ok) throw new Error(`Could not list pull request comments (HTTP ${list.status}).`)
      /** @type {{ id: number, body?: string }[]} */
      const comments = /** @type {any} */ (await list.json())
      const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER))
      if (!existing && !mode.createIfMissing) return
      const res = existing
        ? await call(`/repos/${options.repository}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
        : await call(`/repos/${options.repository}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
      if (!res.ok) throw new Error(`Could not write the pull request comment (HTTP ${res.status}). The token needs pull-requests: write.`)
    },
  }
}
