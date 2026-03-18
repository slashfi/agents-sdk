#!/usr/bin/env bun
/**
 * Migration Runner
 *
 * Executes QB-generated migrations against the database.
 * Tracks applied migrations in a `migrations` table.
 *
 * Usage: DATABASE_URL=postgres://... bun run-migrations.ts
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(DATABASE_URL);

// Ensure migrations tracking table exists
await client.unsafe(`
  CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    executed_at TIMESTAMP DEFAULT NOW() NOT NULL
  );
`);

// Get already-applied migrations
const applied = await client.unsafe(`SELECT name FROM migrations ORDER BY name`);
const appliedSet = new Set(applied.map((r) => r.name));

// Load migration files
const migrationsDir = resolve(import.meta.dir, "migrations");
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".ts")).sort();

let ranCount = 0;

for (const file of files) {
  const migrationName = file.replace(".ts", "");

  if (appliedSet.has(migrationName)) {
    console.log(`[skip] ${migrationName} (already applied)`);
    continue;
  }

  console.log(`[run]  ${migrationName}...`);

  // Import the migration module
  const mod = await import(resolve(migrationsDir, file));

  // Find the migration class (first exported class with an `up` method)
  const MigrationClass = Object.values(mod).find(
    (v: any) => typeof v === "function" && v.prototype?.up
  ) as any;

  if (!MigrationClass) {
    console.error(`  ERROR: No migration class found in ${file}`);
    process.exit(1);
  }

  const instance = new MigrationClass();

  // Create a minimal queryRunner compatible with TypeORM's interface
  const queryRunner = {
    query: async (sql: string) => {
      await client.unsafe(sql);
    },
  };

  await instance.up(queryRunner);

  // Record migration
  await client.unsafe(`INSERT INTO migrations (name) VALUES ($1)`, [migrationName]);
  console.log(`  ✓ applied`);
  ranCount++;
}

if (ranCount === 0) {
  console.log("\nAll migrations already applied.");
} else {
  console.log(`\n${ranCount} migration(s) applied.`);
}

await client.end();
