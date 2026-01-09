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

// Required envs
const JWT_SECRET = requireEnv("JWT_SECRET");
const ADMIN_USERNAME = requireEnv("ADMIN_USERNAME");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
const DISTRICT_DEFAULT_PASSWORD = requireEnv("DISTRICT_DEFAULT_PASSWORD");

// ✅ Fix: define mongoUri properly
const MONGODB_URI = requireEnv("MONGODB_URI");
// optional, if you set it on Render
const MONGODB_DB = (process.env.MONGODB_DB || "").trim() || null;

async function main() {
  // ✅ works whether mongo.js accepts params or not (we’ll update mongo.js too)
  await connectMongo({ uri: MONGODB_URI, dbName: MONGODB_DB });

  // ✅ IMPORTANT: repair DB first, then indexes
  await store.repairDatabase();
  await store.ensureIndexes();

  await seed({
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    districtDefaultPassword: DISTRICT_DEFAULT_PASSWORD,
  });

  const app = express();

  app.set("etag", false);
  app.disable("etag");

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // No cache for API
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.removeHeader("ETag");
    next();
  });

  const publicDir = path.join(__dirname, "..", "..", "public");

  app.use(
    express.static(publicDir, {
      etag: false,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
      },
    })
  );

  app.locals.JWT_SECRET = JWT_SECRET;

  app.get("/api/health", (_, res) => res.json({ ok: true }));

  // Auth guard (keep /login public)
  app.use("/api", (req, res, next) => {
    if (req.path === "/login") return next();
    return authMiddleware(JWT_SECRET)(req, res, next);
  });

  app.use("/api", routes);

  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
