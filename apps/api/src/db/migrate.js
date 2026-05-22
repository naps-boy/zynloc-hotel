import { requireEnv } from "../config.js";
import { pool } from "./pool.js";
import { runMigrations } from "./runMigrations.js";

requireEnv();

await runMigrations();
await pool.end();
