import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const source = join(process.cwd(), "src", "persistence", "migrations");
const target = join(process.cwd(), "dist", "persistence", "migrations");

const files = readdirSync(source)
  .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/.test(name))
  .sort();

if (files.length === 0) {
  throw new Error("No persistence migrations found.");
}

mkdirSync(target, { recursive: true });

for (const name of files) {
  copyFileSync(join(source, name), join(target, name));
}

process.stdout.write("Copied " + files.length + " persistence migration(s).\n");
