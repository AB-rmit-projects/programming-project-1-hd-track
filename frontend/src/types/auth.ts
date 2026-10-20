import type { User } from 'firebase/auth'
import type { UserProfile } from './firestore'

export interface AuthContextValue {
  user: User | null
  profile: UserProfile | null
  loading: boolean
  signInWithEmail: (email: string, password: string) => Promise<void>
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
  /** Throws if the server could not confirm the session cookie was deleted. */
  signOut: () => Promise<void>
  /** Re-checks the session with the server; resolves false (and signs out) if it is rejected. */
  confirmSession: () => Promise<boolean>
}

export interface SessionPayload {
  uid: string
  email: string
  expiresAt: number
}
