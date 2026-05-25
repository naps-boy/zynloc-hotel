import pg from "pg";
async function test(host, port, label) {
  const pool = new pg.Pool({
    host, port, database: "postgres",
    user: "postgres.phiphmckgxfrqvudnmxx",
    password: "mehfuh@popoJ1",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000
  });
  try {
    const r = await pool.query("SELECT 1 AS ok");
    console.log(label, "SUCCESS:", JSON.stringify(r.rows[0]));
  } catch(e) {
    console.log(label, "FAIL:", e.message);
  } finally { try { await pool.end(); } catch(_){} }
}
await test("aws-0-us-east-1.pooler.supabase.com",    6543, "[us-east-1  txn]");
await test("aws-0-ap-southeast-1.pooler.supabase.com", 6543, "[ap-se-1    txn]");
await test("aws-0-us-east-1.pooler.supabase.com",    5432, "[us-east-1  ses]");
await test("aws-0-ap-southeast-1.pooler.supabase.com", 5432, "[ap-se-1    ses]");
await test("aws-0-eu-west-1.pooler.supabase.com",    6543, "[eu-west-1  txn]");
await test("aws-0-eu-central-1.pooler.supabase.com", 6543, "[eu-central txn]");
