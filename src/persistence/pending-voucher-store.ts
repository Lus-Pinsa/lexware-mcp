import {
  MAX_PENDING_VOUCHER_EVENTS,
  type PendingVoucherEventStore,
  validatePendingVoucherEventDate,
  validatePendingVoucherResourceId,
} from "../pending-voucher-store.js";
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
  assertSha256Hex,
} from "./types.js";

export class PendingVoucherCapacityError extends Error {
  constructor() {
    super("Durable pending voucher queue is at capacity.");
    this.name = "PendingVoucherCapacityError";
  }
}

function eventKeyHash(resourceId: string, eventDate: string): string {
  return sha256Hex(["voucher.created", resourceId, eventDate].join("|"));
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

    async enqueue(input: {
      readonly resourceId: string;
      readonly eventDate: string;
      readonly payloadChecksum: string;
    }) {
      const resourceId = validatePendingVoucherResourceId(input.resourceId);
      const eventDate = validatePendingVoucherEventDate(input.eventDate);
      const payloadChecksum = assertSha256Hex(
        input.payloadChecksum,
        "webhook payload checksum",
      );
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
          payloadChecksum,
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
            const resourceId = validatePendingVoucherResourceId(
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
      const resourceId = validatePendingVoucherResourceId(resourceIdInput);
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
          const storedResourceId = validatePendingVoucherResourceId(
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
