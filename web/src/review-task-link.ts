/** Older servers return a protected JSON endpoint; review tasks must enter the UI instead. */
export function reviewTaskLink(t: { id: string; source: string; project?: string | null; link?: string | null }): string | null {
  if (t.source === 'market' && t.project === 'review-gate' && t.id.startsWith('change-request:')) {
    const id = t.id.slice('change-request:'.length);
    if (/^[1-9][0-9]*$/.test(id)) return '/reviews?request=' + id;
  }
  return t.link || null;
}
