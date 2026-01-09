const { MongoClient } = require("mongodb");

let client = null;
let _db = null;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(v);
}

function inferDbNameFromUri(uri) {
  try {
    const afterSlash = uri.split("://")[1].split("/").slice(1).join("/");
    const dbPart = afterSlash.split("?")[0];
    if (dbPart && dbPart.trim()) return dbPart.trim();
  } catch {}
  return null;
}

// ✅ Now supports connectMongo() OR connectMongo({uri, dbName})
async function connectMongo(opts = {}) {
  if (_db) return _db;

  const uri = opts.uri || requireEnv("MONGODB_URI");
  const envDb = (opts.dbName || process.env.MONGODB_DB || "").toString().trim();
  const uriDb = inferDbNameFromUri(uri);
  const dbName = envDb || uriDb || "district_platform";

  client = new MongoClient(uri, { maxPoolSize: 10 });

  await client.connect();
  _db = client.db(dbName);

  console.log(`✅ MongoDB connected (db: ${dbName})`);
  return _db;
}

function db() {
  if (!_db) throw new Error("MongoDB not connected yet. Call connectMongo() first.");
  return _db;
}

module.exports = { connectMongo, db };
