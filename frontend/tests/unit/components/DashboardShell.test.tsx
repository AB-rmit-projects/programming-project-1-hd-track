import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardShell } from '@/components/layout/DashboardShell'

// The shell's own structure is under test, not the navigation inside it.
vi.mock('@/components/layout/Navbar', () => ({ Navbar: () => <header>navbar</header> }))
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => <aside>sidebar</aside> }))

describe('DashboardShell', () => {
  it('scrolls the page content inside <main>, which is also the containing block for positioned content', () => {
    render(
      <DashboardShell>
        <p>Page content</p>
        <span className="sr-only">Screen-reader-only text</span>
      </DashboardShell>
    )
    const main = screen.getByRole('main')
    // The shell is exactly one viewport tall and never scrolls itself.
    expect(main.closest('.h-screen')).toHaveClass('overflow-hidden')
    // <main> is the only scroll container. It must be positioned: otherwise absolutely
    // positioned descendants (Tailwind's sr-only) escape its clipping and give the
    // document its own scroll range below the shell (a blank area under long pages).
    expect(main).toHaveClass('flex-1', 'overflow-y-auto', 'relative')
    expect(main).toContainElement(screen.getByText('Screen-reader-only text'))
  })
})
