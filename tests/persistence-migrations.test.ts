import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  assertSupportedSchemaVersion,
  migrationChecksum,
} from "../src/persistence/migrations.js";

describe("persistence migration manifest", () => {
  it("is ordered, unique and forward-only", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions[0]).toBe(1);
    expect(LATEST_SCHEMA_VERSION).toBe(versions.at(-1));
  });

  it("produces deterministic SHA-256 migration checksums", () => {
    const a = migrationChecksum("SELECT 1;\n");
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(migrationChecksum("SELECT 1;\n"));
    expect(a).not.toBe(migrationChecksum("SELECT 2;\n"));
  });

  it("accepts empty/current schema versions and rejects future or malformed versions", () => {
    expect(() => assertSupportedSchemaVersion(0)).not.toThrow();
    expect(() => assertSupportedSchemaVersion(LATEST_SCHEMA_VERSION)).not.toThrow();
    expect(() => assertSupportedSchemaVersion(LATEST_SCHEMA_VERSION + 1)).toThrow(/newer/);
    expect(() => assertSupportedSchemaVersion(-1)).toThrow(/Invalid/);
    expect(() => assertSupportedSchemaVersion(1.5)).toThrow(/Invalid/);
    expect(() => assertSupportedSchemaVersion(Number.NaN)).toThrow(/Invalid/);
  });
});
