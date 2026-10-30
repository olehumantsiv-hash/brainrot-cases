// One-time import: DATABASE_URL="..." node migrate-json-to-postgres.js ./db.json
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL to the Supabase PostgreSQL connection string");

const input = path.resolve(process.argv[2] || process.env.DB_FILE || path.join(__dirname, "db.json"));
if (!fs.existsSync(input)) throw new Error(`JSON backup not found: ${input}`);

let data;
try { data = JSON.parse(fs.readFileSync(input, "utf8")); }
catch (error) { throw new Error(`Cannot parse ${input}: ${error.message}`); }
if (!data || typeof data !== "object" || !data.users || typeof data.users !== "object") {
  throw new Error("The JSON backup must contain a top-level 'users' object");
}

const pool = new Pool({ connectionString, ssl: true, max: 1 });
(async () => {
  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS braincase_state (id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL)");
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM braincase_state WHERE id = 1 FOR UPDATE");
    if (existing.rowCount) throw new Error("Supabase already contains Braincase data; import cancelled to avoid overwriting it");
    await client.query("INSERT INTO braincase_state (id, data) VALUES (1, $1::jsonb)", [JSON.stringify(data)]);
    await client.query("COMMIT");
    console.log(`Imported ${Object.keys(data.users).length} player records from ${input}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
