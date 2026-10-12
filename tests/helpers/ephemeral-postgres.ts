/**
 * Ephemeral PostgreSQL for integration tests: a throw-away cluster in a temp directory, TLS on (self-signed),
 * listening on 127.0.0.1 only, trust auth (loopback, synthetic data, destroyed after the run).
 *
 * - Never connects to anything that is not created here; no credentials from the environment are read.
 * - When PostgreSQL server binaries are not installed, `startEphemeralPostgres()` returns null and the calling
 *   suite must skip VISIBLY. `PERSISTENCE_REQUIRE_PG=1` turns a missing PostgreSQL into a hard failure.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

export interface EphemeralPostgres {
  readonly port: number;
  /** Superuser connection string for a database (TLS required by the server's hba). */
  url(database: string, role?: string): string;
  /** Run SQL as superuser in a database (simple query protocol; synthetic setup only). */
  admin(database: string, sql: string): Promise<void>;
  createDatabase(name: string): Promise<void>;
  /** Logical backup of `source` with pg_dump (custom format) restored into the existing empty database `target`. */
  dumpRestore(source: string, target: string): void;
  stop(): Promise<void>;
}

function findBinDir(): string | null {
  const fromEnv = process.env.PG_BIN_DIR;
  if (fromEnv && existsSync(join(fromEnv, "initdb"))) return fromEnv;
  const which = spawnSync("sh", ["-c", "command -v initdb"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return join(which.stdout.trim(), "..");
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  const versions = readdirSync(base)
    .filter((v) => existsSync(join(base, v, "bin", "initdb")))
    .sort((a, b) => Number(b) - Number(a));
  return versions.length > 0 ? join(base, versions[0], "bin") : null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const EXEC_TIMEOUT_MS = 60_000;
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** uid/gid of the packaged `postgres` OS user (needed only when running as root), or null if there is none. */
function postgresOsUser(): { uid: number; gid: number } | null {
  const uid = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
  const gid = spawnSync("id", ["-g", "postgres"], { encoding: "utf8" });
  if (uid.status !== 0 || gid.status !== 0) return null;
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

function prerequisitesPresent(): boolean {
  return (
    findBinDir() !== null &&
    spawnSync("sh", ["-c", "command -v openssl"]).status === 0 &&
    (!asRoot || postgresOsUser() !== null)
  );
}

let skipWarned = false;

/**
 * Whether the real-PostgreSQL suites should run. With PERSISTENCE_REQUIRE_PG=1 this is always true, so a missing
 * PostgreSQL makes the suites FAIL (startEphemeralPostgres throws) instead of being skipped.
 */
export function postgresAvailable(): boolean {
  if (process.env.PERSISTENCE_REQUIRE_PG === "1") return true;
  const present = prerequisitesPresent();
  if (!present && !skipWarned) {
    skipWarned = true;
    process.stderr.write("[persistence-pg] PostgreSQL server binaries, openssl or the postgres OS user not found — real-PostgreSQL integration tests SKIPPED.\n");
  }
  return present;
}

export async function startEphemeralPostgres(): Promise<EphemeralPostgres | null> {
  const bin = findBinDir();
  if (bin === null || !prerequisitesPresent()) {
    if (process.env.PERSISTENCE_REQUIRE_PG === "1") {
      throw new Error("PERSISTENCE_REQUIRE_PG=1: PostgreSQL server binaries, openssl or the postgres OS user not found.");
    }
    return null;
  }
  const pgUser = asRoot ? postgresOsUser() : null;
  // PostgreSQL refuses to run as root; in a root container run it as the packaged `postgres` user.
  const run = (cmd: string, args: string[]) =>
    asRoot
      ? execFileSync("runuser", ["-u", "postgres", "--", cmd, ...args], { stdio: "pipe", timeout: EXEC_TIMEOUT_MS })
      : execFileSync(cmd, args, { stdio: "pipe", timeout: EXEC_TIMEOUT_MS });
  const own = (path: string) => {
    if (pgUser !== null) chownSync(path, pgUser.uid, pgUser.gid);
  };

  const root = mkdtempSync(join(tmpdir(), "lus-pg-"));
  const data = join(root, "data");
  const stopQuietly = () => {
    try {
      run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "-t", "30", "stop"]);
    } catch {
      // not running
    }
  };
  let port = 0;
  try {
    own(root);
    chmodSync(root, 0o700);
    run(join(bin, "initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8", "--locale=C"]);
    // Self-signed server certificate: the production driver insists on TLS ("require" is used against this server).
    run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-keyout", join(data, "server.key"), "-out", join(data, "server.crt"),
    ]);
    run("chmod", ["600", join(data, "server.key")]);
    // hostssl only: a plain-TCP connection is rejected, like the production policy expects.
    writeFileSync(join(root, "pg_hba.conf"), ["local all postgres trust", "hostssl all all 127.0.0.1/32 trust", ""].join("\n"));
    own(join(root, "pg_hba.conf"));
    // freePort() can race with parallel workers between probe and bind: retry the start on a new port.
    for (let attempt = 1; ; attempt += 1) {
      port = await freePort();
      const options = [
        `-c listen_addresses=127.0.0.1`,
        `-c port=${port}`,
        `-c unix_socket_directories=${root}`,
        `-c ssl=on`,
        `-c hba_file=${join(root, "pg_hba.conf")}`,
        `-c fsync=off`,
        `-c synchronous_commit=off`,
        `-c full_page_writes=off`,
        `-c max_connections=60`,
      ].join(" ");
      try {
        run(join(bin, "pg_ctl"), ["-D", data, "-o", options, "-w", "-t", "30", "-l", join(root, "server.log"), "start"]);
        break;
      } catch (error) {
        stopQuietly();
        if (attempt >= 3) throw error;
      }
    }
  } catch (error) {
    // Never leak a half-started cluster or its temp directory.
    stopQuietly();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const url = (database: string, role = "postgres") => `postgres://${role}@127.0.0.1:${port}/${database}`;
  const admin = async (database: string, sql: string) => {
    const sqlClient = postgres(url(database), { ssl: "require", max: 1, onnotice: () => undefined });
    try {
      await sqlClient.unsafe(sql);
    } finally {
      await sqlClient.end({ timeout: 5 });
    }
  };

  return {
    port,
    url,
    admin,
    async createDatabase(name: string) {
      if (!/^[a-z_][a-z0-9_]{0,40}$/.test(name)) throw new Error("bad test database name");
      await admin("postgres", `CREATE DATABASE ${name}`);
    },
    dumpRestore(source: string, target: string) {
      // Minimal environment: no inherited PG* variables (host, password, service file) can redirect the tools.
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", PGSSLMODE: "require" };
      const dump = execFileSync(join(bin, "pg_dump"), ["--format=custom", "--dbname", url(source)], { env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: EXEC_TIMEOUT_MS });
      execFileSync(join(bin, "pg_restore"), ["--exit-on-error", "--single-transaction", "--dbname", url(target)], { env, input: dump, stdio: ["pipe", "pipe", "pipe"], timeout: EXEC_TIMEOUT_MS });
    },
    async stop() {
      try {
        run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "-t", "30", "stop"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
