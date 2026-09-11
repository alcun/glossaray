/** In-memory session admission and usage limits. */
import { limits } from "./config";

interface Bucket {
  count: number;
  resetAt: number;
}

export function createGate(now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();
  let live = 0;
  let dailyStarts = 0;
  let dailyResetAt = now() + 86_400_000;

  // Buckets are only ever created by a real request, so this cannot grow
  // without one; the sweep keeps a long-lived process from holding stale keys.
  const sweep = setInterval(() => {
    const t = now();
    for (const [address, bucket] of buckets) {
      if (t > bucket.resetAt) buckets.delete(address);
    }
  }, limits.rateWindowMs);
  if (typeof (sweep as any).unref === "function") (sweep as any).unref();

  return {
    /** Returns an error code, or null when the session may start. */
    admit(address: string): string | null {
      if (live >= limits.maxSessions) return "busy";

      const t = now();
      if (t > dailyResetAt) {
        dailyStarts = 0;
        dailyResetAt = t + 86_400_000;
      }
      if (dailyStarts >= limits.dailySessions) return "provider_budget";
      const bucket = buckets.get(address);
      if (!bucket || t > bucket.resetAt) {
        buckets.set(address, { count: 1, resetAt: t + limits.rateWindowMs });
      } else if (bucket.count >= limits.rateLimit) {
        return "rate_limited";
      } else {
        bucket.count += 1;
      }

      live += 1;
      dailyStarts += 1;
      return null;
    },

    release(): void {
      if (live > 0) live -= 1;
    },

    /** Undo an admission that failed validation before a provider session began. */
    reject(): void {
      if (live > 0) live -= 1;
      if (dailyStarts > 0) dailyStarts -= 1;
    },

    stats() {
      return { live, capacity: limits.maxSessions, addresses: buckets.size, dailyStarts };
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
