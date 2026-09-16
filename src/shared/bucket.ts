/**
 * Cosmetic selector buckets, shared by the build (build/convert-cosmetic.ts,
 * which writes cosmetic/domains/<n>.json) and the service worker (which reads
 * them back). Both import this one function, so the hash used to write a
 * domain's bucket is always the hash used to find it.
 */
export const BUCKETS = 256;

/** Stable, tiny string hash (djb2) of a hostname, reduced to a bucket number. */
export function bucketOf(host: string): number {
  let h = 5381;
  for (let i = 0; i < host.length; i++) h = ((h << 5) + h + host.charCodeAt(i)) >>> 0;
  return h % BUCKETS;
}

/** One bucket file: hostname key → selectors to hide on that host. */
export type CosmeticBucket = Record<string, string[]>;
