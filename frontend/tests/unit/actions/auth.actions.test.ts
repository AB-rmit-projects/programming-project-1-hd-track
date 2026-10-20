import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecodedIdToken } from 'firebase-admin/auth'
import { adminAuth } from '@/lib/firebase/admin'
import { getServerSession, requireAuth } from '@/actions/auth.actions'

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === '__session' && cookieValue.current ? { value: cookieValue.current } : undefined,
  }),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

function decodedToken(claims: Partial<DecodedIdToken>): DecodedIdToken {
  return { uid: 'alice-uid', email: 'alice@example.com', ...claims } as DecodedIdToken
}

const verifySessionCookie = vi.mocked(adminAuth.verifySessionCookie)

beforeEach(() => {
  cookieValue.current = 'session-cookie'
  verifySessionCookie.mockReset()
})

describe('getServerSession', () => {
  it('returns the decoded session for a verified email', async () => {
    verifySessionCookie.mockResolvedValue(decodedToken({ email_verified: true }))
    await expect(getServerSession()).resolves.toMatchObject({ uid: 'alice-uid' })
    expect(verifySessionCookie).toHaveBeenCalledWith('session-cookie', true)
  })

  it('treats an unverified email as signed out', async () => {
    verifySessionCookie.mockResolvedValue(decodedToken({ email_verified: false }))
    await expect(getServerSession()).resolves.toBeNull()
  })

  it('treats a session without the email_verified claim as signed out', async () => {
    verifySessionCookie.mockResolvedValue(decodedToken({}))
    await expect(getServerSession()).resolves.toBeNull()
  })

  it('returns null when there is no session cookie', async () => {
    cookieValue.current = undefined
    await expect(getServerSession()).resolves.toBeNull()
    expect(verifySessionCookie).not.toHaveBeenCalled()
  })

  it('returns null when the cookie fails verification', async () => {
    verifySessionCookie.mockRejectedValue(new Error('auth/session-cookie-revoked'))
    await expect(getServerSession()).resolves.toBeNull()
  })
})

describe('requireAuth', () => {
  it('redirects an unverified session to sign-in', async () => {
    verifySessionCookie.mockResolvedValue(decodedToken({ email_verified: false }))
    await expect(requireAuth()).rejects.toThrow('NEXT_REDIRECT:/auth/signin')
  })

  it('returns the session for a verified user', async () => {
    verifySessionCookie.mockResolvedValue(decodedToken({ email_verified: true }))
    await expect(requireAuth()).resolves.toMatchObject({ uid: 'alice-uid' })
  })
})
