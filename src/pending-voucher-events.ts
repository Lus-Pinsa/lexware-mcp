export type PendingVoucherEvent = {
  eventType: "voucher.created";
  resourceId: string;
  eventDate: string;
  receivedAt: string;
};

/**
 * V1 pending-event store.
 *
 * Important:
 * This is intentionally in-memory for now.
 * Render restarts/redeploys can clear it.
 *
 * Lexware remains the source of truth.
 */
const pendingVoucherEvents = new Map<
  string,
  PendingVoucherEvent
>();

/**
 * Upper bound of the in-memory queue. In READ_ONLY mode nothing acknowledges events, so without a bound a
 * stream of (validly signed) events would grow memory until restart. When full, the oldest event is dropped:
 * Lexware stays the source of truth and `reconcile-recent-vouchers` re-finds anything missed.
 */
export const MAX_PENDING_VOUCHER_EVENTS = 1000;

let droppedOverflow = 0;

function eventKey(event: {
  eventType: string;
  resourceId: string;
  eventDate: string;
}): string {
  return [
    event.eventType,
    event.resourceId,
    event.eventDate,
  ].join(":");
}

/**
 * Add a voucher event.
 *
 * Lexware can retry webhook delivery, so identical
 * events are deduplicated.
 */
export function addPendingVoucherEvent(input: {
  resourceId: string;
  eventDate: string;
}): {
  added: boolean;
  event: PendingVoucherEvent;
  count: number;
  /** Oldest events dropped to make room for this one (0 or 1). */
  dropped: number;
} {
  const event: PendingVoucherEvent = {
    eventType: "voucher.created",
    resourceId: input.resourceId,
    eventDate: input.eventDate,
    receivedAt: new Date().toISOString(),
  };

  const key = eventKey(event);

  const alreadyExists =
    pendingVoucherEvents.has(key);

  let dropped = 0;
  if (!alreadyExists) {
    // Map iteration order is insertion order, so the first key is the oldest event.
    while (pendingVoucherEvents.size >= MAX_PENDING_VOUCHER_EVENTS) {
      const oldest = pendingVoucherEvents.keys().next();
      if (oldest.done) break;
      pendingVoucherEvents.delete(oldest.value);
      droppedOverflow++;
      dropped++;
    }
    pendingVoucherEvents.set(key, event);
  }

  return {
    added: !alreadyExists,
    event:
      pendingVoucherEvents.get(key) ??
      event,
    count: pendingVoucherEvents.size,
    dropped,
  };
}

/** Number of events dropped because the queue was full (since process start). */
export function droppedPendingVoucherEvents(): number {
  return droppedOverflow;
}

/**
 * Return all currently pending voucher events.
 * Oldest first.
 */
export function listPendingVoucherEvents():
  PendingVoucherEvent[] {
  return Array.from(
    pendingVoucherEvents.values(),
  ).sort((a, b) =>
    a.receivedAt.localeCompare(b.receivedAt),
  );
}

/**
 * Acknowledge all pending voucher.created events
 * for a resource ID.
 */
export function acknowledgePendingVoucherEvent(
  resourceId: string,
): {
  removed: number;
  remaining: number;
} {
  let removed = 0;

  for (const [key, event] of pendingVoucherEvents) {
    if (event.resourceId === resourceId) {
      pendingVoucherEvents.delete(key);
      removed++;
    }
  }

  return {
    removed,
    remaining: pendingVoucherEvents.size,
  };
}
