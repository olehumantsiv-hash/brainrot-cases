const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL to the Supabase PostgreSQL connection string");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.resolve(process.argv[2] || `braincase-backup-${timestamp}.json`);
const pool = new Pool({ connectionString, ssl: true, max: 1 });
(async () => {
  try {
    const result = await pool.query("SELECT data FROM braincase_state WHERE id = 1");
    if (!result.rowCount) throw new Error("Braincase state was not found in PostgreSQL");
    fs.writeFileSync(output, JSON.stringify(result.rows[0].data, null, 2), { flag: "wx" });
    console.log(`Saved a JSON backup to ${output}`);
  } finally {
    await pool.end();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
