import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

// pg-mem supports a subset of PostgreSQL DDL.  When running in memory mode we
// execute each statement individually and silently skip any that fail so the
// app still starts with whatever schema pg-mem could apply.
const isPgMem = config.databaseUrl === "memory";

async function runStatement(client, sql) {
  if (isPgMem) {
    try { await client.query(sql); }
    catch (err) { console.warn(`[pg-mem skip] ${err.message?.split("\n")[0]} — SQL: ${sql.slice(0, 80)}`); }
  } else {
    await client.query(sql);
  }
}

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await pool.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id)
  );
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");

    if (isPgMem) {
      // Run each statement individually — pg-mem has no transaction rollback on DDL anyway
      const statements = sql
        .split(/;\s*\n/)
        .map((s) =>
          s.split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim()
        )
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await runStatement(pool, stmt);
      }
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
      console.log(`Applied (pg-mem) ${file}`);
    } else {
      // Real PostgreSQL — transactional migration
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${error.message}`);
      } finally {
        client.release();
      }
    }
  }
}
