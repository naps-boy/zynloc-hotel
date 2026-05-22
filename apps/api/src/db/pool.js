import crypto from "node:crypto";
import pg from "pg";
import { newDb } from "pg-mem";
import { config } from "../config.js";

function createPool() {
  if (config.databaseUrl === "memory") {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.registerExtension("pgcrypto", (schema) => {
      schema.registerFunction({
        name: "gen_random_uuid",
        returns: "uuid",
        impure: true,
        implementation: crypto.randomUUID
      });
    });
    db.public.registerFunction({
      name: "gen_random_uuid",
      returns: "uuid",
      impure: true,
      implementation: crypto.randomUUID
    });
    const adapter = db.adapters.createPg();
    return new adapter.Pool();
  }

  return new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false }
  });
}

export const pool = createPool();

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
