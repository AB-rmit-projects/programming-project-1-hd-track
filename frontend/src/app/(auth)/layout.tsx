import type { Metadata } from 'next'
import Link from 'next/link'
import { BrandMark } from '@/components/layout/BrandMark'

export const metadata: Metadata = {
  title: 'Authentication',
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-50 px-4 py-10 dark:bg-zinc-950">
      <Link
        href="/"
        className="rounded-md text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100"
      >
        <BrandMark />
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
