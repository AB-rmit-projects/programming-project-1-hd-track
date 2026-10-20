// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DecodedIdToken } from 'firebase-admin/auth'
import { adminAuth } from '@/lib/firebase/admin'
import { DELETE, POST } from '@/app/api/auth/session/route'

const cookieStore = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))

const verifyIdToken = vi.mocked(adminAuth.verifyIdToken)
const createSessionCookie = vi.mocked(adminAuth.createSessionCookie)
const TOKEN = 'secret-id-token-value'

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

function decoded(claims: Partial<DecodedIdToken>): DecodedIdToken {
  return { uid: 'alice-uid', ...claims } as DecodedIdToken
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('POST /api/auth/session', () => {
  it('creates a session cookie for a valid token from a verified account', async () => {
    verifyIdToken.mockResolvedValue(decoded({ email_verified: true }))
    createSessionCookie.mockResolvedValue('session-cookie-value')

    const res = await post({ token: TOKEN })

    expect(res.status).toBe(200)
    expect(verifyIdToken).toHaveBeenCalledWith(TOKEN, true) // checkRevoked
    expect(createSessionCookie).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ expiresIn: expect.any(Number) }))
    expect(cookieStore.set).toHaveBeenCalledWith(
      '__session',
      'session-cookie-value',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' })
    )
  })

  it('refuses an unverified account with 403 and sets no cookie', async () => {
    verifyIdToken.mockResolvedValue(decoded({ email_verified: false }))

    const res = await post({ token: TOKEN })

    expect(res.status).toBe(403)
    expect(createSessionCookie).not.toHaveBeenCalled()
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it('refuses a token with no email_verified claim', async () => {
    verifyIdToken.mockResolvedValue(decoded({}))
    expect((await post({ token: TOKEN })).status).toBe(403)
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it('refuses an invalid, expired or revoked token with 401 and sets no cookie', async () => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error(`bad token ${TOKEN}`), { code: 'auth/id-token-revoked' }))

    const res = await post({ token: TOKEN })

    expect(res.status).toBe(401)
    expect(createSessionCookie).not.toHaveBeenCalled()
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it('logs only the error code, never the token', async () => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error(`bad token ${TOKEN}`), { code: 'auth/argument-error' }))
    await post({ token: TOKEN })
    expect(console.error).toHaveBeenCalledWith('Session creation failed:', 'auth/argument-error')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(TOKEN)
  })

  it('returns 401 if session-cookie creation itself fails', async () => {
    verifyIdToken.mockResolvedValue(decoded({ email_verified: true }))
    createSessionCookie.mockRejectedValue(new Error('backend unavailable'))
    expect((await post({ token: TOKEN })).status).toBe(401)
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it.each([[{}], [{ token: '' }], [{ token: 42 }]])('returns 400 for a missing or non-string token %j', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(verifyIdToken).not.toHaveBeenCalled()
  })

  it('returns 401 for a malformed body', async () => {
    expect((await post('not json')).status).toBe(401)
    expect(cookieStore.set).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/auth/session', () => {
  it('clears the session cookie', async () => {
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(cookieStore.delete).toHaveBeenCalledWith('__session')
  })
})
