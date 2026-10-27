'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { BrandMark } from './BrandMark'
import { NavLinks } from './NavLinks'

export function Navbar() {
  const router = useRouter()
  const { user, signOut } = useAuth()

  const handleSignOut = async () => {
    try {
      await signOut()
    } catch {
      // The server could not confirm the session was removed, so the user is
      // still signed in. Say so; clicking sign out again retries.
      toast.error('Sign-out failed — check your connection and try again.')
      return
    }
    router.replace('/auth/signin')
    router.refresh()
  }

  // Below lg the sidebar is hidden, so the header carries the brand and a
  // second row with the same main navigation links.
  return (
    <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-14 items-center justify-between gap-3 px-4">
        <Link
          href="/dashboard"
          className="min-w-0 rounded-md text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 lg:hidden dark:focus-visible:outline-zinc-100"
        >
          <BrandMark />
        </Link>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-3">
          {user && (
            <span className="hidden text-sm text-zinc-500 sm:block dark:text-zinc-400">
              {user.email}
            </span>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
      <nav
        aria-label="Main navigation"
        className="overflow-x-auto border-t border-zinc-100 px-2 py-1.5 lg:hidden dark:border-zinc-800"
      >
        <NavLinks orientation="horizontal" />
      </nav>
    </header>
  )
}
