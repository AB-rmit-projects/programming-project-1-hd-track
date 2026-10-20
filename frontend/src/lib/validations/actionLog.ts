import { z } from 'zod'
import type { ActionType } from '@/types/firestore'

// Keep in sync with the actionLogs create rule in firebase/firestore.rules,
// which enforces the same limits server-side.
export const ACTION_TYPES = ['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'] as const satisfies readonly ActionType[]
export const NOTE_MIN_LENGTH = 10
export const NOTE_MAX_LENGTH = 500

const noteLengthMessage = `Enter between ${NOTE_MIN_LENGTH} and ${NOTE_MAX_LENGTH} characters.`

export const actionLogInputSchema = z.object({
  actionType: z.enum(ACTION_TYPES, {
    errorMap: () => ({ message: 'Choose ACKNOWLEDGE, ESCALATE or REVIEWED.' }),
  }),
  // trim() runs before the length checks, so whitespace padding never counts.
  note: z.string().trim().min(NOTE_MIN_LENGTH, noteLengthMessage).max(NOTE_MAX_LENGTH, noteLengthMessage),
})

export type ActionLogInput = z.infer<typeof actionLogInputSchema>
