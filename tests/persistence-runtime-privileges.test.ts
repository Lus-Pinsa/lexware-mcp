import { describe, expect, it } from "vitest";
import {
  assertLeastPrivilegeRuntimeRole,
} from "../src/persistence/runtime-privileges.js";
import type { RuntimePrivilegeSnapshot } from "../src/persistence/repository.js";

const good = (): RuntimePrivilegeSnapshot => ({
  roleName: "lus_runtime",
  isSuperuser: false,
  bypassRls: false,
  canCreateDatabase: false,
  canCreateRole: false,
  canCreateInDatabase: false,
  canCreateInPublicSchema: false,
  migrationsSelect: true,
  migrationsMutate: false,
  tenantsSelect: true,
  tenantsMutate: false,
  webhookDml: true,
  webhookDelete: false,
  auditAppend: true,
  auditMutate: false,
  auditAnchorSelect: true,
  auditAnchorMutate: false,
  roleMemberships: 0,
});

describe("runtime database privilege gate", () => {
  it("accepts only the exact least-privilege runtime role", () => {
    expect(() => assertLeastPrivilegeRuntimeRole(good(), "lus_runtime")).not.toThrow();
  });

  it.each([
    ["role mismatch", { roleName: "owner_role" }],
    ["superuser", { isSuperuser: true }],
    ["RLS bypass", { bypassRls: true }],
    ["create database", { canCreateDatabase: true }],
    ["create role", { canCreateRole: true }],
    ["database create", { canCreateInDatabase: true }],
    ["schema create", { canCreateInPublicSchema: true }],
    ["migration mutation", { migrationsMutate: true }],
    ["tenant mutation", { tenantsMutate: true }],
    ["webhook delete", { webhookDelete: true }],
    ["audit mutation", { auditMutate: true }],
    ["missing audit anchor read", { auditAnchorSelect: false }],
    ["audit anchor mutation", { auditAnchorMutate: true }],
    ["role membership", { roleMemberships: 1 }],
    ["missing migration read", { migrationsSelect: false }],
    ["missing tenant read", { tenantsSelect: false }],
    ["missing webhook DML", { webhookDml: false }],
    ["missing audit append", { auditAppend: false }],
  ])("fails closed on %s", (_label, patch) => {
    expect(() =>
      assertLeastPrivilegeRuntimeRole({ ...good(), ...patch }, "lus_runtime"),
    ).toThrow(/Runtime database privilege verification failed/);
  });

  it("rejects attacker-controlled expected role strings before comparison", () => {
    expect(() => assertLeastPrivilegeRuntimeRole(good(), "bad role\nforged")).toThrow(
      /role name is invalid/,
    );
  });

  it("uses fixed violation codes and never includes actual role names in errors", () => {
    let error: unknown;
    try {
      assertLeastPrivilegeRuntimeRole({ ...good(), roleName: "unexpected_runtime" }, "lus_runtime");
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("ROLE_MISMATCH");
    expect(String((error as Error).message)).not.toContain("unexpected_runtime");
    expect(String((error as Error).message)).not.toContain("lus_runtime");
  });
});
