import { ShieldCheck } from 'lucide-react'
import { APP_NAME } from '@/lib/brand'

/** The product mark: icon plus name. Decorative icon; the name is the text. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold ${className ?? ''}`}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
        <ShieldCheck aria-hidden="true" className="size-4" />
      </span>
      <span className="truncate">{APP_NAME}</span>
    </span>
  )
}
