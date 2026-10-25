import type { ReactNode } from 'react'
import { RefreshCw, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Shared by the incident queue and the incident detail page.

export const BUTTON =
  'inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'

export function RetryButton({ onRetry, label = 'Retry' }: { onRetry: () => void; label?: string }) {
  return (
    <button type="button" onClick={onRetry} className={BUTTON}>
      <RefreshCw className="size-4" />
      {label}
    </button>
  )
}

const PANEL_TONES = {
  danger:
    'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  neutral:
    'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
}

interface StatePanelProps {
  role: 'alert' | 'status' | 'note'
  tone: keyof typeof PANEL_TONES
  icon: LucideIcon
  title: string
  children?: ReactNode
  action?: ReactNode
}

export function StatePanel({ role, tone, icon: Icon, title, children, action }: StatePanelProps) {
  return (
    <div role={role} className={cn('flex gap-3 rounded-lg border p-4 text-sm', PANEL_TONES[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1 space-y-2">
        <p className="font-semibold">{title}</p>
        {children}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  )
}
