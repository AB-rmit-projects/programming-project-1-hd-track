import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import SignInPage from '@/app/(auth)/auth/signin/page'
import { useAuth } from '@/hooks/useAuth'
import type { AuthContextValue } from '@/types/auth'

// Exception to "don't test src/app pages": the logic that decides whether a
// signed-in user may enter the dashboard (and so prevents redirect loops)
// lives in this page's effect.

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const signedInUser = { uid: 'alice-uid' } as AuthContextValue['user']

let auth: AuthContextValue

/** Every render gets fresh function identities, like the real AuthProvider. */
function mockAuth(overrides: Partial<AuthContextValue>) {
  const spies = {
    signInWithEmail: vi.fn().mockResolvedValue(undefined),
    signUpWithEmail: vi.fn(),
    signInWithGoogle: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    confirmSession: vi.fn().mockResolvedValue(true),
  }
  auth = { user: null, profile: null, loading: false, ...spies, ...overrides }
  vi.mocked(useAuth).mockImplementation(() => ({
    ...auth,
    confirmSession: () => auth.confirmSession(),
    signOut: () => auth.signOut(),
  }))
}

function visit(url: string) {
  window.history.replaceState(null, '', url)
}

async function signInWithForm() {
  await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com')
  await userEvent.type(screen.getByLabelText('Password'), 'Password1')
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  visit('/auth/signin')
})

describe('SignInPage — a user who was already signed in when the page opened', () => {
  it('is confirmed with the server, then sent to the dashboard', async () => {
    mockAuth({ user: signedInUser })
    render(<SignInPage />)

    expect(auth.confirmSession).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'))
  })

  it('a URL flag such as ?session=expired cannot sign out a valid user', async () => {
    mockAuth({ user: signedInUser })
    visit('/auth/signin?session=expired')
    render(<SignInPage />)

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'))
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('stays on sign-in (no bounce back, so no loop) when the server rejects the session', async () => {
    mockAuth({ user: signedInUser, confirmSession: vi.fn().mockResolvedValue(false) })
    render(<SignInPage />)

    await waitFor(() => expect(auth.confirmSession).toHaveBeenCalledTimes(1))
    await act(async () => undefined)
    expect(router.replace).not.toHaveBeenCalledWith('/dashboard')
  })

  it('an unexpected confirmSession error is handled: no redirect, no unhandled rejection, guard released', async () => {
    mockAuth({ user: signedInUser, confirmSession: vi.fn().mockRejectedValue(new Error('unexpected')) })
    const { rerender } = render(<SignInPage />)
    await waitFor(() => expect(auth.confirmSession).toHaveBeenCalledTimes(1))
    await act(async () => undefined)
    expect(router.replace).not.toHaveBeenCalled()

    // The guard was released: a later confirmed sign-in still reaches the dashboard.
    auth = { ...auth, user: null }
    rerender(<SignInPage />)
    auth = { ...auth, user: signedInUser }
    rerender(<SignInPage />)
    expect(router.replace).toHaveBeenCalledWith('/dashboard')
  })

  it('asks the server only once even if the page re-renders while waiting', () => {
    mockAuth({ user: signedInUser, confirmSession: vi.fn(() => new Promise<boolean>(() => undefined)) })
    const { rerender } = render(<SignInPage />)
    rerender(<SignInPage />)
    rerender(<SignInPage />)
    expect(auth.confirmSession).toHaveBeenCalledTimes(1)
  })
})

describe('SignInPage — signing in on this page', () => {
  it('a full page load (loading, then signed in by the listener) goes to the dashboard without a re-check', () => {
    mockAuth({ user: null, loading: true }) // provider still resolving on first render
    const { rerender } = render(<SignInPage />)
    expect(router.replace).not.toHaveBeenCalled()

    auth = { ...auth, loading: false, user: signedInUser } // listener confirmed the session
    rerender(<SignInPage />)

    expect(router.replace).toHaveBeenCalledWith('/dashboard')
    expect(auth.confirmSession).not.toHaveBeenCalled()
  })

  it('goes straight to the dashboard once the listener has confirmed the session (no extra POST)', () => {
    mockAuth({ user: null })
    const { rerender } = render(<SignInPage />)
    expect(router.replace).not.toHaveBeenCalled()

    // The auth listener established the session and set `user`.
    auth = { ...auth, user: signedInUser }
    rerender(<SignInPage />)

    expect(router.replace).toHaveBeenCalledWith('/dashboard')
    expect(auth.confirmSession).not.toHaveBeenCalled()
  })

  it('after a rejected session, a fresh sign-in is not re-checked a second time', async () => {
    mockAuth({ user: signedInUser, confirmSession: vi.fn().mockResolvedValue(false) })
    const { rerender } = render(<SignInPage />)
    await waitFor(() => expect(auth.confirmSession).toHaveBeenCalledTimes(1))

    auth = { ...auth, user: null } // provider signed the user out
    rerender(<SignInPage />)
    await act(async () => undefined)
    auth = { ...auth, user: signedInUser } // signed in again via the listener
    rerender(<SignInPage />)

    expect(router.replace).toHaveBeenCalledWith('/dashboard')
    expect(auth.confirmSession).toHaveBeenCalledTimes(1)
  })

  it('does not redirect when the form is submitted — it waits for the confirmed session', async () => {
    mockAuth({ user: null })
    render(<SignInPage />)
    await signInWithForm()

    expect(auth.signInWithEmail).toHaveBeenCalledWith('alice@example.com', 'Password1')
    expect(router.replace).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('does not offer Google sign-in (not enabled in this Firebase project)', () => {
    mockAuth({ user: null })
    render(<SignInPage />)
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull()
    expect(screen.queryByText(/^or$/i)).toBeNull()
  })

  it('still reports an unverified email', async () => {
    mockAuth({ user: null, signInWithEmail: vi.fn().mockRejectedValue(new Error('email-not-verified')) })
    render(<SignInPage />)
    await signInWithForm()

    expect(toast.error).toHaveBeenCalledWith('Please verify your email before signing in.')
  })
})

describe('SignInPage — other states', () => {
  it('shows the form and does not redirect a signed-out visitor', () => {
    mockAuth({ user: null })
    render(<SignInPage />)
    expect(router.replace).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('does nothing while auth state is still loading', () => {
    mockAuth({ user: signedInUser, loading: true })
    render(<SignInPage />)
    expect(router.replace).not.toHaveBeenCalled()
    expect(auth.confirmSession).not.toHaveBeenCalled()
  })
})
