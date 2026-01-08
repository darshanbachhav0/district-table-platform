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

async function main(){
  await connectMongo();
  await store.ensureIndexes();

  await seed({
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    districtDefaultPassword: DISTRICT_DEFAULT_PASSWORD
  });

  const app = express();

  app.disable("etag"); // stops 304 for API in most cases

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});


  // ✅ CORS (Allow same-origin + future cookie support)
  app.use(cors({
    origin: true,
    credentials: true
  }));

  app.use(express.json({ limit: "1mb" }));

  // ✅ Disable caching for API responses (prevents 304 stale behavior)
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    next();
  });

  const publicDir = path.join(__dirname, "..", "..", "public");
  app.use(express.static(publicDir, {
    etag: true, // ok for static
    maxAge: "1h"
  }));

  app.locals.JWT_SECRET = JWT_SECRET;

  app.get("/api/health", (_, res) => res.json({ ok: true }));

  // ✅ Auth guard (keep /login public)
  app.use("/api", (req, res, next) => {
    if (req.path === "/login") return next();
    // if you add logout later, keep it public:
    if (req.path === "/logout") return next();
    return authMiddleware(JWT_SECRET)(req, res, next);
  });

  app.use("/api", routes);

  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
