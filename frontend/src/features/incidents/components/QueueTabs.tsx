'use client'

import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { QUEUE_TAB_LABELS } from '@/features/incidents/labels'
import type { QueueTab } from '@/features/incidents/types'

export const QUEUE_TABS: readonly QueueTab[] = ['ALL', 'AWAITING_REVIEW', 'REVIEWED']

export function tabId(tab: QueueTab): string {
  return `incident-queue-tab-${tab}`
}

interface QueueTabsProps {
  activeTab: QueueTab
  counts: Record<QueueTab, number>
  /** ID of the tab panel these tabs control. */
  panelId: string
  onChange: (tab: QueueTab) => void
}

/**
 * WAI-ARIA tabs with automatic activation: only the selected tab is in the Tab
 * order; Arrow Left/Right move between tabs (wrapping), Home/End jump to the
 * first/last. Moving focus also selects the tab.
 */
export function QueueTabs({ activeTab, counts, panelId, onChange }: QueueTabsProps) {
  const tabRefs = useRef<Partial<Record<QueueTab, HTMLButtonElement | null>>>({})

  function select(tab: QueueTab) {
    onChange(tab)
    tabRefs.current[tab]?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = QUEUE_TABS.indexOf(activeTab)
    const last = QUEUE_TABS.length - 1
    const target = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    select(QUEUE_TABS[target]!)
  }

  // Below sm the three tabs share the full width equally and their labels may
  // wrap, so nothing is cut off or scrolls sideways on a 320px phone; from sm
  // up they sit on one line. The focus outline is drawn inside each tab.
  return (
    <div>
      <div
        role="tablist"
        aria-label="Filter incidents by review status"
        className="grid grid-cols-3 border-b border-zinc-200 sm:flex sm:gap-1 dark:border-zinc-800"
      >
        {QUEUE_TABS.map((tab) => {
          const selected = tab === activeTab
          return (
            <button
              key={tab}
              ref={(element) => {
                tabRefs.current[tab] = element
              }}
              type="button"
              role="tab"
              id={tabId(tab)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab)}
              onKeyDown={handleKeyDown}
              className={cn(
                '-mb-px inline-flex min-w-0 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-center text-sm leading-tight font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-900 sm:flex-row sm:gap-2 sm:px-3 sm:whitespace-nowrap dark:focus-visible:outline-zinc-100',
                selected
                  ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
              )}
            >
              {QUEUE_TAB_LABELS[tab]}
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 tabular-nums dark:bg-zinc-800 dark:text-zinc-300">
                {counts[tab]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
