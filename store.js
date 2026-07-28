// PostgreSQL-backed persistence (the project's chosen production database).
// The whole state tree stays in memory (`db`) exactly as before, so route
// code keeps its synchronous style; every mutation is mirrored to Postgres
// (debounced, transactional) via save(). Each top-level collection is one
// JSONB row in `collections`, with SQL reporting views layered on top.
//
// Boot order matters: boot.js awaits init() BEFORE server.js is required,
// so `db` is fully populated by the time routes are defined.
//
// If Postgres is unreachable at boot, the store falls back to the legacy
// data/db.json file so the site still runs — loudly, on the console and on
// /api/health. A one-time migration imports db.json into Postgres the first
// time an empty database is seen.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// DPJ_DB_FILE lets the test suite point file-mode storage at a throwaway
// path so tests never touch real data.
const FILE = process.env.DPJ_DB_FILE || path.join(__dirname, "data", "db.json");
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://dpj:dpj@localhost:5436/dpjewellers";

const defaults = {
  rates: {
    gold: { "24K": 10450, "22K": 9580, "18K": 7840, "14K": 6110 },
    silver: { "925": 138 },
    platinum: { PT950: 3520 },
  },
  ratesUpdatedAt: null,
  rateProposals: [], // maker-checker queue (BRD FR-PRC-10 / FR-ADM-02)
  rateAudit: [],     // who / when / from / to (BRD FR-PRC-09)
  orders: [],
  paymentIntents: [],
  newsletter: [],
};

const db = {}; // populated by init()
const storage = { backend: "file", detail: null }; // surfaced on /api/health

let pool = null;

function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeFile() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

// Upsert every top-level collection in one transaction. Data volumes here
// are small (a shop's operational state, not analytics), so whole-tree
// writes stay well under a millisecond of Postgres time.
async function flushAll() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [name, value] of Object.entries(db)) {
      await client.query(
        `INSERT INTO collections (name, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [name, JSON.stringify(value ?? null)]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Read-side SQL views so Finance/BI can query with plain SQL (psql, Metabase,
// pgAdmin) without touching the application. Recreated idempotently at boot.
async function createViews() {
  await pool.query(`
    CREATE OR REPLACE VIEW orders_v AS
    SELECT o->>'orderId'                       AS order_id,
           (o->>'placedAt')::timestamptz       AS placed_at,
           o->>'status'                        AS status,
           o->'customer'->>'name'              AS customer,
           o->'customer'->>'phone'             AS phone,
           (o->>'total')::numeric              AS gross,
           COALESCE((o->>'discount')::numeric, 0)                          AS discount,
           COALESCE((o->>'payable')::numeric, (o->>'total')::numeric)      AS payable,
           o->'payment'->>'mode'               AS pay_mode,
           o->'payment'->>'status'             AS pay_status,
           o->'invoice'->>'number'             AS invoice_no
    FROM collections c, jsonb_array_elements(c.data) AS o
    WHERE c.name = 'orders'
  `);
  await pool.query(`
    CREATE OR REPLACE VIEW customers_v AS
    SELECT x->>'phone'                    AS phone,
           x->>'name'                     AS name,
           x->>'email'                    AS email,
           (x->>'createdAt')::timestamptz AS created_at,
           jsonb_array_length(COALESCE(x->'addresses', '[]'::jsonb)) AS addresses
    FROM collections c, jsonb_array_elements(c.data) AS x
    WHERE c.name = 'customers'
  `);
  await pool.query(`
    CREATE OR REPLACE VIEW schemes_v AS
    SELECT x->>'id'                        AS scheme_id,
           x->>'variant'                   AS variant,
           x->'customer'->>'phone'         AS phone,
           (x->>'monthlyAmount')::numeric  AS monthly,
           x->>'status'                    AS status,
           jsonb_array_length(COALESCE(x->'instalments', '[]'::jsonb)) AS instalments_paid,
           (SELECT COALESCE(SUM((i->>'amount')::numeric), 0)
              FROM jsonb_array_elements(COALESCE(x->'instalments', '[]'::jsonb)) AS i) AS total_paid,
           (SELECT COALESCE(SUM((i->>'grams')::numeric), 0)
              FROM jsonb_array_elements(COALESCE(x->'instalments', '[]'::jsonb)) AS i) AS grams_accrued
    FROM collections c, jsonb_array_elements(c.data) AS x
    WHERE c.name = 'schemes'
  `);
  await pool.query(`
    CREATE OR REPLACE VIEW notifications_v AS
    SELECT x->>'id'                 AS id,
           (x->>'at')::timestamptz  AS sent_at,
           x->>'phone'              AS phone,
           x->>'event'              AS event,
           x->>'message'            AS message
    FROM collections c, jsonb_array_elements(c.data) AS x
    WHERE c.name = 'notifications'
  `);
}

async function init() {
  Object.assign(db, structuredClone(defaults));
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      // managed Postgres (Render, Neon, Supabase, …) requires TLS; local
      // containers don't speak it
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collections (
        name        text PRIMARY KEY,
        data        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await pool.query("SELECT name, data FROM collections");
    if (rows.length === 0) {
      const legacy = loadFile();
      if (legacy) {
        Object.assign(db, legacy);
        await flushAll();
        console.log(
          `Storage: migrated ${Object.keys(legacy).length} collections from data/db.json into PostgreSQL (one-time import; the file is now a cold backup)`
        );
      }
    } else {
      for (const r of rows) db[r.name] = r.data;
    }
    await createViews();
    storage.backend = "postgres";
    storage.detail = DATABASE_URL.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
    console.log(`Storage: PostgreSQL (${storage.detail})`);
  } catch (e) {
    if (pool) pool.end().catch(() => {});
    pool = null;
    const legacy = loadFile();
    if (legacy) Object.assign(db, legacy);
    const reason = e.message || e.code || "connection refused";
    storage.backend = "file";
    storage.detail = `postgres unavailable: ${reason}`;
    console.warn(
      `Storage: PostgreSQL unreachable (${reason}) — running on the data/db.json fallback. Start the dpj-postgres container and restart to persist to Postgres.`
    );
  }
}

let timer = null;
let writing = Promise.resolve(); // serialise flushes so they never interleave
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    writing = writing
      .then(() => (pool ? flushAll() : writeFile()))
      .catch((e) => console.error(`Storage: save failed — ${e.message}`));
  }, 100);
}

module.exports = { db, save, init, storage };
