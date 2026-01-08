require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { connectMongo } = require("./mongo");
const store = require("./store");
const { seed } = require("./seed");
const { authMiddleware } = require("./auth");
const routes = require("./routes");

const PORT = process.env.PORT || 8080;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(v);
}

const JWT_SECRET = requireEnv("JWT_SECRET");
const ADMIN_USERNAME = requireEnv("ADMIN_USERNAME");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
const DISTRICT_DEFAULT_PASSWORD = requireEnv("DISTRICT_DEFAULT_PASSWORD");
requireEnv("MONGODB_URI");

async function main() {
  await connectMongo();
  await store.repairCounters();     // ✅ NEW: fixes NaN counters + repairs old templates
  await store.ensureIndexes();

  await seed({
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    districtDefaultPassword: DISTRICT_DEFAULT_PASSWORD
  });

  const app = express();

  app.locals.JWT_SECRET = JWT_SECRET;

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // Static frontend
  app.use(express.static(path.join(__dirname)));

  // Auth
  app.use("/api", authMiddleware(app.locals.JWT_SECRET), routes);

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.listen(PORT, () => console.log(`Server running on :${PORT}`));
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
