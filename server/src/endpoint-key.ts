/**
 * The key a counted request is stored under in the adoption stats (endpoint_stats). Pure and dependency free, so it can be tested
 * without opening a database.
 *
 * A ticket is a credential that rides in the path. A route whose registered path has a :ticket parameter is keyed by that template,
 * whatever spelling Express accepted for it (case, trailing slash, percent-encoding): the ticket never reaches the key. The URL rule
 * below is only the fallback for a path with no route object (#1080 review).
 */

/** Path normalization: numeric segments fold to :id (/api/sop/runs/42 → /api/sop/runs/:id); an upload or download ticket segment folds to :ticket on any case. */
export function normalizeEndpoint(pathname: string): string {
  // Express matches routes without regard to case (no caseSensitive), so /API/MCP-REST/Downloads/<ticket> reaches the same route: fold on any case, key in the canonical one
  const ticket = /^\/api\/mcp-rest\/(uploads|downloads)\/[^/]+(\/.*)?$/i.exec(pathname);
  if (ticket) return `/api/mcp-rest/${ticket[1]!.toLowerCase()}/:ticket${ticket[2] ?? ''}`;
  return pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}

/** The stats key for a request: the route's own template when it carries a :ticket parameter, otherwise the normalized URL. */
export function endpointKey(routePath: unknown, url: string): string {
  if (typeof routePath === 'string' && /(^|\/):ticket(\/|$)/.test(routePath)) return routePath;
  return normalizeEndpoint(url);
}
