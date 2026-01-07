const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const dbPath = path.join(__dirname, "..", "data.sqlite");
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function init() {
  await run(`PRAGMA foreign_keys = ON`);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','district')),
      district_name TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(created_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('text','textarea','number','date','select')),
      required INTEGER NOT NULL DEFAULT 0,
      options_json TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(template_id) REFERENCES templates(id) ON DELETE CASCADE,
      UNIQUE(template_id, field_key)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      district_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent')),
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(template_id) REFERENCES templates(id) ON DELETE CASCADE,
      FOREIGN KEY(district_user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(template_id, district_user_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS values_kv (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
      UNIQUE(assignment_id, field_key)
    )
  `);
}

module.exports = { db, run, get, all, init };
