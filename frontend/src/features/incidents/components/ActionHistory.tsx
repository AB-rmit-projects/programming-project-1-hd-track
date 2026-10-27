import {
  CheckCircle2,
  CloudOff,
  Eye,
  Info,
  Megaphone,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { formatMelbourneDateTime } from '@/lib/melbourneTime'
import { cn } from '@/lib/utils'
import type { IncidentHistoryState } from '@/features/incidents/hooks/useIncidentDetail'
import { ACTION_TYPE_LABELS, FALLBACK_LABELS } from '@/features/incidents/labels'
import type { ActionHistoryEntry } from '@/features/incidents/types'
import type { ActionType } from '@/types/firestore'
import { RetryButton, StatePanel } from './StatePanel'

const ACTION_STYLES: Record<ActionType, { icon: LucideIcon; className: string }> = {
  ACKNOWLEDGE: {
    icon: Eye,
    className: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
  ESCALATE: {
    icon: Megaphone,
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  REVIEWED: {
    icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
}

/** Icon plus text, so the decision never relies on colour alone. */
function ActionBadge({ actionType }: { actionType: ActionType | null }) {
  const style = actionType
    ? ACTION_STYLES[actionType]
    : { icon: Info, className: ACTION_STYLES.ACKNOWLEDGE.className }
  const Icon = style.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        style.className
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {actionType ? ACTION_TYPE_LABELS[actionType] : FALLBACK_LABELS.actionType}
    </span>
  )
}

function Entry({ entry }: { entry: ActionHistoryEntry }) {
  return (
    <li className="min-w-0 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ActionBadge actionType={entry.actionType} />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {entry.createdAt ? (
            <time dateTime={entry.createdAt.toISOString()}>
              {formatMelbourneDateTime(entry.createdAt)}
            </time>
          ) : (
            FALLBACK_LABELS.createdAt
          )}
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          Recorded by you
        </span>
      </div>
      <p className="mt-1.5 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">
        {entry.note ?? (
          <span className="text-zinc-500 dark:text-zinc-400">{FALLBACK_LABELS.note}</span>
        )}
      </p>
    </li>
  )
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function Notes({ history }: { history: IncidentHistoryState }) {
  return (
    <>
      {history.pendingCount > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {plural(history.pendingCount, 'decision is', 'decisions are')} waiting for the server and{' '}
          {history.pendingCount === 1 ? "isn't" : "aren't"} listed until confirmed.
        </p>
      )}
      {history.dataIssueCount > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {plural(history.dataIssueCount, 'entry has', 'entries have')} missing or unexpected
          fields; affected values are shown as “{FALLBACK_LABELS.actionType}”, “
          {FALLBACK_LABELS.createdAt}” or “{FALLBACK_LABELS.note}”.
        </p>
      )}
      {history.rejectedCount > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {plural(history.rejectedCount, 'record was', 'records were')} not shown because{' '}
          {history.rejectedCount === 1 ? "it doesn't" : "they don't"} belong to this incident and
          account.
        </p>
      )}
    </>
  )
}

function Body({ history, onRetry }: { history: IncidentHistoryState; onRetry: () => void }) {
  switch (history.status) {
    case 'ready':
    case 'stale': {
      const entries = history.entries ?? []
      return (
        <div className="space-y-3">
          {history.status === 'stale' && (
            <StatePanel
              role="status"
              tone="warning"
              icon={CloudOff}
              title="Showing cached history; it may be out of date."
              action={<RetryButton onRetry={onRetry} />}
            />
          )}
          {entries.length > 0 ? (
            <ol
              aria-label="Saved decisions, newest first"
              className="divide-y divide-zinc-200 dark:divide-zinc-800"
            >
              {entries.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </ol>
          ) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No decisions recorded yet.</p>
          )}
          <Notes history={history} />
        </div>
      )
    }
    case 'index-missing':
      return (
        <StatePanel
          role="alert"
          tone="warning"
          icon={TriangleAlert}
          title="Decision history is unavailable."
          action={<RetryButton onRetry={onRetry} />}
        >
          <p>
            The database index this history needs isn&apos;t available yet, so earlier decisions
            can&apos;t be verified right now. You can still record a decision.
          </p>
        </StatePanel>
      )
    case 'error':
      return (
        <StatePanel
          role="alert"
          tone="danger"
          icon={TriangleAlert}
          title="Decision history couldn't be loaded."
          action={<RetryButton onRetry={onRetry} />}
        >
          <p>
            Earlier decisions can&apos;t be verified right now. You can still record a decision.
          </p>
        </StatePanel>
      )
    case 'offline':
      return (
        <StatePanel
          role="status"
          tone="warning"
          icon={CloudOff}
          title="Decision history couldn't be confirmed with the server."
          action={<RetryButton onRetry={onRetry} />}
        >
          <p>Earlier decisions aren&apos;t shown until they are confirmed.</p>
        </StatePanel>
      )
    default:
      return (
        <div
          aria-busy="true"
          className="flex items-center gap-3 py-4 text-sm text-zinc-500 dark:text-zinc-400"
        >
          <LoadingSpinner size="sm" />
          <p>Loading decision history…</p>
        </div>
      )
  }
}

/**
 * The incident's decision history: server-accepted entries only, newest first.
 * "No decisions recorded yet" appears only for a server-confirmed empty
 * history — never when the history is loading or could not be loaded.
 */
export function ActionHistory({
  history,
  onRetry,
}: {
  history: IncidentHistoryState
  onRetry: () => void
}) {
  return (
    <section
      aria-labelledby="action-history-heading"
      className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="action-history-heading" className="text-base font-semibold">
          Decision history
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Newest first</p>
      </div>
      <div className="mt-3">
        <Body history={history} onRetry={onRetry} />
      </div>
    </section>
  )
}
