import { type NextRequest, NextResponse } from 'next/server'

const PROTECTED_ROUTES = ['/dashboard', '/profile', '/settings']

/**
 * Optimistic proxy — checks for the presence of the session cookie only.
 * Cryptographic token verification happens in Server Actions and Route Handlers
 * using the Firebase Admin SDK (near the data, not at the edge).
 *
 * A cookie's presence does not prove it is valid, so the proxy never sends
 * anyone away from /auth/* — doing so loops with the (dashboard) layout when
 * the cookie is expired, revoked or unverified. The sign-in page redirects
 * signed-in users itself, once their session is confirmed.
 */
export function proxy(req: NextRequest) {
  const hasSessionCookie = Boolean(req.cookies.get('__session')?.value)
  const { pathname } = req.nextUrl

  const isProtected = PROTECTED_ROUTES.some((route) => pathname.startsWith(route))

  if (isProtected && !hasSessionCookie) {
    const loginUrl = new URL('/auth/signin', req.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, public assets
     * - api routes (they handle their own auth)
     */
    '/((?!_next/static|_next/image|favicon.ico|api/|images/).*)',
  ],
}
