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
