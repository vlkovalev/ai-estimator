const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');
const { Firestore } = require('@google-cloud/firestore');

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'audit.db');
const provider = (process.env.AUDIT_DB_PROVIDER || process.env.DB_PROVIDER || 'sqlite').toLowerCase();

let db;
let pgPool;
let firestore;

function initSqlite() {
  if (db) return;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      action TEXT,
      provider TEXT,
      bucket TEXT,
      keys TEXT,
      meta TEXT
    )`);
  });
}

function initPostgres() {
  if (pgPool) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Postgres audit logging');
  }
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
}

function initFirestore() {
  if (firestore) return;
  firestore = new Firestore();
}

async function insertAudit(entry) {
  const row = {
    ts: new Date().toISOString(),
    action: entry.action || null,
    provider: entry.provider || null,
    bucket: entry.bucket || null,
    keys: entry.keys || entry || null,
    meta: entry.meta || {}
  };

  if (provider === 'postgres') {
    initPostgres();
    const query = `INSERT INTO audits(ts, action, provider, bucket, keys, meta) VALUES($1, $2, $3, $4, $5, $6) RETURNING id`;
    const values = [row.ts, row.action, row.provider, row.bucket, JSON.stringify(row.keys), JSON.stringify(row.meta)];
    const result = await pgPool.query(query, values);
    return { id: result.rows[0].id };
  }

  if (provider === 'firestore') {
    initFirestore();
    const doc = await firestore.collection('audits').add({ ...row, keys: row.keys, meta: row.meta });
    return { id: doc.id };
  }

  initSqlite();
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`INSERT INTO audits (ts, action, provider, bucket, keys, meta) VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(row.ts, row.action, row.provider, row.bucket, JSON.stringify(row.keys), JSON.stringify(row.meta), function(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID });
    });
  });
}

module.exports = { insertAudit };
