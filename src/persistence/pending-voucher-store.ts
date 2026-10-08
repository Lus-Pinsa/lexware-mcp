import {
  acknowledgePendingVoucherEvent,
  addPendingVoucherEvent,
  droppedPendingVoucherEvents,
  listPendingVoucherEvents,
  MAX_PENDING_VOUCHER_EVENTS,
  type PendingVoucherEvent,
} from "../pending-voucher-events.js";
import {
  decryptField,
  encryptField,
  sha256Hex,
  type EncryptionKeyring,
} from "./crypto.js";
import {
  acknowledgeWebhookEvent,
  countPendingWebhookEvents,
  insertWebhookEvent,
  listPendingWebhookEvents,
  lockTenantForUpdate,
  type PersistenceDatabase,
  withTenantTransaction,
} from "./repository.js";
import {
  type TenantId,
  PersistenceValidationError,
} from "./types.js";

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

export class PendingVoucherCapacityError extends Error {
  constructor() {
    super("Durable pending voucher queue is at capacity.");
    this.name = "PendingVoucherCapacityError";
  }
}

function validateResourceId(value: string): string {
  if (!RESOURCE_ID_PATTERN.test(value)) {
    throw new PersistenceValidationError("Invalid pending voucher resource id.");
  }
  return value;
}

function validateEventDate(value: string): string {
  if (!EVENT_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new PersistenceValidationError("Invalid pending voucher event date.");
  }
  return value;
}

function eventKeyHash(resourceId: string, eventDate: string): string {
  return sha256Hex("voucher.created\u0000" + resourceId + "\u0000" + eventDate);
}

export function createMemoryPendingVoucherEventStore(): PendingVoucherEventStore {
  return Object.freeze({
    mode: "memory" as const,
    async enqueue(input) {
      validateResourceId(input.resourceId);
      validateEventDate(input.eventDate);
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
      return Object.freeze(acknowledgePendingVoucherEvent(validateResourceId(resourceId)));
    },
    droppedTotal() {
      return droppedPendingVoucherEvents();
    },
  });
}

export function createDurablePendingVoucherEventStore(options: {
  readonly db: PersistenceDatabase;
  readonly tenantId: TenantId;
  readonly keyring: EncryptionKeyring;
  readonly now?: () => Date;
}): PendingVoucherEventStore {
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    mode: "postgres" as const,

    async enqueue(input) {
      const resourceId = validateResourceId(input.resourceId);
      const eventDate = validateEventDate(input.eventDate);
      const payloadChecksum = sha256Hex(Buffer.from(input.payloadChecksum, "hex"));
      if (payloadChecksum !== input.payloadChecksum) {
        throw new PersistenceValidationError("Invalid webhook payload checksum.");
      }
      const keyHash = eventKeyHash(resourceId, eventDate);
      const resource = encryptField(options.keyring, resourceId, {
        tenantId: options.tenantId,
        table: "webhook_events",
        field: "resource_id",
        recordId: keyHash,
      });
      const receivedAt = now().toISOString();

      return withTenantTransaction(options.tenantId, options.db, async (tx) => {
        await lockTenantForUpdate(options.tenantId, tx);
        const inserted = await insertWebhookEvent(options.tenantId, tx, {
          eventKeyHash: keyHash,
          eventType: "voucher.created",
          resource,
          eventDate,
          receivedAt,
          payloadChecksum: input.payloadChecksum,
          source: "lexware_webhook",
          requestBudgetStatus: "NOT_APPLICABLE",
          qualityStatus: "STRUCTURED",
        });
        const count = await countPendingWebhookEvents(options.tenantId, tx);
        if (count > MAX_PENDING_VOUCHER_EVENTS) {
          throw new PendingVoucherCapacityError();
        }
        return Object.freeze({ added: inserted.inserted, count, dropped: 0 });
      });
    },

    async list() {
      return withTenantTransaction(options.tenantId, options.db, async (tx) => {
        const rows = await listPendingWebhookEvents(
          options.tenantId,
          tx,
          MAX_PENDING_VOUCHER_EVENTS,
        );
        return Object.freeze(
          rows.map((row) => {
            const resourceId = validateResourceId(
              decryptField(options.keyring, row.resource, {
                tenantId: options.tenantId,
                table: "webhook_events",
                field: "resource_id",
                recordId: row.eventKeyHash,
              }),
            );
            return Object.freeze({
              eventType: "voucher.created" as const,
              resourceId,
              eventDate: row.eventDate,
              receivedAt: row.receivedAt,
            });
          }),
        );
      });
    },

    async acknowledge(resourceIdInput: string) {
      const resourceId = validateResourceId(resourceIdInput);
      const acknowledgedAt = now().toISOString();

      return withTenantTransaction(options.tenantId, options.db, async (tx) => {
        await lockTenantForUpdate(options.tenantId, tx);
        const rows = await listPendingWebhookEvents(
          options.tenantId,
          tx,
          MAX_PENDING_VOUCHER_EVENTS,
        );
        let removed = 0;
        for (const row of rows) {
          const storedResourceId = validateResourceId(
            decryptField(options.keyring, row.resource, {
              tenantId: options.tenantId,
              table: "webhook_events",
              field: "resource_id",
              recordId: row.eventKeyHash,
            }),
          );
          if (storedResourceId !== resourceId) continue;
          const result = await acknowledgeWebhookEvent(
            options.tenantId,
            tx,
            row.eventKeyHash,
            acknowledgedAt,
          );
          if (result.acknowledged) removed += 1;
        }

        const remaining = await countPendingWebhookEvents(options.tenantId, tx);
        return Object.freeze({ removed, remaining });
      });
    },

    droppedTotal() {
      return 0;
    },
  });
}
