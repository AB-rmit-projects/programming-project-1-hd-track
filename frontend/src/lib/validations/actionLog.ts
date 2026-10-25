import { z } from 'zod'
import type { ActionType } from '@/types/firestore'

// Keep in sync with the actionLogs create rule in firebase/firestore.rules,
// which enforces the same limits server-side.
export const ACTION_TYPES = ['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'] as const satisfies readonly ActionType[]
export const NOTE_MIN_LENGTH = 10
export const NOTE_MAX_LENGTH = 500

const noteLengthMessage = `Enter between ${NOTE_MIN_LENGTH} and ${NOTE_MAX_LENGTH} characters.`

export const actionLogInputSchema = z.object({
  actionType: z.enum(ACTION_TYPES, { error: 'Choose ACKNOWLEDGE, ESCALATE or REVIEWED.' }),
  // trim() runs before the length checks, so whitespace padding never counts.
  // Length is String.length (UTF-16 code units), as the rules' size() counts it;
  // Zod 4's min()/max() count code points instead, so an emoji would count once.
  note: z
    .string()
    .trim()
    .refine(
      (note) => note.length >= NOTE_MIN_LENGTH && note.length <= NOTE_MAX_LENGTH,
      noteLengthMessage
    ),
})

export type ActionLogInput = z.infer<typeof actionLogInputSchema>
