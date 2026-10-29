/**
 * Client-side authentication helper.
 * Relies on HttpOnly cookies set by the server (most secure approach).
 * localStorage is no longer used for token storage to mitigate XSS risks.
 */

export async function checkAuth() {
  try {
    // Cookies are sent automatically by the browser; no manual header needed
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.authenticated) {
      return data.user;
    }
    return null;
  } catch (error) {
    console.error('Auth check error:', error);
    return null;
  }
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'GET', credentials: 'include' });
  window.location.href = '/crs';
}

/**
 * Returns headers needed for API calls.
 * With HttpOnly cookies, the browser sends them automatically.
 * This function is kept for backward compatibility but no longer injects tokens.
 */
export function getAuthHeaders(additionalHeaders = {}) {
  return { ...additionalHeaders };
}

/**
 * @deprecated Token is now managed entirely by HttpOnly cookies.
 * This function is a no-op kept for backward compatibility.
 */
export function setAuthToken(_token) {
  // No-op: token management is handled by server-set HttpOnly cookies
}
