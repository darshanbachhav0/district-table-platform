require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const { connectMongo } = require("./mongo");
const store = require("./store");
const { seed } = require("./seed");
const { authMiddleware } = require("./auth");
const routes = require("./routes");

const PORT = process.env.PORT || 8080;

function pickPublicDir() {
  const candidates = [
    path.join(__dirname, "public"),
    path.join(__dirname, "..", "..", "public"),
    __dirname,
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return __dirname;
}

async function main() {
  const app = express();

  // Always start the server (avoid 502). If DB/env is broken, API will return 503/500 with clear message.
  app.locals.JWT_SECRET = process.env.JWT_SECRET ? String(process.env.JWT_SECRET) : null;
  app.locals.mongoReady = false;

  // ✅ Disable ETag globally (prevents 304 caching issues for API)
  app.set("etag", false);
  app.disable("etag");

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // ✅ Never cache API responses
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.removeHeader("ETag");
    next();
  });

  const publicDir = pickPublicDir();

  // ✅ Static files (no cache)
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

  // Health endpoint (works even if DB is down)
  app.get("/api/health", (_, res) => {
    res.json({
      ok: true,
      mongoReady: !!app.locals.mongoReady,
      jwtSecretSet: !!app.locals.JWT_SECRET,
    });
  });

  // If mongo is not ready, block API (except /login and /health) with 503
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path === "/login") return next();
    if (!app.locals.mongoReady) {
      return res.status(503).json({ error: "Database not ready. Check Render logs / Mongo connection." });
    }
    if (!app.locals.JWT_SECRET) {
      return res.status(500).json({ error: "Server misconfigured: missing JWT_SECRET env var." });
    }
    return next();
  });

  // ✅ Auth guard (keep /login public)
  app.use("/api", (req, res, next) => {
    if (req.path === "/login" || req.path === "/health") return next();
    return authMiddleware(app.locals.JWT_SECRET)(req, res, next);
  });

  // Routes
  app.use("/api", routes);

  // Global error handler (prevents crashes -> prevents 502)
  app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Server error. Check Render logs." });
  });

  // SPA fallback
  app.get("*", (req, res) => {
    const indexPath = path.join(publicDir, "index.html");
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.status(404).send("Not Found");
  });

  // Start listening first (so no 502)
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  // Connect DB + repair + indexes + seed (safe, won’t crash server)
  try {
    await connectMongo();
    await store.repairOnStartup();   // ✅ fixes counters + fixes old templates with invalid ids
    await store.ensureIndexesSafe(); // ✅ indexes but never crash on duplicates
    await seed({
      adminUsername: process.env.ADMIN_USERNAME,
      adminPassword: process.env.ADMIN_PASSWORD,
      districtDefaultPassword: process.env.DISTRICT_DEFAULT_PASSWORD,
    });
    app.locals.mongoReady = true;
    console.log("✅ Startup completed (mongoReady=true)");
  } catch (e) {
    console.error("❌ Startup init failed (server still running):", e);
    app.locals.mongoReady = false;
  }
}

main().catch((e) => {
  console.error("Fatal (should not happen):", e);
});
