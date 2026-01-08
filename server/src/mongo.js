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
    // mongodb+srv://.../dbname?...
    const afterSlash = uri.split("://")[1].split("/").slice(1).join("/");
    const dbPart = afterSlash.split("?")[0];
    if (dbPart && dbPart.trim()) return dbPart.trim();
  } catch {}
  return null;
}

async function connectMongo() {
  if (_db) return _db;

  const uri = requireEnv("MONGODB_URI");
  const envDb = process.env.MONGODB_DB && String(process.env.MONGODB_DB).trim();
  const uriDb = inferDbNameFromUri(uri);
  const dbName = envDb || uriDb || "district_platform";

  client = new MongoClient(uri, {
    maxPoolSize: 10
  });

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
