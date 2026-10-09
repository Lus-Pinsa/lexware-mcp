export const WEBHOOK_RETENTION_DAYS = 30;
export const AUDIT_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionCutoffs {
  webhookBefore: string;
  auditBefore: string;
}

/** UTC cutoffs for the daily/startup retention job. */
export function retentionCutoffs(now: Date): RetentionCutoffs {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error("Invalid retention clock.");
  return {
    webhookBefore: new Date(t - WEBHOOK_RETENTION_DAYS * DAY_MS).toISOString(),
    auditBefore: new Date(t - AUDIT_RETENTION_DAYS * DAY_MS).toISOString(),
  };
}
