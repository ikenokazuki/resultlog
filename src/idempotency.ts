import type { Firestore } from "firebase-admin/firestore";

/** Remembers which events were processed, so that a redelivery does the work only once. */
export interface IdempotencyStore {
  /** Atomically claims an event: "claimed" to process it, "done" if it was processed already, "in-flight" if another instance holds a live claim. */
  claim(key: string, leaseMs: number): Promise<"claimed" | "done" | "in-flight">;
  /** Marks the event as processed for good. */
  complete(key: string): Promise<void>;
  /** Gives the claim up, so that a redelivery can process the event. */
  release(key: string): Promise<void>;
}

/**
 * An `IdempotencyStore` in Firestore: one small document per event. Add a TTL policy on the `expireAt` field of the
 * collection so that Firestore deletes the documents for you.
 */
export function firestoreIdempotency(
  db: Pick<Firestore, "collection" | "runTransaction">,
  { collection = "_resultlog_events", ttlMs = 7 * 24 * 60 * 60 * 1000 }: { collection?: string; ttlMs?: number } = {},
): IdempotencyStore {
  const doc = (key: string) => db.collection(collection).doc(key);
  const expireAt = () => new Date(Date.now() + ttlMs);
  return {
    claim: (key, leaseMs) =>
      db.runTransaction<"claimed" | "done" | "in-flight">(async (tx) => {
        const ref = doc(key);
        const data = (await tx.get(ref)).data();
        const now = Date.now();
        if (data?.state === "done") return "done";
        if (data?.state === "processing" && data.leaseUntil > now) return "in-flight"; // else its instance is presumed dead
        tx.set(ref, { state: "processing", leaseUntil: now + leaseMs, expireAt: expireAt() });
        return "claimed";
      }),
    complete: async (key) => {
      await doc(key).set({ state: "done", expireAt: expireAt() });
    },
    release: async (key) => {
      await doc(key).delete();
    },
  };
}
