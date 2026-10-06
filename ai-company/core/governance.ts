/**
 * Governance core of the AI company — deterministic, customer-agnostic rules that must not
 * depend on an LLM's judgement:
 *
 * - status certification (GREEN only with passing evidence; fail closed otherwise)
 * - separation of duties (creator != reviewer != technical gate)
 * - the bounded review loop (max 3 automatic fix rounds, then BLOCKED + escalation)
 * - action policy decisions (Phase-1 hard denies; unknown actions/profiles are denied)
 *
 * Pure TypeScript, no I/O — used by tests/governance.test.ts and by any future orchestrator.
 */

export type Status = "GREEN" | "YELLOW" | "RED" | "BLOCKED";

export const MAX_FIX_ROUNDS = 3;

export interface Evidence {
  /** What kind of proof this is. "assumption" never counts as proof. */
  kind: "test" | "ci" | "command" | "api-read" | "file-ref" | "assumption";
  /** Reproducible reference, e.g. "npm test → 135 passed" or "src/config.ts:250". */
  ref: string;
  passed: boolean;
}

/**
 * Certify a claimed status against its evidence (fail closed):
 * - any failing evidence → RED (BLOCKED stays BLOCKED)
 * - GREEN without at least one passing, non-assumption evidence → YELLOW
 * - anything else keeps the claimed status
 */
export function certifyStatus(claimed: Status, evidence: readonly Evidence[]): Status {
  if (claimed === "BLOCKED") return "BLOCKED";
  if (evidence.some((e) => !e.passed)) return "RED";
  if (claimed !== "GREEN") return claimed;
  const proven = evidence.some((e) => e.passed && e.kind !== "assumption" && e.ref.trim() !== "");
  return proven ? "GREEN" : "YELLOW";
}

export class SeparationOfDutiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeparationOfDutiesError";
  }
}

/**
 * Enforce creator != reviewer (and != technical gate for critical work).
 * Throws instead of returning a boolean so a caller cannot silently ignore a violation.
 */
export function assertSeparationOfDuties(roles: {
  creator: string;
  reviewer: string;
  technicalGate?: string | null;
  riskClass: "critical" | "normal";
}): void {
  const { creator, reviewer, technicalGate, riskClass } = roles;
  if (!creator || !reviewer) {
    throw new SeparationOfDutiesError("Creator and reviewer must both be named.");
  }
  if (creator === reviewer) {
    throw new SeparationOfDutiesError(`"${creator}" may not review its own work.`);
  }
  if (riskClass === "critical") {
    if (!technicalGate) {
      throw new SeparationOfDutiesError("Critical work requires a deterministic technical gate (e.g. CI).");
    }
    if (technicalGate === creator || technicalGate === reviewer) {
      throw new SeparationOfDutiesError("The technical gate must be independent of creator and reviewer.");
    }
  }
}

export interface ReviewVerdict {
  approved: boolean;
  findings: string[];
  evidence: Evidence[];
}

export interface Escalation {
  to: string;
  task: string;
  blocker: string;
  decisionNeeded: string;
  rounds: number;
}

export interface ReviewLoopResult<A> {
  status: Status;
  /** Number of review rounds executed (1 = approved on first review). */
  rounds: number;
  artifact: A | undefined;
  history: { round: number; approved: boolean; findings: string[]; error?: string }[];
  escalation?: Escalation;
}

export interface ReviewLoopOptions<A> {
  task: string;
  creator: string;
  reviewer: string;
  technicalGate?: string | null;
  riskClass: "critical" | "normal";
  create: () => Promise<A>;
  review: (artifact: A, round: number) => Promise<ReviewVerdict>;
  fix: (artifact: A, findings: string[], round: number) => Promise<A>;
  /** Defaults to and is capped at MAX_FIX_ROUNDS — callers cannot raise the limit. */
  maxFixRounds?: number;
  escalateTo?: string;
}

/**
 * Run TASK → CREATE → REVIEW → (FIX → REVIEW)* with at most `maxFixRounds` fix rounds.
 * Any thrown error counts as a failed round (unknown state is never GREEN). After the last
 * allowed round without approval the loop stops with BLOCKED and an escalation record.
 */
export async function runReviewLoop<A>(opts: ReviewLoopOptions<A>): Promise<ReviewLoopResult<A>> {
  assertSeparationOfDuties(opts);
  const maxFix = Math.min(Math.max(0, opts.maxFixRounds ?? MAX_FIX_ROUNDS), MAX_FIX_ROUNDS);
  const history: ReviewLoopResult<A>["history"] = [];
  let artifact: A | undefined;
  let lastFindings: string[] = [];

  try {
    artifact = await opts.create();
  } catch (err) {
    return blocked(opts, 0, undefined, [{ round: 0, approved: false, findings: [], error: errMsg(err) }], `creation failed: ${errMsg(err)}`);
  }

  // Round 1 is the initial review; rounds 2..maxFix+1 each follow one fix.
  for (let round = 1; round <= maxFix + 1; round++) {
    if (round > 1) {
      try {
        artifact = await opts.fix(artifact as A, lastFindings, round);
      } catch (err) {
        history.push({ round, approved: false, findings: lastFindings, error: `fix failed: ${errMsg(err)}` });
        continue;
      }
    }
    let verdict: ReviewVerdict;
    try {
      verdict = await opts.review(artifact as A, round);
    } catch (err) {
      history.push({ round, approved: false, findings: [], error: `review failed: ${errMsg(err)}` });
      lastFindings = [`review failed: ${errMsg(err)}`];
      continue;
    }
    history.push({ round, approved: verdict.approved, findings: verdict.findings });
    if (verdict.approved) {
      const status = certifyStatus("GREEN", verdict.evidence);
      if (status === "GREEN") return { status, rounds: round, artifact, history };
      lastFindings = ["approved without passing evidence"];
      continue;
    }
    lastFindings = verdict.findings.length > 0 ? verdict.findings : ["rejected without findings"];
  }

  return blocked(opts, history.length, artifact, history, lastFindings.join("; ") || "not approved");
}

function blocked<A>(
  opts: ReviewLoopOptions<A>,
  rounds: number,
  artifact: A | undefined,
  history: ReviewLoopResult<A>["history"],
  blocker: string,
): ReviewLoopResult<A> {
  return {
    status: "BLOCKED",
    rounds,
    artifact,
    history,
    escalation: {
      to: opts.escalateTo ?? "cloud-ceo",
      task: opts.task,
      blocker,
      decisionNeeded: `Owner decision required: accept the open findings, change scope, or assign a different approach for "${opts.task}".`,
      rounds,
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------------------------------ */
/* Action policy                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Actions an agent may request. Anything not listed is unknown and therefore denied. */
export const ACTION_KINDS = [
  "repo.read",
  "repo.write-branch",
  "repo.push-main",
  "repo.merge-pr",
  "repo.edit-gates",
  "tests.run",
  "web.read",
  "accounting.read",
  "accounting.write",
  "accounting.finalize",
  "accounting.queue-ack",
  "hosting.read",
  "hosting.deploy",
  "secrets.read",
  "payments.execute",
  "social.publish",
  "messaging.send",
  "purchasing.order",
  "pricing.change",
  "billing.purchase",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** Never allowed for any agent in Phase 1 — only via a later, separately approved module. */
export const PHASE1_HARD_DENY: readonly ActionKind[] = [
  "repo.push-main",
  "repo.merge-pr",
  "repo.edit-gates",
  "accounting.write",
  "accounting.finalize",
  "accounting.queue-ack",
  "hosting.deploy",
  "secrets.read",
  "payments.execute",
  "social.publish",
  "messaging.send",
  "purchasing.order",
  "pricing.change",
  "billing.purchase",
];

export interface ProfileLike {
  claudeTools: readonly string[];
  connectorCapabilities: readonly string[];
  domains: Record<string, string>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/** Decide whether a profile may perform an action. Fail closed on anything unknown. */
export function decideAction(profileName: string, profile: ProfileLike | undefined, action: string): PolicyDecision {
  if (!profile) return { allowed: false, reason: `unknown profile "${profileName}" (fail closed)` };
  if (!(ACTION_KINDS as readonly string[]).includes(action)) {
    return { allowed: false, reason: `unknown action "${action}" (fail closed)` };
  }
  const kind = action as ActionKind;
  if (PHASE1_HARD_DENY.includes(kind)) {
    return { allowed: false, reason: `"${kind}" is forbidden in Phase 1 for every agent` };
  }
  const tools = new Set(profile.claudeTools);
  const caps = new Set(profile.connectorCapabilities);
  switch (kind) {
    case "repo.read":
      return allow(tools.has("Read"), kind);
    case "repo.write-branch":
      return allow(profile.domains.repoWrite === "branch-only" && (tools.has("Edit") || tools.has("Write")), kind);
    case "tests.run":
      return allow(tools.has("Bash"), kind);
    case "web.read":
      return allow(tools.has("WebFetch") || tools.has("WebSearch"), kind);
    case "accounting.read":
      return allow(caps.has("accounting.read") && profile.domains.finance === "read-only", kind);
    case "hosting.read":
      return allow(caps.has("hosting.read") && profile.domains.prod === "read-only", kind);
    default:
      return { allowed: false, reason: `no rule for "${kind}" (fail closed)` };
  }
}

function allow(ok: boolean, kind: ActionKind): PolicyDecision {
  return ok ? { allowed: true, reason: `profile grants "${kind}"` } : { allowed: false, reason: `profile lacks "${kind}"` };
}
