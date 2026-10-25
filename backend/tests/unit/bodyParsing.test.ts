import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import request from 'supertest'
import { createApp } from '../../src/app'
import { mockUser, mockVerifyToken } from '../setup'

// Request-body parsing on both express lines, run in a child process (so a
// request that crashed it couldn't take the test runner down too).
//
// GHSA-27r3-jxmh-p828: body-parser < 1.20.9 and 2.0.0–2.3.x can leave a
// decompression stream piped with no error listener, so a crafted compressed
// body crashes the process. The guard here is the resolved-version check: the
// crash itself couldn't be reproduced locally (Node 22 and 24), so a "survives
// the payload" test would pass on the vulnerable versions too.

const SERVER = path.resolve(__dirname, '../fixtures/body-parsing-server.cjs')
const localRequire = createRequire(__filename)

/** The express our app uses (5.x), and the one firebase-functions bundles (4.x). */
const EXPRESS_LINES = [
  ['express 5 (app)', localRequire.resolve('express'), '2.4.0'],
  [
    'express 4 (firebase-functions)',
    createRequire(localRequire.resolve('firebase-functions')).resolve('express'),
    '1.20.9',
  ],
] as const

interface Reply {
  status: number
  body: string
}

function send(
  port: number,
  method: string,
  urlPath: string,
  body?: Buffer,
  headers: Record<string, string> = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value))
const JSON_HEADERS = { 'content-type': 'application/json' }
const GZIP_JSON_HEADERS = { ...JSON_HEADERS, 'content-encoding': 'gzip' }

/** True when a semver string is at least `minimum` (both plain x.y.z). */
function atLeast(version: string, minimum: string): boolean {
  const [a, b] = [version, minimum].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) {
    const diff = (a?.[i] ?? 0) - (b?.[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return true
}

describe.each(EXPRESS_LINES)('%s body parsing', (_label, expressPath, patched) => {
  let child: ChildProcess
  let port: number
  let exited: number | null = null

  beforeAll(async () => {
    child = fork(SERVER, [expressPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.on('exit', (code) => {
      exited = code ?? -1
    })
    port = await new Promise<number>((resolve, reject) => {
      child.once('message', (message) => resolve((message as { port: number }).port))
      child.once('error', reject)
    })
  })

  afterAll(() => {
    child.kill()
  })

  it(`resolves body-parser ${patched} or later`, () => {
    const bodyParser = createRequire(expressPath)('body-parser/package.json') as { version: string }
    expect(atLeast(bodyParser.version, patched)).toBe(true)
  })

  it('parses JSON, gzip-compressed JSON and form bodies', async () => {
    const plain = await send(port, 'POST', '/echo', json({ a: 1 }), JSON_HEADERS)
    expect(plain).toEqual({ status: 200, body: '{"body":{"a":1}}' })

    const gzipped = await send(port, 'POST', '/echo', gzipSync(json({ a: 1 })), GZIP_JSON_HEADERS)
    expect(gzipped).toEqual({ status: 200, body: '{"body":{"a":1}}' })

    const form = await send(port, 'POST', '/echo', Buffer.from('a=1&b[c]=2'), {
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(form).toEqual({ status: 200, body: '{"body":{"a":"1","b":{"c":"2"}}}' })
  })

  it.each([
    ['malformed JSON', Buffer.from('{"a":'), JSON_HEADERS, 400],
    ['a body over the 1mb limit', json({ a: 'x'.repeat(1024 * 1024) }), JSON_HEADERS, 413],
    [
      'an unsupported content encoding',
      json({ a: 1 }),
      { ...JSON_HEADERS, 'content-encoding': 'br2' },
      415,
    ],
  ] as const)('rejects %s', async (_case, body, headers, status) => {
    expect((await send(port, 'POST', '/echo', body, headers)).status).toBe(status)
  })

  it('is still running after every request above', async () => {
    expect(exited).toBeNull()
    expect(await send(port, 'GET', '/alive')).toEqual({ status: 200, body: '{"alive":true}' })
  })
})

describe('createApp body parsing', () => {
  const app = createApp({ verifyToken: mockVerifyToken })

  it('parses plain and gzip-compressed JSON before routing', async () => {
    vi.mocked(mockVerifyToken).mockResolvedValue(mockUser)
    // Raw requests over loopback: supertest re-encodes Buffer bodies, so it
    // can't send gzip bytes as they are.
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const auth = { authorization: 'Bearer token' }
    try {
      // No route takes a body yet, so a parsed body reaches the 404 handler.
      const plain = await send(port, 'POST', '/api/no-such-route', json({ a: 1 }), {
        ...JSON_HEADERS,
        ...auth,
      })
      expect(plain.status).toBe(404)

      const gzipped = await send(port, 'POST', '/api/no-such-route', gzipSync(json({ a: 1 })), {
        ...GZIP_JSON_HEADERS,
        ...auth,
      })
      expect(gzipped.status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('rejects malformed JSON before auth or routing', async () => {
    // errorHandler renders any error that isn't an HttpError, including
    // body-parser's own 400, as a generic 500 (existing behaviour).
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await request(app)
        .post('/api/no-such-route')
        .set('Content-Type', 'application/json')
        .send('{"a":')
      expect(res.status).toBe(500)
    } finally {
      consoleError.mockRestore()
    }
  })
})
