import { randomUUID } from "node:crypto";
import { appendAuditEvent, type PersistenceDatabase, withTenantTransaction } from "./repository.js";
import {
  deleteExpiredAcknowledgedWebhookEvents,
  deleteExpiredAuditEvents,
} from "./maintenance-repository.js";
import { type TenantId, parseTenantId } from "./types.js";

export const WEBHOOK_RETENTION_DAYS = 30;
export const AUDIT_RETENTION_YEARS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionCutoffs {
  readonly webhookBefore: string;
  readonly auditBefore: string;
}

function oneCalendarYearBefore(now: Date): Date {
  const targetYear = now.getUTCFullYear() - 1;
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const result = new Date(now.getTime());
  result.setUTCFullYear(targetYear, month, 1);
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function retentionCutoffs(now: Date): RetentionCutoffs {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid retention clock.");
  return Object.freeze({
    webhookBefore: new Date(time - WEBHOOK_RETENTION_DAYS * DAY_MS).toISOString(),
    auditBefore: oneCalendarYearBefore(now).toISOString(),
  });
}

export async function runTenantRetention(options: {
  readonly db: PersistenceDatabase;
  readonly tenantId: TenantId;
  readonly actorHash: string;
  readonly now?: () => Date;
  readonly makeAuditId?: () => string;
}): Promise<{
  readonly webhookDeleted: number;
  readonly auditDeleted: number;
}> {
  const tenantId = parseTenantId(options.tenantId);
  const now = options.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const cutoffs = retentionCutoffs(now);
  const auditId = (options.makeAuditId ?? randomUUID)();

  return options.db.transaction(async (tx) => {
    // Bind the maintenance transaction to exactly one tenant. The maintenance
    // role may have DELETE rights, but RLS remains a second line of defense.
    await tx.query({
      text: "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
      values: [tenantId],
    });

    const webhookDeleted = await deleteExpiredAcknowledgedWebhookEvents(
      tenantId,
      tx,
      cutoffs.webhookBefore,
    );
    const auditDeleted = await deleteExpiredAuditEvents(
      tenantId,
      tx,
      cutoffs.auditBefore,
      nowIso,
    );

    await appendAuditEvent(tenantId, tx, {
      auditId,
      actorHash: options.actorHash,
      action: "retention.run",
      result: "SUCCESS",
      itemCount: webhookDeleted + auditDeleted,
      createdAt: nowIso,
    });

    return Object.freeze({ webhookDeleted, auditDeleted });
  });
}
