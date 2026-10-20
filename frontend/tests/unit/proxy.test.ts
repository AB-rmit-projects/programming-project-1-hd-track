// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : undefined,
  })
}

// NextResponse.next() marks the response with x-middleware-next; a redirect sets Location.
const passedThrough = (res: Response) => res.headers.get('x-middleware-next') === '1'

describe('proxy', () => {
  it.each(['/dashboard', '/profile', '/settings', '/dashboard/incidents/abc'])(
    'redirects %s to sign-in when there is no session cookie',
    (path) => {
      const res = proxy(request(path))
      expect(res.status).toBe(307)
      const location = new URL(res.headers.get('location') ?? '')
      expect(location.pathname).toBe('/auth/signin')
      expect(location.searchParams.get('redirect')).toBe(path)
    }
  )

  it('lets protected routes through when a session cookie exists (the layout verifies it)', () => {
    expect(passedThrough(proxy(request('/dashboard', '__session=any-value')))).toBe(true)
  })

  it.each(['/auth/signin', '/auth/signup'])(
    'never redirects away from %s just because a cookie exists (cookie may be stale)',
    (path) => {
      const res = proxy(request(path, '__session=stale-or-revoked'))
      expect(res.headers.get('location')).toBeNull()
      expect(passedThrough(res)).toBe(true)
    }
  )

  it('lets public pages through without a cookie', () => {
    expect(passedThrough(proxy(request('/')))).toBe(true)
    expect(passedThrough(proxy(request('/auth/signin')))).toBe(true)
  })
})
