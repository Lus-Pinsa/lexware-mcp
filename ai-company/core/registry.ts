/**
 * Loader + validator for the AI-company registry (org.json, permission-profiles.json, agent
 * files, customer config). `validateRegistry()` returns human-readable violations; CI fails on
 * any violation via tests/governance.test.ts, so governance rules are enforced technically,
 * not only by prompts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface Role {
  id: string;
  title: string;
  profile: string;
  agent: string | null;
}

export interface Board {
  id: string;
  name: string;
  group: "foundation" | "business";
  mandate: string;
  riskClass: "critical" | "normal";
  status: "foundation-ready" | "partial" | "structure-ready" | "not-built" | "blocked";
  technicalGate: string | null;
  lead: Role;
  workers: Role[];
  reviewer: Role | { ref: string };
  kpis: { id: string; name: string; source: string }[];
  hardLimits: string[];
}

export interface Org {
  version: number;
  phase: string;
  governance: { maxFixRounds: number; statuses: string[]; greenRequiresEvidence: boolean; failClosed: boolean };
  executive: { ceo: Role; staffFunctions: { id: string; title: string; policy: string }[] };
  boards: Board[];
}

export interface Profile {
  description: string;
  claudeTools: string[];
  connectorCapabilities: string[];
  domains: Record<string, string>;
}

export interface Profiles {
  domains: string[];
  profiles: Record<string, Profile>;
  forbiddenInPhase1: {
    domainValues: Record<string, string[]>;
    capabilities: string[];
    claudeToolsForReviewers: string[];
  };
}

export interface Customer {
  customerId: string;
  enabledBoards: string[];
  connectors: Record<string, { system: string; status: string; capabilities: string[] }>;
  capabilityTools: Record<string, string[]>;
}

export interface AgentFile {
  file: string;
  name: string;
  description: string;
  tools: string[];
  model: string | undefined;
}

export function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8")) as T;
}

export function loadOrg(): Org {
  return readJson<Org>("ai-company/core/org.json");
}

export function loadProfiles(): Profiles {
  return readJson<Profiles>("ai-company/core/permission-profiles.json");
}

export function loadCustomer(id: string): Customer {
  return readJson<Customer>(`ai-company/customers/${id}/customer.json`);
}

/** Minimal frontmatter parser for `.claude/agents/*.md` (flat `key: value` lines). */
export function parseAgentFile(file: string, content: string): AgentFile {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) throw new Error(`${file}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    file,
    name: fields.name ?? "",
    description: fields.description ?? "",
    tools: (fields.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    model: fields.model,
  };
}

export function loadAgentFiles(): AgentFile[] {
  const dir = join(REPO_ROOT, ".claude/agents");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseAgentFile(f, readFileSync(join(dir, f), "utf8")));
}

/** All roles of the org (CEO + lead/workers/inline reviewers of every board). */
export function allRoles(org: Org): (Role & { board: string; kind: "ceo" | "lead" | "worker" | "reviewer" })[] {
  const out: (Role & { board: string; kind: "ceo" | "lead" | "worker" | "reviewer" })[] = [
    { ...org.executive.ceo, board: "executive", kind: "ceo" },
  ];
  for (const b of org.boards) {
    out.push({ ...b.lead, board: b.id, kind: "lead" });
    for (const w of b.workers) out.push({ ...w, board: b.id, kind: "worker" });
    if (!("ref" in b.reviewer)) out.push({ ...b.reviewer, board: b.id, kind: "reviewer" });
  }
  return out;
}

const REQUIRED_BOARDS = [
  "engineering", "security", "qa-audit", "devops", "knowledge", "finance", "treasury", "costing",
  "purchasing", "hr-payroll", "daily-coo", "inventory", "food-safety", "crm", "marketing",
  "seo-growth", "sales", "operations", "technology-radar",
];

/** Allowed board statuses (see the $comment in org.json). */
export const BOARD_STATUSES: readonly Board["status"][] = ["foundation-ready", "partial", "structure-ready", "not-built", "blocked"];

/** Generic read-only agent for planned roles; a board led only by it is structure-only. */
export const GENERIC_ANALYST_AGENT = "board-analyst";

/** Agent that executes reviewer roles which have no dedicated agent yet. */
export const REVIEWER_FALLBACK_AGENT = "final-auditor";

/** Strings that would tie the core to one customer or vendor (multi-tenant guard). */
export const CORE_FORBIDDEN_PATTERN = /pinsa|pinsaboys|\blu['’]s\b|luigi|neunkirchen|lexware|lexoffice|lightspeed|zenchef|onrender/i;

export function validateRegistry(input: {
  org: Org;
  profiles: Profiles;
  agents: AgentFile[];
  customer: Customer;
}): string[] {
  const { org, profiles, agents, customer } = input;
  const v: string[] = [];
  const roles = allRoles(org);
  const roleById = new Map<string, (typeof roles)[number]>();
  const agentByName = new Map(agents.map((a) => [a.name, a]));

  // Governance constants.
  if (org.governance.maxFixRounds !== 3) v.push("governance.maxFixRounds must be 3");
  if (!org.governance.greenRequiresEvidence) v.push("governance.greenRequiresEvidence must be true");
  if (!org.governance.failClosed) v.push("governance.failClosed must be true");

  // Board completeness.
  const boardIds = org.boards.map((b) => b.id);
  for (const id of REQUIRED_BOARDS) if (!boardIds.includes(id)) v.push(`missing board "${id}"`);
  if (new Set(boardIds).size !== boardIds.length) v.push("duplicate board ids");

  // Role uniqueness + profile existence.
  for (const r of roles) {
    if (roleById.has(r.id)) v.push(`duplicate role id "${r.id}"`);
    roleById.set(r.id, r);
    if (!profiles.profiles[r.profile]) v.push(`role "${r.id}" uses unknown profile "${r.profile}"`);
    if (r.agent !== null && !agentByName.has(r.agent)) v.push(`role "${r.id}" references missing agent file "${r.agent}"`);
  }

  // Per-board structure and separation of duties.
  for (const b of org.boards) {
    if (b.workers.length === 0) v.push(`board "${b.id}" has no workers`);
    const reviewerId = "ref" in b.reviewer ? b.reviewer.ref : b.reviewer.id;
    const reviewer = roleById.get(reviewerId);
    if (!reviewer) {
      v.push(`board "${b.id}" reviewer "${reviewerId}" does not exist`);
    } else {
      const creators = [b.lead, ...b.workers];
      if (creators.some((c) => c.id === reviewerId)) v.push(`board "${b.id}": reviewer is also a creator`);
      // A planned reviewer (agent null) is executed by the final auditor; it must still be independent.
      const reviewerAgent = reviewer.agent ?? REVIEWER_FALLBACK_AGENT;
      if (!agentByName.has(reviewerAgent)) v.push(`board "${b.id}": reviewer agent "${reviewerAgent}" does not exist`);
      if (creators.some((c) => c.agent === reviewerAgent)) {
        v.push(`board "${b.id}": reviewer agent "${reviewerAgent}" is also used by a creator`);
      }
      const rp = profiles.profiles[reviewer.profile];
      if (rp && rp.domains.repoWrite !== "no") v.push(`board "${b.id}": reviewer profile "${reviewer.profile}" can write the repo`);
      if (rp && rp.claudeTools.some((t) => profiles.forbiddenInPhase1.claudeToolsForReviewers.includes(t))) {
        v.push(`board "${b.id}": reviewer profile "${reviewer.profile}" has edit tools`);
      }
    }
    if (b.riskClass === "critical" && !b.technicalGate) v.push(`critical board "${b.id}" has no technical gate`);
    // A board led by the generic analyst, or without any dedicated executable agent, has no data source
    // of its own: it must not be presented as ready.
    const dedicated = (r: Role) => r.agent !== null && r.agent !== GENERIC_ANALYST_AGENT;
    const genericOnly = b.lead.agent === GENERIC_ANALYST_AGENT || ![b.lead, ...b.workers].some(dedicated);
    if (!BOARD_STATUSES.includes(b.status)) v.push(`board "${b.id}" has unknown status "${b.status}"`);
    if (genericOnly && (b.status === "foundation-ready" || b.status === "partial")) {
      v.push(`board "${b.id}" is led only by "${b.lead.agent ?? "nobody"}" but claims status "${b.status}" (use structure-ready)`);
    }
    if (b.kpis.length === 0) v.push(`board "${b.id}" has no KPIs`);
    if (b.hardLimits.length === 0) v.push(`board "${b.id}" has no hard limits`);
  }

  // Phase-1 permission ceilings.
  const forb = profiles.forbiddenInPhase1;
  for (const [name, p] of Object.entries(profiles.profiles)) {
    for (const d of profiles.domains) {
      if (!(d in p.domains)) v.push(`profile "${name}" lacks domain "${d}"`);
      if ((forb.domainValues[d] ?? []).includes(p.domains[d])) v.push(`profile "${name}" has forbidden ${d}=${p.domains[d]}`);
    }
    for (const c of p.connectorCapabilities) {
      if (forb.capabilities.includes(c)) v.push(`profile "${name}" grants forbidden capability "${c}"`);
    }
  }

  // Agent files: every agent is registered, its tools stay inside its profile(s).
  const roleProfilesByAgent = new Map<string, Set<string>>();
  for (const r of roles) {
    if (r.agent) {
      const set = roleProfilesByAgent.get(r.agent) ?? new Set<string>();
      set.add(r.profile);
      roleProfilesByAgent.set(r.agent, set);
    }
  }
  for (const a of agents) {
    if (`${a.name}.md` !== a.file) v.push(`agent file "${a.file}" declares name "${a.name}"`);
    if (!a.description) v.push(`agent "${a.name}" has no description`);
    if (a.tools.length === 0) v.push(`agent "${a.name}" must declare an explicit tools list`);
    const profileNames = roleProfilesByAgent.get(a.name);
    if (!profileNames) {
      v.push(`agent "${a.name}" is not referenced by any role (unknown permissions)`);
      continue;
    }
    if (profileNames.size > 1) v.push(`agent "${a.name}" is used with several profiles: ${[...profileNames].join(", ")}`);
    const [profileName] = [...profileNames];
    const p = profiles.profiles[profileName];
    if (!p) continue;
    const allowed = new Set(p.claudeTools);
    for (const cap of p.connectorCapabilities) for (const t of customer.capabilityTools[cap] ?? []) allowed.add(t);
    for (const t of a.tools) {
      if (!allowed.has(t)) v.push(`agent "${a.name}" declares tool "${t}" outside profile "${profileName}"`);
    }
  }

  // Customer config sanity.
  for (const b of customer.enabledBoards) if (!boardIds.includes(b)) v.push(`customer enables unknown board "${b}"`);
  for (const cap of forb.capabilities) {
    const tools = customer.capabilityTools[cap] ?? [];
    for (const a of agents) {
      for (const t of a.tools) if (tools.includes(t)) v.push(`agent "${a.name}" holds forbidden ${cap} tool "${t}"`);
    }
  }

  // Multi-tenant guard: core files must not name a customer or vendor.
  for (const rel of ["ai-company/core/org.json", "ai-company/core/permission-profiles.json"]) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    if (CORE_FORBIDDEN_PATTERN.test(text)) v.push(`${rel} contains customer/vendor-specific text`);
  }

  return v;
}

/** KPI availability for a customer: a KPI is measurable only if its source capability is connected. */
export function kpiAvailability(org: Org, customer: Customer): { board: string; kpi: string; available: boolean }[] {
  const connected = new Set<string>();
  for (const c of Object.values(customer.connectors)) {
    if (c.status.startsWith("verified")) for (const cap of c.capabilities) connected.add(cap);
  }
  return org.boards.flatMap((b) => b.kpis.map((k) => ({ board: b.id, kpi: k.id, available: connected.has(k.source) })));
}
