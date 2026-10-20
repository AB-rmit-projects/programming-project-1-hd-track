import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { Navbar } from '@/components/layout/Navbar'
import { useAuth } from '@/hooks/useAuth'
import type { AuthContextValue } from '@/types/auth'

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const signOut = vi.fn<() => Promise<void>>()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({
    user: { email: 'alice@example.com' },
    signOut,
  } as unknown as AuthContextValue)
})

async function clickSignOut() {
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  })
}

describe('Navbar sign-out', () => {
  it('goes to sign-in after a confirmed sign-out', async () => {
    signOut.mockResolvedValue(undefined)
    render(<Navbar />)
    await clickSignOut()

    expect(router.replace).toHaveBeenCalledWith('/auth/signin')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a failed sign-out, stays put, and lets the user retry', async () => {
    signOut.mockRejectedValueOnce(new Error('sign-out-incomplete')).mockResolvedValueOnce(undefined)
    render(<Navbar />)

    await clickSignOut()
    expect(toast.error).toHaveBeenCalledWith('Sign-out failed — check your connection and try again.')
    expect(router.replace).not.toHaveBeenCalled()

    await clickSignOut() // retry
    expect(signOut).toHaveBeenCalledTimes(2)
    expect(router.replace).toHaveBeenCalledWith('/auth/signin')
  })
})
