import type { ReactNode } from 'react'
import { BellOff, CheckCircle2, CircleHelp, Clock, WifiOff, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FALLBACK_LABELS,
  INCIDENT_STATUS_LABELS,
  REVIEW_STATUS_LABELS,
} from '@/features/incidents/labels'
import type { ReviewStatus } from '@/features/incidents/types'
import type { Incident } from '@/types/firestore'

// Every badge pairs a text label with an icon, so no state relies on colour alone.
// Lucide marks icons aria-hidden by default; the text is what is announced.

interface BadgeStyle {
  icon: LucideIcon
  className: string
}

function Badge({ icon: Icon, className, children }: BadgeStyle & { children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {children}
    </span>
  )
}

const NEUTRAL = 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'

const STATUS_STYLES: Record<Incident['status'], BadgeStyle> = {
  OFFLINE: {
    icon: WifiOff,
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  SILENT: {
    icon: BellOff,
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
}

const REVIEW_STYLES: Record<ReviewStatus, BadgeStyle> = {
  AWAITING_REVIEW: { icon: Clock, className: NEUTRAL },
  REVIEWED: {
    icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
}

export function IncidentStatusBadge({ status }: { status: Incident['status'] | null }) {
  if (status === null) {
    return (
      <Badge icon={CircleHelp} className={NEUTRAL}>
        {FALLBACK_LABELS.status}
      </Badge>
    )
  }
  return <Badge {...STATUS_STYLES[status]}>{INCIDENT_STATUS_LABELS[status]}</Badge>
}

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge {...REVIEW_STYLES[status]}>{REVIEW_STATUS_LABELS[status]}</Badge>
}
