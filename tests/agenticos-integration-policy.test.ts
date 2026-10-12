import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

describe("AgenticOS / Claude Code stage-0 integration contract", () => {
  const skill = read(".claude/skills/agenticos/SKILL.md");
  const plan = read("ai-company/integrations/agenticos/README.md");

  it("is a manually invoked Claude Code project skill, not an auto-start task", () => {
    expect(skill).toMatch(/^---\nname: agenticos\n/);
    expect(skill).toMatch(/\ndisable-model-invocation: true\n---\n/);
    expect(skill).toContain("/agenticos");
    expect(skill).toContain("not installed".replace("not installed", "not the AgenticOS runtime"));
  });

  it("does not mistake the runtime for a Claude Code MCP server", () => {
    expect(plan).toMatch(/consumes remote MCP servers/);
    expect(plan).toMatch(/Do \*\*not\*\* register an invented/);
    expect(plan).toContain("not installed");
    expect(plan).toContain("synthetic");
  });

  it("preserves owner approval, independent review and no-production gates", () => {
    expect(skill).toContain("owner's separate");
    expect(skill).toContain("implementer must not");
    expect(plan).toContain("No Stage 2+ action is authorized");
    expect(plan).toContain("Never request keys in chat");
    expect(plan).toContain("no implicit rollout");
  });

  it("does not embed a bootstrap command, plaintext credentials or host access", () => {
    for (const document of [skill, plan]) {
      expect(document).not.toMatch(/curl[^\n]*\|\s*(?:bash|sh)/);
      expect(document).not.toMatch(/docker\s+compose\s+up/);
      expect(document).not.toMatch(/(?:sk-ant-|sk-proj-|ghp_)[A-Za-z0-9]{8}/);
      expect(document).not.toMatch(/--dangerously-skip-permissions/);
    }
  });

  it("keeps existing project safety hooks in place", () => {
    const settings = JSON.parse(read(".claude/settings.json")) as {
      hooks: { PreToolUse: readonly unknown[] };
    };
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(read(".claude/rules/ai-company-hard-rules.md")).toContain("Phase 1 forbids");
  });
});
