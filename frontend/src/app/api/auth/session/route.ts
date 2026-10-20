import { type NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase/admin'
import { cookies } from 'next/headers'

const SESSION_COOKIE_NAME = '__session'
const SESSION_DURATION_MS = 60 * 60 * 24 * 14 * 1000 // 14 days

/** Firebase errors carry a safe `code` (e.g. auth/id-token-revoked); never log the token itself. */
function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
}

/**
 * POST /api/auth/session
 * Exchange a Firebase ID token for a server-side session cookie.
 * Only verified-email accounts get a session: 400 missing token,
 * 401 invalid/expired/revoked token, 403 email not verified.
 */
export async function POST(req: NextRequest) {
  try {
    const { token } = (await req.json()) as { token?: unknown }

    if (typeof token !== 'string' || token.length === 0) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }

    // Verify the ID token (signature, expiry, revocation) so its claims can be
    // checked before a long-lived session cookie is issued.
    const decoded = await adminAuth.verifyIdToken(token, true)
    if (decoded.email_verified !== true) {
      return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
    }

    const sessionCookie = await adminAuth.createSessionCookie(token, {
      expiresIn: SESSION_DURATION_MS,
    })

    const cookieStore = await cookies()
    cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, {
      maxAge: SESSION_DURATION_MS / 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Session creation failed:', errorCode(error))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

/**
 * DELETE /api/auth/session
 * Clear the session cookie (sign out server-side).
 */
export async function DELETE() {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
  return NextResponse.json({ success: true })
}
