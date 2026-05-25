import pg from "pg";

// Test 1: No SSL at all
async function test(label, config) {
  const pool = new pg.Pool({ ...config, database: "postgres", connectionTimeoutMillis: 10000 });
  try {
    const r = await pool.query("SELECT version() as v");
    console.log(label, "OK:", r.rows[0].v.slice(0,30));
  } catch(e) {
    console.log(label, "FAIL:", e.message.slice(0, 120));
  } finally { try { await pool.end(); } catch(_){} }
}

const base = { user: "postgres.phiphmckgxfrqvudnmxx", password: "mehfuh@popoJ1" };
const txn = { host: "aws-0-us-east-1.pooler.supabase.com", port: 6543 };

await test("[txn ssl:false]",                 { ...base, ...txn, ssl: false });
await test("[txn ssl:true]",                  { ...base, ...txn, ssl: true });
await test("[txn rejectUnauth=false]",        { ...base, ...txn, ssl: { rejectUnauthorized: false } });
await test("[txn sslmode=require in url]",    { connectionString: `postgresql://postgres.phiphmckgxfrqvudnmxx:mehfuh%40popoJ1@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`, ...base  });
await test("[direct ipv6 ssl=false]",         { ...base, host: "db.phiphmckgxfrqvudnmxx.supabase.co", port: 5432, ssl: false });
await test("[direct ipv6 rejectUnauth=false]",{ ...base, host: "db.phiphmckgxfrqvudnmxx.supabase.co", port: 5432, ssl: { rejectUnauthorized: false } });
