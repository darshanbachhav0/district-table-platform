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
  await connectMongo({ uri: mongoUri, dbName: mongoDbName });

// ✅ repair first, then indexes
await store.repairDatabase();
await store.ensureIndexes();

await seedIfNeeded();


  const app = express();

  // Disable caching/ETag issues
  app.set("etag", false);
  app.disable("etag");

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // Never cache API responses
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.removeHeader("ETag");
    next();
  });

  // Static site
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

  // ✅ JSON error handler (so frontend sees the real problem)
  app.use((err, req, res, next) => {
    console.error("API ERROR:", err);

    const status = err.status || 500;

    // If you want to see real error in browser, set DEBUG_API_ERRORS=1 in Render env
    const debug = process.env.DEBUG_API_ERRORS === "1";
    res.status(status).json({
      error: debug ? (err.message || "Server error") : "Server error. Check Render logs.",
      ...(debug ? { stack: err.stack } : {}),
    });
  });

  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
