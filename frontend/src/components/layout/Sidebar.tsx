import Link from 'next/link'
import { BrandMark } from './BrandMark'
import { NavLinks } from './NavLinks'

/** Desktop navigation (lg and up). Below lg the Navbar shows the same links. */
export function Sidebar() {
  return (
    <aside className="hidden w-60 flex-col border-r border-zinc-200 bg-white lg:flex dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-14 items-center border-b border-zinc-200 px-4 dark:border-zinc-800">
        <Link
          href="/dashboard"
          className="min-w-0 rounded-md text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100"
        >
          <BrandMark />
        </Link>
      </div>
      <nav aria-label="Main navigation" className="flex-1 p-3">
        <NavLinks orientation="vertical" />
      </nav>
      <p className="border-t border-zinc-200 p-4 text-xs text-zinc-500 dark:border-zinc-800">
        Demonstration app — all incidents are fictional.
      </p>
    </aside>
  )
}
