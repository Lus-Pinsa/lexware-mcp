import {
  acknowledgePendingVoucherEvent,
  addPendingVoucherEvent,
  droppedPendingVoucherEvents,
  listPendingVoucherEvents,
  type PendingVoucherEvent,
} from "./pending-voucher-events.js";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

export interface PendingVoucherEventStore {
  readonly mode: "memory" | "postgres";
  enqueue(input: {
    readonly resourceId: string;
    readonly eventDate: string;
    readonly payloadChecksum: string;
  }): Promise<{
    readonly added: boolean;
    readonly count: number;
    readonly dropped: number;
  }>;
  list(): Promise<readonly PendingVoucherEvent[]>;
  acknowledge(resourceId: string): Promise<{
    readonly removed: number;
    readonly remaining: number;
  }>;
  droppedTotal(): number;
}

export function validatePendingVoucherResourceId(value: string): string {
  if (!RESOURCE_ID_PATTERN.test(value)) {
    throw new Error("Invalid pending voucher resource id.");
  }
  return value;
}

export function validatePendingVoucherEventDate(value: string): string {
  if (!EVENT_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("Invalid pending voucher event date.");
  }
  return value;
}

export function createMemoryPendingVoucherEventStore(): PendingVoucherEventStore {
  return Object.freeze({
    mode: "memory" as const,
    async enqueue(input: {
      readonly resourceId: string;
      readonly eventDate: string;
      readonly payloadChecksum: string;
    }) {
      validatePendingVoucherResourceId(input.resourceId);
      validatePendingVoucherEventDate(input.eventDate);
      const result = addPendingVoucherEvent({
        resourceId: input.resourceId,
        eventDate: input.eventDate,
      });
      return Object.freeze({
        added: result.added,
        count: result.count,
        dropped: result.dropped,
      });
    },
    async list() {
      return Object.freeze(listPendingVoucherEvents());
    },
    async acknowledge(resourceId: string) {
      return Object.freeze(
        acknowledgePendingVoucherEvent(
          validatePendingVoucherResourceId(resourceId),
        ),
      );
    },
    droppedTotal() {
      return droppedPendingVoucherEvents();
    },
  });
}
