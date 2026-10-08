import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

describe("Docker image (security architecture gate SUP-05/06/08)", () => {
  const dockerfile = read("Dockerfile");
  const froms = dockerfile.split("\n").filter((l) => /^FROM\s/i.test(l));

  it("pins every stage to Node 24 LTS by digest (the line CI tests on)", () => {
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const line of froms) expect(line).toMatch(/^FROM node:24-slim@sha256:[0-9a-f]{64}\s+AS\s+\w+$/);
    // All stages use the same digest.
    expect(new Set(froms.map((l) => l.match(/@sha256:([0-9a-f]{64})/)?.[1])).size).toBe(1);
  });

  it("matches the Node major CI runs the tests on", () => {
    expect(read(".github/workflows/ci.yml")).toMatch(/node-version:\s*"24"/);
  });

  it("disables skybridge telemetry in the runtime stage and runs as non-root", () => {
    const runtime = dockerfile.slice(dockerfile.search(/^FROM .* AS runtime$/m));
    expect(runtime).toMatch(/^ENV SKYBRIDGE_TELEMETRY_DISABLED=1$/m);
    expect(runtime).toMatch(/^ENV DO_NOT_TRACK=1$/m);
    expect(runtime).toMatch(/^USER node$/m);
  });
});

describe("Dependabot (SUP-04)", () => {
  it("never proposes a Node major bump of the docker image automatically", () => {
    const yml = read(".github/dependabot.yml");
    const docker = yml.slice(yml.indexOf("package-ecosystem: docker"));
    expect(docker).toMatch(/ignore:\s*\n\s*- dependency-name: "node"\s*\n\s*update-types: \["version-update:semver-major"\]/);
  });
});

describe("Target ruleset (SUP-01, owner action O-1)", () => {
  const ruleset = JSON.parse(read("ai-company/github/ruleset-main.json")) as {
    bypass_actors: unknown[];
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  };
  const rule = (type: string) => ruleset.rules.find((r) => r.type === type);
  const checks = () =>
    rule("required_status_checks")!.parameters!.required_status_checks as Array<{ context: string; integration_id: number }>;

  it("requires all CI gates from GitHub Actions and blocks force-push, deletion and high code-scanning alerts", () => {
    expect(ruleset.bypass_actors).toEqual([]);
    expect(rule("deletion")).toBeDefined();
    expect(rule("non_fast_forward")).toBeDefined();
    expect(checks().map((c) => c.context).sort()).toEqual(
      [
        "analyze",
        "audit (production dependencies)",
        "build-test (typecheck, tests, governance)",
        "dependency-review (new dependencies in PR)",
        "docker",
        "secret-scan (credentials + business data)",
      ].sort(),
    );
    for (const c of checks()) expect(c.integration_id).toBe(15368);
    expect(rule("required_status_checks")!.parameters!.strict_required_status_checks_policy).toBe(true);
    expect(rule("code_scanning")!.parameters!.code_scanning_tools).toEqual([
      { tool: "CodeQL", alerts_threshold: "errors", security_alerts_threshold: "high_or_higher" },
    ]);
  });

  it("names only check contexts that the workflows actually define", () => {
    const workflows = read(".github/workflows/ci.yml") + read(".github/workflows/codeql.yml");
    for (const { context } of checks()) {
      const jobDefined = context === "analyze" || context === "docker" ? `${context}:` : `name: ${context}`;
      expect(workflows, context).toContain(jobDefined);
    }
  });
});
