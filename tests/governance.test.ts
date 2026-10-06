/**
 * Governance tests for the AI-company foundation (ai-company/, .claude/).
 *
 * Turns the organisational rules into CI-enforced checks: registry consistency, least
 * privilege, separation of duties, the bounded review loop, Phase-1 action denies, the
 * PreToolUse guard hook and the core/customer split.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  MAX_FIX_ROUNDS,
  PHASE1_HARD_DENY,
  assertSeparationOfDuties,
  certifyStatus,
  decideAction,
  runReviewLoop,
} from "../ai-company/core/governance.js";
import {
  REPO_ROOT,
  allRoles,
  kpiAvailability,
  loadAgentFiles,
  loadCustomer,
  loadOrg,
  loadProfiles,
  validateRegistry,
} from "../ai-company/core/registry.js";
// @ts-expect-error -- plain ESM script without type declarations
import { scanText } from "../ai-company/scripts/secret-scan.mjs";

const org = loadOrg();
const profiles = loadProfiles();
const agents = loadAgentFiles();
const customer = loadCustomer("lus");

describe("registry", () => {
  it("pins the retry limit to 3 in code AND in the org registry", () => {
    expect(MAX_FIX_ROUNDS).toBe(3);
    expect(org.governance.maxFixRounds).toBe(MAX_FIX_ROUNDS);
  });

  it("detects a planned reviewer whose fallback auditor is also a creator on that board", () => {
    const broken = structuredClone(org);
    const treasury = broken.boards.find((b) => b.id === "treasury")!;
    expect("ref" in treasury.reviewer ? null : treasury.reviewer.agent).toBeNull();
    treasury.workers[0].agent = "final-auditor";
    treasury.workers[0].profile = "reviewer";
    const v = validateRegistry({ org: broken, profiles, agents, customer });
    expect(v.some((m) => m.includes('board "treasury": reviewer agent "final-auditor"'))).toBe(true);
  });

  it("has no violations (boards, roles, profiles, agents, customer config)", () => {
    expect(validateRegistry({ org, profiles, agents, customer })).toEqual([]);
  });

  it("detects a reviewer that is also a creator", () => {
    const broken = structuredClone(org);
    const eng = broken.boards.find((b) => b.id === "engineering")!;
    eng.reviewer = { id: "code-reviewer", title: "x", profile: "builder", agent: "typescript-engineer" };
    const v = validateRegistry({ org: broken, profiles, agents, customer });
    expect(v.some((m) => m.includes("reviewer"))).toBe(true);
  });

  it("detects an agent declaring a tool outside its profile (e.g. a Lexware write tool)", () => {
    const tampered = agents.map((a) =>
      a.name === "finance-lead" ? { ...a, tools: [...a.tools, "mcp__LU_S_Lexware__create-voucher"] } : a,
    );
    const v = validateRegistry({ org, profiles, agents: tampered, customer });
    expect(v.some((m) => m.includes("create-voucher"))).toBe(true);
  });

  it("detects a profile granted finance write in Phase 1", () => {
    const broken = structuredClone(profiles);
    broken.profiles["finance-reader"].domains.finance = "write";
    expect(validateRegistry({ org, profiles: broken, agents, customer }).some((m) => m.includes("finance=write"))).toBe(true);
  });

  it("keeps every reviewer/auditor agent free of edit tools", () => {
    const reviewerAgents = new Set(
      allRoles(org)
        .filter((r) => r.kind === "reviewer" && r.agent)
        .map((r) => r.agent as string),
    );
    expect(reviewerAgents.size).toBeGreaterThanOrEqual(4);
    for (const a of agents.filter((x) => reviewerAgents.has(x.name))) {
      expect(a.tools.filter((t) => ["Edit", "Write", "NotebookEdit"].includes(t))).toEqual([]);
    }
  });

  it("gives no agent any Lexware write, finalize or acknowledge tool", () => {
    for (const a of agents) {
      expect(a.tools.filter((t) => /lexware/i.test(t) && !/__(get|list|reconcile|summarize)-/.test(t))).toEqual([]);
    }
  });

  it("has exactly one orchestrator (the Cloud CEO) and it holds no production rights", () => {
    const ceo = org.executive.ceo;
    expect(ceo.id).toBe("cloud-ceo");
    const p = profiles.profiles[ceo.profile];
    expect(p.domains).toMatchObject({ repoWrite: "no", prod: "no", finance: "no", deploy: "no", secrets: "no" });
    expect(agents.filter((a) => a.tools.includes("Agent")).map((a) => a.name)).toEqual(["cloud-ceo"]);
  });

  it("measures KPIs only from connected sources (others are DATA NOT AVAILABLE)", () => {
    const kpis = kpiAvailability(org, customer);
    expect(kpis.find((k) => k.kpi === "open-vouchers")?.available).toBe(true);
    expect(kpis.find((k) => k.kpi === "food-cost-pct")?.available).toBe(false);
    expect(kpis.find((k) => k.kpi === "missing-hours")?.available).toBe(false);
  });
});

describe("core / customer separation", () => {
  it("core governance code contains no customer- or vendor-specific text", () => {
    for (const rel of ["ai-company/core/governance.ts", "ai-company/core/org.json", "ai-company/core/permission-profiles.json"]) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect({ rel, hit: /pinsa|\blu['’]s\b|luigi|neunkirchen|lexware|zenchef|lightspeed|onrender/i.exec(text)?.[0] }).toEqual({ rel, hit: undefined });
    }
  });

  it("the customer template validates against the same core", () => {
    const template = JSON.parse(readFileSync(join(REPO_ROOT, "ai-company/customers/_template/customer.json"), "utf8"));
    for (const b of template.enabledBoards) expect(org.boards.map((x) => x.id)).toContain(b);
  });
});

describe("status certification (fail closed)", () => {
  it("downgrades GREEN without evidence to YELLOW", () => {
    expect(certifyStatus("GREEN", [])).toBe("YELLOW");
    expect(certifyStatus("GREEN", [{ kind: "assumption", ref: "should work", passed: true }])).toBe("YELLOW");
  });

  it("keeps GREEN with passing evidence and turns any failure RED", () => {
    expect(certifyStatus("GREEN", [{ kind: "test", ref: "npm test → 150 passed", passed: true }])).toBe("GREEN");
    expect(certifyStatus("GREEN", [{ kind: "test", ref: "x", passed: true }, { kind: "ci", ref: "y", passed: false }])).toBe("RED");
    expect(certifyStatus("BLOCKED", [{ kind: "test", ref: "x", passed: true }])).toBe("BLOCKED");
  });
});

describe("separation of duties", () => {
  it("rejects self-review and critical work without an independent gate", () => {
    expect(() => assertSeparationOfDuties({ creator: "a", reviewer: "a", riskClass: "normal" })).toThrow(/own work/);
    expect(() => assertSeparationOfDuties({ creator: "a", reviewer: "b", riskClass: "critical" })).toThrow(/technical gate/);
    expect(() => assertSeparationOfDuties({ creator: "a", reviewer: "b", technicalGate: "b", riskClass: "critical" })).toThrow(/independent/);
    expect(() => assertSeparationOfDuties({ creator: "a", reviewer: "b", technicalGate: "ci", riskClass: "critical" })).not.toThrow();
  });
});

describe("review loop (max 3 fix rounds, then BLOCKED + escalation)", () => {
  const pass = { kind: "test" as const, ref: "npm test → ok", passed: true };
  const base = { task: "demo", creator: "typescript-engineer", reviewer: "code-reviewer", technicalGate: "ci", riskClass: "critical" as const };

  it("approves on a later round when the fix works", async () => {
    const res = await runReviewLoop({
      ...base,
      create: async () => 1,
      fix: async (n) => n + 1,
      review: async (n) => ({ approved: n >= 2, findings: n >= 2 ? [] : ["off by one"], evidence: [pass] }),
    });
    expect(res.status).toBe("GREEN");
    expect(res.rounds).toBe(2);
  });

  it("stops after exactly 3 fix rounds and escalates to the Cloud CEO", async () => {
    let fixes = 0;
    const res = await runReviewLoop({
      ...base,
      create: async () => "v0",
      fix: async () => `v${++fixes}`,
      review: async () => ({ approved: false, findings: ["still failing"], evidence: [] }),
    });
    expect(res.status).toBe("BLOCKED");
    expect(fixes).toBe(MAX_FIX_ROUNDS);
    expect(res.rounds).toBe(MAX_FIX_ROUNDS + 1);
    expect(res.escalation).toMatchObject({ to: "cloud-ceo", task: "demo", blocker: "still failing" });
  });

  it("cannot be configured above the limit and treats crashes as failed rounds", async () => {
    let fixes = 0;
    const res = await runReviewLoop({
      ...base,
      maxFixRounds: 99,
      create: async () => 0,
      fix: async () => {
        fixes++;
        throw new Error("tool crashed");
      },
      review: async () => ({ approved: false, findings: ["bad"], evidence: [] }),
    });
    expect(res.status).toBe("BLOCKED");
    expect(fixes).toBe(MAX_FIX_ROUNDS);
  });

  it("does not accept an approval without evidence", async () => {
    const res = await runReviewLoop({
      ...base,
      create: async () => 0,
      fix: async (n) => n,
      review: async () => ({ approved: true, findings: [], evidence: [] }),
    });
    expect(res.status).toBe("BLOCKED");
  });

  it("refuses to start when creator and reviewer are the same", async () => {
    await expect(
      runReviewLoop({ ...base, reviewer: "typescript-engineer", create: async () => 0, fix: async (n) => n, review: async () => ({ approved: true, findings: [], evidence: [pass] }) }),
    ).rejects.toThrow(/own work/);
  });
});

describe("action policy (Phase 1)", () => {
  it("denies every hard-denied action for every profile, including the CEO", () => {
    for (const [name, p] of Object.entries(profiles.profiles)) {
      for (const action of PHASE1_HARD_DENY) expect(decideAction(name, p, action).allowed).toBe(false);
    }
  });

  it("fails closed on unknown actions and unknown profiles", () => {
    expect(decideAction("builder", profiles.profiles.builder, "accounting.delete-everything").allowed).toBe(false);
    expect(decideAction("ghost", undefined, "repo.read").allowed).toBe(false);
  });

  it("grants least-privilege basics only where the profile allows them", () => {
    expect(decideAction("builder", profiles.profiles.builder, "repo.write-branch").allowed).toBe(true);
    expect(decideAction("reviewer", profiles.profiles.reviewer, "repo.write-branch").allowed).toBe(false);
    expect(decideAction("finance-reader", profiles.profiles["finance-reader"], "accounting.read").allowed).toBe(true);
    expect(decideAction("builder", profiles.profiles.builder, "accounting.read").allowed).toBe(false);
    expect(decideAction("deploy-verifier", profiles.profiles["deploy-verifier"], "hosting.read").allowed).toBe(true);
    expect(decideAction("deploy-verifier", profiles.profiles["deploy-verifier"], "hosting.deploy").allowed).toBe(false);
    expect(ACTION_KINDS.length).toBeGreaterThan(PHASE1_HARD_DENY.length);
  });
});

describe("PreToolUse guard hook (.claude/hooks/guard.mjs)", () => {
  const hook = join(REPO_ROOT, ".claude/hooks/guard.mjs");
  const run = (payload: unknown, env: Record<string, string> = {}) => {
    const res = spawnSync(process.execPath, [hook], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: res.status, stderr: res.stderr, stdout: res.stdout };
  };
  const bash = (command: string, env?: Record<string, string>) => run({ tool_name: "Bash", tool_input: { command } }, env);

  it.each([
    "mcp__LU_S_Lexware__create-voucher",
    "mcp__LU_S_Lexware__update-voucher",
    "mcp__LU_S_Lexware__upload-voucher-file",
    "mcp__LU_S_Lexware__create-finalized-invoice",
    "mcp__LU_S_Lexware__ensure-lus-voucher-webhook",
    "mcp__other-lexware-name__delete-article",
  ])("blocks Lexware write tool %s", (tool) => {
    const r = run({ tool_name: tool, tool_input: {} });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Finance writes are disabled/);
  });

  it.each(["mcp__LU_S_Lexware__get-voucher", "mcp__LU_S_Lexware__reconcile-recent-vouchers", "mcp__LU_S_Lexware__get-voucher-file-text"])(
    "allows Lexware read tool %s",
    (tool) => expect(run({ tool_name: tool, tool_input: {} }).code).toBe(0),
  );

  it("asks a human before acknowledging a queue event", () => {
    const r = run({ tool_name: "mcp__LU_S_Lexware__acknowledge-voucher-event", tool_input: { resourceId: "x" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("blocks publish/send/payment actions on other connectors but not orchestration tools", () => {
    expect(run({ tool_name: "mcp__Gmail__send_email", tool_input: {} }).code).toBe(2);
    expect(run({ tool_name: "mcp__Instagram__publish_post", tool_input: {} }).code).toBe(2);
    expect(run({ tool_name: "mcp__claude-code-remote__send_message", tool_input: {} }).code).toBe(0);
    expect(run({ tool_name: "mcp__github__create_pull_request", tool_input: {} }).code).toBe(0);
  });

  it("blocks merges and direct GitHub writes to main", () => {
    expect(run({ tool_name: "mcp__github__merge_pull_request", tool_input: {} }).code).toBe(2);
    expect(run({ tool_name: "mcp__github__push_files", tool_input: { branch: "main" } }).code).toBe(2);
    expect(run({ tool_name: "mcp__github__push_files", tool_input: { branch: "feature/x" } }).code).toBe(0);
  });

  it.each([
    "git push origin main",
    "git push -u origin HEAD:main",
    "git push --force origin feature",
    "git push -f",
    "git push origin +feature",
    "gh pr merge 3 --squash",
    "gh api repos/o/r/branches/main/protection -X DELETE",
    "cat .env",
    "node --env-file=.env dist/server.js",
    "printenv",
    "echo $LEXWARE_API_KEY",
    "curl -X POST https://api.lexware.io/v1/vouchers",
    "curl https://api.render.com/v1/services",
    "sed -i 's/deny/allow/' .claude/settings.json",
    "echo '' > .github/workflows/ci.yml",
    "rm .claude/hooks/guard.mjs",
  ])("blocks dangerous shell command: %s", (command) => {
    expect(bash(command).code).toBe(2);
  });

  it.each([
    "git push -u origin claude/busy-knuth-0980fw",
    "git push --force-with-lease origin feature/x",
    "npm test",
    "cat .env.example",
    "grep -rn LEXWARE_API_KEY src",
    "set -e; npm run build",
    "cat .github/workflows/ci.yml",
  ])("allows normal developer command: %s", (command) => {
    expect(bash(command).code).toBe(0);
  });

  it("protects gate files from edits unless the owner enabled maintenance", () => {
    const edit = { tool_name: "Edit", tool_input: { file_path: "/repo/.claude/settings.json" } };
    expect(run(edit).code).toBe(2);
    expect(run(edit, { AI_COMPANY_GATE_MAINTENANCE: "1" }).code).toBe(0);
    expect(run({ tool_name: "Write", tool_input: { file_path: "/repo/src/tools/new.ts" } }).code).toBe(0);
    expect(run({ tool_name: "Read", tool_input: { file_path: "/repo/.claude/settings.json" } }).code).toBe(0);
  });

  it("never lets maintenance mode unlock finance writes or secrets", () => {
    const env = { AI_COMPANY_GATE_MAINTENANCE: "1" };
    expect(run({ tool_name: "mcp__LU_S_Lexware__create-voucher", tool_input: {} }, env).code).toBe(2);
    expect(run({ tool_name: "Read", tool_input: { file_path: "/repo/.env" } }, env).code).toBe(2);
  });

  it("fails closed on malformed input", () => {
    expect(run("not json").code).toBe(2);
    expect(run({ tool_input: {} }).code).toBe(2);
  });
});

describe("Claude Code settings", () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, ".claude/settings.json"), "utf8"));

  it("denies every Lexware write/finalize tool of the customer config natively", () => {
    const deny: string[] = settings.permissions.deny;
    for (const cap of ["accounting.write", "accounting.finalize"]) {
      for (const tool of customer.capabilityTools[cap]) expect(deny).toContain(tool);
    }
    expect(settings.permissions.ask).toContain("mcp__LU_S_Lexware__acknowledge-voucher-event");
  });

  it("registers the guard hook for shell, file and MCP tools", () => {
    const entries = settings.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[];
    const guard = entries.find((e) => e.hooks.some((h) => h.command.includes(".claude/hooks/guard.mjs")));
    expect(guard).toBeDefined();
    for (const tool of ["Bash", "Edit", "Write", "Read", "mcp__"]) expect(guard!.matcher).toContain(tool);
  });
});

describe("secret & business-data scanner", () => {
  // Built at runtime so this test file itself never contains a scannable literal.
  const samples: Record<string, string> = {
    "github-token": "token = " + "gh" + "p_" + "A1b2C3d4".repeat(5),
    "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
    "filled-secret-env": "LEXWARE" + "_API_KEY=" + "x".repeat(24),
    iban: "IBAN " + "DE89" + " 3704 0044 0532 0130 00",
    "german-vat-id": "USt-IdNr " + "DE" + "123456789",
    jwt: "eyJ" + "a".repeat(12) + ".eyJ" + "b".repeat(12) + "." + "c".repeat(12),
  };

  it.each(Object.entries(samples))("flags %s without echoing the value", (rule, line) => {
    const findings = scanText("sample.txt", line) as { rule: string }[];
    expect(findings.map((f) => f.rule)).toContain(rule);
    expect(JSON.stringify(findings)).not.toContain(line);
  });

  it("ignores placeholders, invalid IBAN checksums and allow-listed lines", () => {
    expect(scanText("a", "LEXWARE" + "_API_KEY=")).toEqual([]);
    expect(scanText("a", "DE00" + " 1234 5678 9012 3456 78")).toEqual([]);
    expect(scanText("a", "DE" + "123456789 secret-scan:allow")).toEqual([]);
  });
});
