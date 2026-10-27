import type { Metadata } from 'next'
import Link from 'next/link'
import { FlaskConical, History, ListChecks, ScanSearch } from 'lucide-react'
import { BrandMark } from '@/components/layout/BrandMark'
import { APP_DESCRIPTION, APP_NAME } from '@/lib/brand'

export const metadata: Metadata = {
  title: { absolute: APP_NAME },
  description: APP_DESCRIPTION,
}

const FEATURES = [
  {
    icon: ListChecks,
    title: 'One review queue',
    text: 'Search, filter and sort the pendant connectivity incidents assigned to you, and see at a glance which still await review.',
  },
  {
    icon: ScanSearch,
    title: 'Evidence before decisions',
    text: 'Each incident shows its simulated evidence, a likely-cause interpretation and an advisory next step — never a confirmed diagnosis.',
  },
  {
    icon: History,
    title: 'Auditable history',
    text: 'Acknowledge, escalate or mark an incident reviewed with a written rationale. Saved decisions are append-only.',
  },
] as const

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-4 py-3 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900">
        <BrandMark className="text-sm" />
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-10 px-4 py-12 sm:px-6">
        <section className="space-y-5">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Review SafeCall pendant connectivity incidents with the evidence in view.
          </h1>
          <p className="max-w-2xl text-base text-zinc-600 sm:text-lg dark:text-zinc-400">
            {APP_NAME} helps a monitoring operator work through offline and silent pendant
            incidents: weigh the evidence, decide what to do, and keep a record of every decision.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/auth/signin"
              className="inline-flex items-center justify-center rounded-md bg-zinc-900 px-6 py-2.5 text-sm font-medium text-white shadow transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Sign in
            </Link>
            <Link
              href="/auth/signup"
              className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-6 py-2.5 text-sm font-medium shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            >
              Create account
            </Link>
          </div>
        </section>

        <ul className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li
              key={title}
              className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <Icon aria-hidden="true" className="size-5 text-zinc-500" />
              <h2 className="mt-3 text-sm font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{text}</p>
            </li>
          ))}
        </ul>

        <p
          role="note"
          className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">Demonstration only.</span> Every incident, device and
            event in this app is fictional. It is not connected to real pendants, and no alerts,
            calls or welfare checks are ever sent.
          </span>
        </p>
      </div>
    </main>
  )
}
