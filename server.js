// Thanksgiving 2026 page + sign-up API.
// Serves index.html at / and a small JSON API at /api backed by Postgres (DATABASE_URL).
// Without DATABASE_URL it keeps sign-ups in memory (local testing only).
"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const CATS = ["app", "side", "dessert", "drink"];
const SLOTS = ["veggie-tray", "mashed-potatoes", "dinner-rolls", "green-veg", "mac-cheese",
               "apple-pie", "kids-sweets", "cider-punch", "adult-drinks"];
const MAX_ROWS = 150;

const clean = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const newId = () => crypto.randomBytes(6).toString("hex");
const newToken = () => crypto.randomBytes(18).toString("hex");
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ------------------------------------------------------------------ storage */
function memoryStore() {
  const rows = [];
  return {
    kind: "memory",
    async init() {},
    async list() { return rows.slice().sort((a, b) => a.at - b.at); },
    async count() { return rows.length; },
    async insert(r) {
      if (r.slot && rows.some((x) => x.slot === r.slot)) { const e = new Error("taken"); e.code = "taken"; throw e; }
      rows.push(r);
    },
    async get(id) { return rows.find((x) => x.id === id) || null; },
    async remove(id) { const i = rows.findIndex((x) => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  // Render's internal URLs need no SSL; external ones (host ending in render.com) do.
  const needsSsl = /\.render\.com(:\d+)?\//.test(url) || process.env.PGSSL === "true";
  const pool = new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false, max: 5 });
  const map = (r) => ({ id: r.id, slot: r.slot, cat: r.cat, dish: r.dish, family: r.family,
                        gluten: r.gluten, nuts: r.nuts, note: r.note, at: Number(r.at), token: r.token });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS signups (
        id text PRIMARY KEY, slot text NOT NULL DEFAULT '', cat text NOT NULL, dish text NOT NULL,
        family text NOT NULL, gluten boolean NOT NULL DEFAULT false, nuts boolean NOT NULL DEFAULT false,
        note text NOT NULL DEFAULT '', at bigint NOT NULL, token text NOT NULL)`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS signups_slot_once ON signups (slot) WHERE slot <> ''`);
    },
    async list() { return (await pool.query("SELECT * FROM signups ORDER BY at")).rows.map(map); },
    async count() { return Number((await pool.query("SELECT count(*) AS n FROM signups")).rows[0].n); },
    async insert(r) {
      try {
        await pool.query(
          "INSERT INTO signups (id, slot, cat, dish, family, gluten, nuts, note, at, token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [r.id, r.slot, r.cat, r.dish, r.family, r.gluten, r.nuts, r.note, r.at, r.token]);
      } catch (e) {
        if (e && e.code === "23505") { const t = new Error("taken"); t.code = "taken"; throw t; }
        throw e;
      }
    },
    async get(id) { const r = (await pool.query("SELECT * FROM signups WHERE id = $1", [id])).rows[0]; return r ? map(r) : null; },
    async remove(id) { await pool.query("DELETE FROM signups WHERE id = $1", [id]); },
  };
}

const db = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memoryStore();

/* ------------------------------------------------------------------ api */
async function add(it) {
  const slot = SLOTS.includes(it.slot) ? it.slot : "";
  const cat = CATS.includes(it.cat) ? it.cat : "";
  const dish = clean(it.dish, 80), family = clean(it.family, 40);
  if (!cat || !dish || !family) return { ok: false, code: "bad_request" };
  if ((await db.count()) >= MAX_ROWS) return { ok: false, code: "full" };
  const row = { id: newId(), slot, cat, dish, family, gluten: it.gluten === true, nuts: it.nuts === true,
                note: clean(it.note, 100), at: Date.now(), token: newToken() };
  try { await db.insert(row); }
  catch (e) { if (e && e.code === "taken") return { ok: false, code: "taken" }; throw e; }
  return { ok: true, id: row.id, token: row.token };
}

async function remove(id, token, admin) {
  const row = await db.get(String(id || ""));
  if (!row) return { ok: true };
  if (!sameSecret(token, row.token) && !(ADMIN_KEY && sameSecret(admin, ADMIN_KEY))) return { ok: false, code: "forbidden" };
  await db.remove(row.id);
  return { ok: true };
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });

app.get("/healthz", (req, res) => res.type("text").send("ok " + db.kind));

app.get("/api", async (req, res, next) => {
  try {
    const items = (await db.list()).map(({ token, ...rest }) => rest);
    res.set("Cache-Control", "no-store").json({ ok: true, items });
  } catch (e) { next(e); }
});

// The page posts JSON as text/plain; accept any content type and parse it ourselves.
app.post("/api", express.text({ type: "*/*", limit: "8kb" }), async (req, res, next) => {
  let body;
  try { body = JSON.parse(typeof req.body === "string" ? req.body : ""); } catch { return res.json({ ok: false, code: "bad_request" }); }
  if (!body || typeof body !== "object") return res.json({ ok: false, code: "bad_request" });
  try {
    if (body.action === "add") return res.json(await add(body.item && typeof body.item === "object" ? body.item : {}));
    if (body.action === "remove") return res.json(await remove(body.id, body.token, body.admin));
    if (body.action === "check-admin") return res.json({ ok: !!ADMIN_KEY && sameSecret(body.admin, ADMIN_KEY) });
    res.json({ ok: false, code: "bad_request" });
  } catch (e) { next(e); }
});

const INDEX = path.join(__dirname, "index.html");
const OG = path.join(__dirname, "og.png");
app.get("/og.png", (req, res) => res.set("Cache-Control", "public, max-age=86400").type("png").sendFile(OG));
app.get(["/", "/index.html"], (req, res) => res.set("Cache-Control", "no-cache").sendFile(INDEX));
app.use((req, res) => res.redirect(302, "/"));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ ok: false, code: "error" });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`Thanksgiving page on :${PORT} (${db.kind} storage)`)))
  .catch((e) => { console.error("Could not start storage:", e); process.exit(1); });
