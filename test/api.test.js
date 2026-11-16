import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError, createClient } from '../src/api.js'

/**
 * @param {Array<{ status: number, body: unknown, headers?: Record<string, string> }>} responses
 */
function fakeFetch(responses) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = []
  const fn = /** @type {typeof fetch} */ (
    async (url, init) => {
      calls.push({ url: String(url), init: /** @type {RequestInit} */ (init) })
      const next = responses.shift()
      if (!next) throw new Error('no more responses')
      return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers })
    }
  )
  return { fn, calls }
}

const pkg = /** @type {const} */ ({ ecosystem: 'npm', name: 'lodash', version: '4.17.21' })

describe('API client', () => {
  it('posts batches and returns results', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { results: [{ input: pkg, report: { verdict: 'ok' } }] } }])
    const client = createClient({ baseUrl: 'https://api.example.test/', userAgent: 'test', fetch: fn })
    const results = await client.checkPackages([pkg])
    assert.equal(results[0].report?.verdict, 'ok')
    assert.equal(calls[0].url, 'https://api.example.test/v1/packages/check')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { packages: [pkg] })
  })

  it('waits out a short rate limit and retries', async () => {
    const { fn } = fakeFetch([
      { status: 429, body: { error: { code: 'rate_limited', message: 'Rate limit exceeded.' } }, headers: { 'retry-after': '30' } },
      { status: 200, body: { summary: { total: 0 }, findings: [] } },
    ])
    /** @type {number[]} */
    const waits = []
    const client = createClient({ baseUrl: 'https://x', userAgent: 'test', fetch: fn, sleep: async (s) => void waits.push(s) })
    const report = await client.analyzeWorkflow('on: push')
    assert.equal(report.summary.total, 0)
    assert.deepEqual(waits, [30])
  })

  it('gives up on a long rate limit with the API error code', async () => {
    const { fn } = fakeFetch([
      { status: 429, body: { error: { code: 'rate_limited', message: 'Rate limit exceeded (100 requests per day).' } }, headers: { 'retry-after': '40000' } },
    ])
    const client = createClient({ baseUrl: 'https://x', userAgent: 'test', fetch: fn, sleep: async () => {} })
    await assert.rejects(client.checkPackages([pkg]), (err) => err instanceof ApiError && err.code === 'rate_limited' && err.status === 429)
  })

  it('does not retry client errors', async () => {
    const { fn, calls } = fakeFetch([{ status: 400, body: { error: { code: 'invalid_request', message: 'Bad.' } } }])
    const client = createClient({ baseUrl: 'https://x', userAgent: 'test', fetch: fn, sleep: async () => {} })
    await assert.rejects(client.checkPackages([pkg]), /Bad\./)
    assert.equal(calls.length, 1)
  })
})
