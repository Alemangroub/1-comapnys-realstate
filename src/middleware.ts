import { defineMiddleware } from 'astro/middleware';
import { getAuthenticatedUser, hasProjectAccess } from './lib/server-auth.js';

function isAllowedDevOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin) {
    if (import.meta.env.DEV && isAllowedDevOrigin(origin)) return true;
    return origin === url.origin;
  }

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (import.meta.env.DEV && isAllowedDevOrigin(refererUrl.origin)) return true;
      return refererUrl.origin === url.origin;
    } catch {
      return false;
    }
  }

  return true;
}

function applySecurityHeaders(response: Response) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Content-Security-Policy: restrict resource loading to same origin
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );

  if (import.meta.env.PROD) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = context.url.pathname;
  const method = context.request.method;

  // 1. CSRF Protection for mutating state methods (POST, PUT, DELETE, PATCH)
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const origin = context.request.headers.get('origin');
    const referer = context.request.headers.get('referer');

    if ((origin || referer) && !isSameOrigin(context.request, context.url)) {
      const forbidden = new Response(JSON.stringify({ error: "طلب مرفوض: تحقق CSRF غير صالح" }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
      applySecurityHeaders(forbidden);
      return forbidden;
    }
  }

  // 2. Preflight CORS handling for API
  const requestOrigin = context.request.headers.get('origin');
  const allowOrigin = import.meta.env.DEV && requestOrigin && isAllowedDevOrigin(requestOrigin)
    ? requestOrigin
    : '';

  if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
    const response = new Response(null, {
      status: 204,
      headers: allowOrigin
        ? {
            'Access-Control-Allow-Origin': allowOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Vary': 'Origin',
          }
        : {},
    });

    applySecurityHeaders(response);
    return response;
  }

  // 3. Server-Side Route Guard for Protected Pages
  const isCrsSubPath = pathname.startsWith('/crs/') && pathname !== '/crs';
  const isRoleDashboard = ['/engineer-dashboard', '/sales-dashboard', '/accounting-dashboard'].some(p => pathname.startsWith(p));

  if (isCrsSubPath || isRoleDashboard) {
    const user = getAuthenticatedUser(context.request);

    if (!user) {
      return context.redirect('/crs');
    }

    if (isCrsSubPath && user.role !== 'admin') {
      return context.redirect('/crs');
    }
  }

  // If user visits /crs while already logged in
  if (pathname === '/crs') {
    const user = getAuthenticatedUser(context.request);
    if (user) {
      if (user.role === 'supervisor') {
        return context.redirect('/dashboard');
      }
    }
  }

  const response = await next();
  applySecurityHeaders(response);

  if (pathname.startsWith('/api/') && allowOrigin) {
    response.headers.set('Access-Control-Allow-Origin', allowOrigin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.headers.set('Vary', 'Origin');
  }

  return response;
});
