export const PERSISTENCE_LIMITS = Object.freeze({
  pendingWebhookEventsPerTenant: 1_000,
  encryptedResourceIdBytes: 4_096,
  auditEventsPerTenant: 100_000,
});

export function assertWithinPersistenceLimit(
  label: keyof typeof PERSISTENCE_LIMITS,
  value: number,
): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid persistence limit value for ${label}.`);
  if (value > PERSISTENCE_LIMITS[label]) {
    throw new Error(`Persistence limit exceeded: ${label}.`);
  }
}
