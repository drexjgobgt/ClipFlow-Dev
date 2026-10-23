/**
 * Shared in-memory thumbnail cache keyed by clip path. Both the gallery and
 * the Home "Recent Replays" strip decode thumbnails lazily, so they must not
 * duplicate the same MP4 decode when switching tabs.
 */
const cache = new Map<string, string>();

/** LRU cap so scrolling through thousands of clips cannot balloon memory. */
const MAX = 400;

export function getCachedThumbnail(path: string): string | undefined {
  return cache.get(path);
}

export function cacheThumbnail(path: string, data: string): void {
  if (cache.has(path)) cache.delete(path);
  cache.set(path, data);
  if (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
