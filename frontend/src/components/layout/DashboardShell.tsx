import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Navbar } from './Navbar'

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Navbar />
        {/* `relative` makes <main> the containing block of absolutely positioned
            descendants (e.g. Tailwind's sr-only text), so they are clipped by and
            scroll with <main>. Without it they extend the document instead, giving
            the window its own scroll range below the h-screen shell. */}
        <main className="relative flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
