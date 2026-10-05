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

  if (!alreadyExists) {
    pendingVoucherEvents.set(key, event);
  }

  return {
    added: !alreadyExists,
    event:
      pendingVoucherEvents.get(key) ??
      event,
    count: pendingVoucherEvents.size,
  };
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
