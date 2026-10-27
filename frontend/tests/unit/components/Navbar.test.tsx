import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { Navbar } from '@/components/layout/Navbar'
import { Sidebar } from '@/components/layout/Sidebar'
import { NAV_ITEMS, isActive } from '@/components/layout/NavLinks'
import { useAuth } from '@/hooks/useAuth'
import type { AuthContextValue } from '@/types/auth'

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
const pathname = vi.hoisted(() => ({ current: '/dashboard' }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => pathname.current }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const signOut = vi.fn<() => Promise<void>>()

beforeEach(() => {
  vi.clearAllMocks()
  pathname.current = '/dashboard'
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

describe('Main navigation (Phase 6)', () => {
  it('offers only real destinations: the incident queue and the account page (no Settings)', () => {
    expect(NAV_ITEMS.map(({ href, label }) => [href, label])).toEqual([
      ['/dashboard', 'Incident queue'],
      ['/profile', 'Account'],
    ])
  })

  it('shows the main navigation in the header for small screens, with the brand linking to the queue', () => {
    render(<Navbar />)
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(nav).toHaveClass('lg:hidden')
    expect(screen.getByRole('link', { name: 'Incident queue' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/profile')
    expect(screen.getByRole('link', { name: /SafeCall Incident Review/ })).toHaveAttribute(
      'href',
      '/dashboard'
    )
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull()
  })

  it('marks the current section with aria-current, including an incident inside the queue', () => {
    pathname.current = '/dashboard/incidents/abc_INC-001'
    render(<Navbar />)
    expect(screen.getByRole('link', { name: 'Incident queue' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Account' })).not.toHaveAttribute('aria-current')
  })

  it('matches whole path segments only', () => {
    expect(isActive('/dashboard', '/dashboard')).toBe(true)
    expect(isActive('/dashboard/incidents/x', '/dashboard')).toBe(true)
    expect(isActive('/dashboardx', '/dashboard')).toBe(false)
    expect(isActive('/profile', '/dashboard')).toBe(false)
  })

  it('renders the same links in the desktop sidebar (hidden below lg)', () => {
    pathname.current = '/profile'
    const { container } = render(<Sidebar />)
    expect(container.querySelector('aside')).toHaveClass('hidden', 'lg:flex')
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Incident queue' })).not.toHaveAttribute('aria-current')
  })
})
