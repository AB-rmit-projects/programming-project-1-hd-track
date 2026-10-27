'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ListChecks, User, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

/** The app's destinations. Add links here; the sidebar and mobile bar both use this list. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Incident queue', icon: ListChecks },
  { href: '/profile', label: 'Account', icon: User },
]

/** True on the item's own page and its sub-pages (an incident is part of the queue). */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Main navigation links; the current section is marked with aria-current.
 * `vertical` is the desktop sidebar, `horizontal` the bar shown below lg.
 */
export function NavLinks({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const pathname = usePathname() ?? ''
  return (
    <ul className={cn(orientation === 'vertical' ? 'space-y-1' : 'flex gap-1')}>
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href)
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100',
                orientation === 'vertical' ? 'gap-3 px-3 py-2' : 'px-3 py-1.5',
                active
                  ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white'
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {label}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
