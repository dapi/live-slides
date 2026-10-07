/** Private responses must not be stored by a shared cache or a browser back-forward cache. */
export function json(value: unknown, options: ResponseInit = {}): Response {
  const headers = new Headers(options.headers);
  headers.set('Cache-Control', 'no-store');
  return Response.json(value, { ...options, headers });
}
