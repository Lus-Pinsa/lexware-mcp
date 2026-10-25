/**
 * Every state-changing tool the server can register, across all tiers. `LEXWARE_WRITE_TOOLS` is validated
 * against this list at start-up, so a typo cannot silently disable the one intended tool (the server fails
 * closed with a configuration error instead of a quiet "0 write tools"). Kept in sync with the registered
 * tools by tests/write-guard.test.ts. Dependency-free so src/config.ts can import it.
 */
export const KNOWN_WRITE_TOOLS: readonly string[] = Object.freeze([
  // drafts tier
  "acknowledge-voucher-event",
  "create-article",
  "create-contact",
  "create-draft-credit-note",
  "create-draft-delivery-note",
  "create-draft-dunning",
  "create-draft-invoice",
  "create-draft-order-confirmation",
  "create-draft-quotation",
  "create-voucher",
  "ensure-lus-voucher-webhook",
  "update-article",
  "update-contact",
  "update-voucher",
  "upload-file",
  "upload-voucher-file",
  // finalize tier
  "create-event-subscription",
  "create-finalized-credit-note",
  "create-finalized-delivery-note",
  "create-finalized-dunning",
  "create-finalized-invoice",
  "create-finalized-order-confirmation",
  "create-finalized-quotation",
  "delete-article",
  "delete-event-subscription",
]);
