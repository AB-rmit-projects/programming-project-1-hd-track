import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'
import { AuthProvider, useAuthContext } from '@/providers/AuthProvider'
import * as fbAuth from '@/lib/firebase/auth'
import { toast } from 'sonner'
import { getDoc } from 'firebase/firestore'
import type { AuthContextValue } from '@/types/auth'

// ── Mocks: Firebase never runs; we drive onAuthStateChanged by hand ─────────

const listener = vi.hoisted(() => ({ emit: (_user: unknown) => {} }))
const clientAuth = vi.hoisted(() => ({ currentUser: null as unknown }))

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, callback: (user: unknown) => void) => {
    listener.emit = callback
    return () => undefined
  },
}))
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => clientAuth, getClientDb: () => ({}) }))
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  serverTimestamp: vi.fn(),
}))
vi.mock('@/lib/firebase/auth', () => ({
  signInWithEmail: vi.fn(),
  signUpWithEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const fetchMock = vi.fn()

function firebaseUser(emailVerified: boolean): User {
  return {
    uid: 'alice-uid',
    email: 'alice@example.com',
    displayName: 'Alice',
    photoURL: null,
    emailVerified,
    getIdToken: vi.fn().mockResolvedValue('id-token'),
  } as unknown as User
}

const okResponse = (status = 200) => ({ ok: status < 400, status })
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === method)

let context: AuthContextValue
function Probe() {
  context = useAuthContext()
  return (
    <p>
      {context.loading ? 'loading' : 'ready'}|{context.user?.uid ?? 'signed-out'}
    </p>
  )
}

function renderProvider() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  )
}

async function emit(user: User | null) {
  await act(async () => {
    listener.emit(user)
  })
}

const state = () => screen.getByRole('paragraph').textContent

beforeEach(() => {
  vi.clearAllMocks()
  clientAuth.currentUser = null
  fetchMock.mockResolvedValue(okResponse())
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(getDoc).mockResolvedValue({ exists: () => true, data: () => ({ uid: 'alice-uid', displayName: 'Alice' }) } as never)
  vi.mocked(fbAuth.signOut).mockResolvedValue(undefined)
})

describe('AuthProvider — establishing the session', () => {
  it('a verified user is signed in only after the server accepts the session', async () => {
    renderProvider()
    await emit(firebaseUser(true))

    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    expect(calls('POST')).toHaveLength(1)
    expect(JSON.parse((calls('POST')[0]![1] as RequestInit).body as string)).toEqual({ token: 'id-token' })
  })

  it('treats a rejected session (HTTP 401) as a failure: signed out everywhere, no stuck spinner', async () => {
    fetchMock.mockImplementation(async (_url, init: RequestInit) => okResponse(init.method === 'POST' ? 401 : 200))
    renderProvider()
    await emit(firebaseUser(true))

    await waitFor(() => expect(state()).toBe('ready|signed-out'))
    expect(calls('DELETE').length).toBeGreaterThanOrEqual(1) // stale cookie cleared
    expect(fbAuth.signOut).toHaveBeenCalled() // Firebase client signed out too
    expect(toast.error).toHaveBeenCalledWith('Your session could not be confirmed. Please sign in again.')
  })

  it('treats a network failure the same way, without an unhandled rejection', async () => {
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      if (init.method === 'POST') throw new TypeError('Failed to fetch')
      return okResponse()
    })
    renderProvider()
    await emit(firebaseUser(true))

    await waitFor(() => expect(state()).toBe('ready|signed-out'))
    expect(fbAuth.signOut).toHaveBeenCalled()
  })

  it('a failed profile sync keeps the accepted session: signed in without a profile, not loading forever', async () => {
    vi.mocked(getDoc).mockRejectedValue(new Error('firestore unavailable'))
    renderProvider()
    await emit(firebaseUser(true))

    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    expect(context.profile).toBeNull()
    expect(calls('DELETE')).toHaveLength(0)
    expect(fbAuth.signOut).not.toHaveBeenCalled()
  })

  it('an unverified user gets no session and any stale cookie is cleared', async () => {
    renderProvider()
    await emit(firebaseUser(false))

    await waitFor(() => expect(state()).toBe('ready|signed-out'))
    expect(calls('POST')).toHaveLength(0)
    expect(calls('DELETE')).toHaveLength(1)
    expect(fbAuth.signOut).not.toHaveBeenCalled() // sign-up still needs the user to send the verification email
  })

  it('no Firebase user clears any stale server cookie', async () => {
    renderProvider()
    await emit(null)

    await waitFor(() => expect(state()).toBe('ready|signed-out'))
    expect(calls('DELETE')).toHaveLength(1)
  })
})

describe('AuthProvider — ordering and duplicate requests', () => {
  it('signInWithEmail does not create the session itself (the listener does it once)', async () => {
    renderProvider()
    await emit(null)
    vi.mocked(fbAuth.signInWithEmail).mockResolvedValue(firebaseUser(true))

    await act(async () => {
      await context.signInWithEmail('alice@example.com', 'password')
    })
    expect(calls('POST')).toHaveLength(0)

    await emit(firebaseUser(true)) // Firebase reports the sign-in
    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    expect(calls('POST')).toHaveLength(1)
  })

  it('handles a sign-in followed by a quick sign-out in order, ending signed out', async () => {
    let resolvePost: (value: unknown) => void = () => undefined
    fetchMock.mockImplementation((_url, init: RequestInit) =>
      init.method === 'POST'
        ? new Promise((resolve) => {
            resolvePost = resolve
          })
        : Promise.resolve(okResponse())
    )
    renderProvider()
    await emit(firebaseUser(true))
    await emit(null)

    // The sign-out waits for the slower sign-in request instead of racing it.
    expect(calls('DELETE')).toHaveLength(0)
    await act(async () => resolvePost(okResponse()))

    await waitFor(() => expect(state()).toBe('ready|signed-out'))
    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)
    expect(methods).toEqual(['POST', 'DELETE'])
  })
})

it('failed session creation with a failed cleanup DELETE says sign-out is incomplete', async () => {
  fetchMock.mockImplementation(async (_url, init: RequestInit) => okResponse(init.method === 'POST' ? 401 : 500))
  renderProvider()
  await emit(firebaseUser(true))

  // An older cookie might still be valid, so the message must not imply a complete sign-out.
  await waitFor(() => expect(state()).toBe('ready|signed-out'))
  expect(fbAuth.signOut).toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    'Your session could not be confirmed and sign-out could not be completed. Check your connection, then reload this page.'
  )
  expect(toast.error).not.toHaveBeenCalledWith('Your session could not be confirmed. Please sign in again.')
})

describe('AuthProvider — Google sign-in', () => {
  it('signInWithGoogle does not create the session itself (the listener does it once)', async () => {
    renderProvider()
    await emit(null)
    vi.mocked(fbAuth.signInWithGoogle).mockResolvedValue(firebaseUser(true))

    await act(async () => {
      await context.signInWithGoogle()
    })
    expect(calls('POST')).toHaveLength(0)

    await emit(firebaseUser(true))
    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    expect(calls('POST')).toHaveLength(1)
  })
})

describe('AuthProvider — confirmSession (server-side re-check)', () => {
  async function signedIn() {
    renderProvider()
    const user = firebaseUser(true)
    await emit(user)
    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    clientAuth.currentUser = user
    fetchMock.mockClear()
  }

  it('a valid session is confirmed: fresh token posted, user stays signed in', async () => {
    await signedIn()
    let confirmed: boolean | undefined
    await act(async () => {
      confirmed = await context.confirmSession()
    })

    expect(confirmed).toBe(true)
    expect(calls('POST')).toHaveLength(1)
    expect(state()).toBe('ready|alice-uid')
    expect(fbAuth.signOut).not.toHaveBeenCalled()
  })

  it('a revoked or unverified session (server refuses) signs out on both sides', async () => {
    await signedIn()
    fetchMock.mockImplementation(async (_url, init: RequestInit) => okResponse(init.method === 'POST' ? 401 : 200))
    let confirmed: boolean | undefined
    await act(async () => {
      confirmed = await context.confirmSession()
    })

    expect(confirmed).toBe(false)
    expect(state()).toBe('ready|signed-out')
    expect(calls('DELETE')).toHaveLength(1)
    expect(fbAuth.signOut).toHaveBeenCalled()
  })

  it('with no Firebase user there is nothing to confirm', async () => {
    renderProvider()
    await emit(null)
    fetchMock.mockClear()
    await expect(context.confirmSession()).resolves.toBe(false)
    expect(calls('POST')).toHaveLength(0)
  })
})

describe('AuthProvider — user-initiated sign-out', () => {
  async function signedIn() {
    renderProvider()
    await emit(firebaseUser(true))
    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    fetchMock.mockClear()
  }

  it('deletes the server cookie, then signs out of Firebase', async () => {
    await signedIn()
    await act(async () => {
      await context.signOut()
    })

    expect(calls('DELETE')).toHaveLength(1)
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fbAuth.signOut).mock.invocationCallOrder[0]!)
    expect(state()).toBe('ready|signed-out')
  })

  it.each([
    ['an HTTP error', () => fetchMock.mockResolvedValue(okResponse(500))],
    ['being offline', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('fails loudly on %s and stays signed in (no false sign-out)', async (_label, arrange) => {
    await signedIn()
    arrange()

    let error: unknown
    await act(async () => {
      error = await context.signOut().catch((e: unknown) => e)
    })

    expect(error).toEqual(new Error('sign-out-incomplete'))
    expect(fbAuth.signOut).not.toHaveBeenCalled()
    expect(state()).toBe('ready|alice-uid')
  })

  it('a retry after a failed sign-out succeeds', async () => {
    await signedIn()
    fetchMock.mockResolvedValueOnce(okResponse(500))
    await act(async () => {
      await context.signOut().catch(() => undefined)
    })
    expect(state()).toBe('ready|alice-uid')

    fetchMock.mockResolvedValue(okResponse())
    await act(async () => {
      await context.signOut()
    })
    expect(state()).toBe('ready|signed-out')
    expect(fbAuth.signOut).toHaveBeenCalledTimes(1)
  })
})

// ── Edge cases checked against a fake server that tracks the httpOnly cookie ──
// The browser applies Set-Cookie when a response arrives, so the cookie only
// changes when a mocked response resolves — not when the request is sent.

describe('AuthProvider — server cookie edge cases', () => {
  const server = { validCookie: false }

  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  beforeEach(() => {
    server.validCookie = false
  })

  it('profile sync failure after an accepted session never shows "signed out" while the cookie is still valid', async () => {
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      if (init.method === 'POST') {
        server.validCookie = true
        return okResponse(200)
      }
      return okResponse(500) // DELETE fails
    })
    vi.mocked(getDoc).mockRejectedValue(new Error('firestore unavailable'))
    renderProvider()
    await emit(firebaseUser(true))
    await waitFor(() => expect(state()?.startsWith('ready')).toBe(true))

    const uiSignedOut = state() === 'ready|signed-out'
    expect(uiSignedOut && server.validCookie).toBe(false)
    // The server accepted the session, so the user stays signed in (profile unavailable).
    expect(state()).toBe('ready|alice-uid')
    expect(context.profile).toBeNull()
    expect(fbAuth.signOut).not.toHaveBeenCalled()
  })

  it('a sign-out started while confirmSession() is in flight cannot be undone by the late POST response', async () => {
    const user = firebaseUser(true)
    const latePost = deferred<{ ok: boolean; status: number }>()
    let postCount = 0
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      if (init.method === 'POST') {
        postCount += 1
        if (postCount === 1) {
          server.validCookie = true // initial sign-in completes normally
          return Promise.resolve(okResponse(200))
        }
        return latePost.promise.then((res) => {
          server.validCookie = true // Set-Cookie applied when the late response arrives
          return res
        })
      }
      server.validCookie = false // DELETE
      return Promise.resolve(okResponse(200))
    })
    renderProvider()
    await emit(user)
    await waitFor(() => expect(state()).toBe('ready|alice-uid'))
    clientAuth.currentUser = user
    vi.mocked(fbAuth.signOut).mockImplementation(async () => {
      clientAuth.currentUser = null
    })

    let confirmPromise: Promise<boolean> = Promise.resolve(false)
    let signOutPromise: Promise<void> = Promise.resolve()
    await act(async () => {
      confirmPromise = context.confirmSession() // 1. delayed POST begins
      signOutPromise = context.signOut() // 2. user signs out
    })
    // 3. Nothing may be deleted yet: the sign-out waits for the in-flight confirmation.
    expect(calls('DELETE')).toHaveLength(0)

    await act(async () => {
      latePost.resolve(okResponse(200)) // 4. the earlier POST completes
      await confirmPromise
      await signOutPromise
    })
    await waitFor(() => expect(state()).toBe('ready|signed-out'))

    // The DELETE must be sent after the POST response, so the sign-out wins.
    expect(server.validCookie).toBe(false)
  })
})
