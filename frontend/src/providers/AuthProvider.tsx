'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { toast } from 'sonner'
import { getClientAuth, getClientDb } from '@/lib/firebase/client'
import {
  signInWithEmail as fbSignInWithEmail,
  signUpWithEmail as fbSignUpWithEmail,
  signInWithGoogle as fbSignInWithGoogle,
  signOut as fbSignOut,
} from '@/lib/firebase/auth'
import type { AuthContextValue } from '@/types/auth'
import type { UserProfile } from '@/types/firestore'

const AuthContext = createContext<AuthContextValue | null>(null)

async function syncUserProfile(user: User): Promise<UserProfile> {
  const profileRef = doc(getClientDb(), 'users', user.uid)
  const snap = await getDoc(profileRef)

  if (!snap.exists()) {
    const newProfile: Omit<UserProfile, 'createdAt' | 'updatedAt'> = {
      uid: user.uid,
      email: user.email ?? '',
      displayName: user.displayName,
      photoURL: user.photoURL,
      role: 'user',
      _schemaVersion: 1,
    }
    await setDoc(profileRef, {
      ...newProfile,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    const createdSnap = await getDoc(profileRef)
    if (!createdSnap.exists()) {
      throw new Error('Failed to create user profile document')
    }
    return createdSnap.data() as UserProfile
  }

  const existing = snap.data() as UserProfile

  if (!existing.displayName && user.displayName) {
    await setDoc(
      profileRef,
      {
        displayName: user.displayName,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )

    return {
      ...existing,
      displayName: user.displayName,
    }
  }

  return existing
}

/** Exchanges the user's ID token for the server session cookie. Throws if the server refuses. */
async function establishSession(firebaseUser: User): Promise<void> {
  const token = await firebaseUser.getIdToken()
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!response.ok) {
    throw new Error(`Session not established (HTTP ${response.status})`)
  }
}

/**
 * Asks the server to delete the httpOnly session cookie (only the server can).
 * Returns true only when the server confirms it; false on an HTTP error or
 * when offline. Never throws — each caller decides what a failure means.
 */
async function deleteSessionCookie(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/session', { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  // Every operation that sends a session request (auth changes, confirmSession,
  // signOut) runs through this one queue, so their HTTP requests never overlap:
  // e.g. a sign-out's DELETE is only sent after an in-flight POST has finished,
  // and a late POST response can never re-create the cookie after sign-out.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const runInOrder = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const result = queue.current.then(task)
    queue.current = result.catch(() => undefined) // keep the queue alive after a failure
    return result
  }, [])

  /**
   * The session could not be established or confirmed: sign out of Firebase
   * and try to delete the server cookie. If the server confirms the deletion
   * the user is fully signed out. If not (offline / HTTP error), an older valid
   * cookie may remain in this browser, so say so instead of implying a
   * complete sign-out; the next page load retries the deletion.
   */
  const endRejectedSession = useCallback(async () => {
    setUser(null)
    setProfile(null)
    const cookieDeleted = await deleteSessionCookie()
    await fbSignOut().catch(() => undefined)
    toast.error(
      cookieDeleted
        ? 'Your session could not be confirmed. Please sign in again.'
        : 'Your session could not be confirmed and sign-out could not be completed. Check your connection, then reload this page.'
    )
  }, [])

  useEffect(() => {
    // The single place a session is created when Firebase reports a sign-in.
    // `user` is only set once the server has accepted the session, so pages
    // can trust it before redirecting into the protected area.
    async function handleAuthChange(firebaseUser: User | null) {
      setLoading(true)
      try {
        if (firebaseUser?.emailVerified) {
          await establishSession(firebaseUser)
          // From here the server has accepted the session, so the user IS signed
          // in. A profile failure must not undo that (it could leave a valid
          // cookie behind while the UI says signed out) — continue without it.
          const userProfile = await syncUserProfile(firebaseUser).catch(() => null)
          setUser(firebaseUser)
          setProfile(userProfile)
        } else {
          // Signed out, or email not verified yet: no client user and no server
          // session. Best-effort removal of any stale cookie left in the browser.
          setUser(null)
          setProfile(null)
          await deleteSessionCookie()
        }
      } catch {
        await endRejectedSession()
      } finally {
        setLoading(false)
      }
    }

    // Firebase can report changes in quick succession (e.g. sign-in, then
    // sign-out); handle them one at a time, in order, so a slow request for an
    // older change can never overwrite the result of a newer one.
    const unsubscribe = onAuthStateChanged(getClientAuth(), (firebaseUser) => {
      void runInOrder(() => handleAuthChange(firebaseUser))
    })

    return () => unsubscribe()
  }, [endRejectedSession, runInOrder])

  /**
   * Re-checks the current user's session with the server by sending a fresh ID
   * token. Used when a page finds a signed-in user it did not just sign in, e.g.
   * after the server redirected away from the dashboard. Valid user: a fresh
   * cookie and `true`. Revoked or unverified: signed out and `false`.
   */
  const confirmSession = useCallback(
    (): Promise<boolean> =>
      runInOrder(async () => {
        const currentUser = getClientAuth().currentUser // read when it runs, after any queued sign-out
        if (!currentUser) return false
        try {
          await establishSession(currentUser)
          return true
        } catch {
          await endRejectedSession()
          return false
        }
      }),
    [endRejectedSession, runInOrder]
  )

  // Sign-in methods only sign in to Firebase. The auth listener above then
  // creates the server session, so there is exactly one session request.
  const signInWithEmail = async (email: string, password: string) => {
    await fbSignInWithEmail(email, password)
  }

  const signUpWithEmail = async (email: string, password: string, displayName: string) => {
    await fbSignUpWithEmail(email, password, displayName)
  }

  const signInWithGoogle = async () => {
    await fbSignInWithGoogle()
  }

  /**
   * User-initiated sign-out. The server cookie is deleted first; if the server
   * cannot confirm that, nothing else changes and this throws, so the user
   * stays signed in and can retry instead of looking signed out while a valid
   * session cookie remains.
   */
  const signOut = () =>
    runInOrder(async () => {
      if (!(await deleteSessionCookie())) {
        throw new Error('sign-out-incomplete')
      }
      await fbSignOut()
      setUser(null)
      setProfile(null)
    })

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        signOut,
        confirmSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider')
  }
  return context
}
