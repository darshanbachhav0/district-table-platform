require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { init } = require("./db");
const { seed } = require("./seed");
const { authMiddleware } = require("./auth");
const routes = require("./routes");

const PORT = process.env.PORT || 8080;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(v);
}

// Secrets / credentials MUST come from environment variables (Render → Environment)
const JWT_SECRET = requireEnv("JWT_SECRET");
const ADMIN_USERNAME = requireEnv("ADMIN_USERNAME");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
const DISTRICT_DEFAULT_PASSWORD = requireEnv("DISTRICT_DEFAULT_PASSWORD");

async function main(){
  await init();
  await seed({
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    districtDefaultPassword: DISTRICT_DEFAULT_PASSWORD,
  });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // Static frontend
  const publicDir = path.join(__dirname, "..", "..", "public");
  app.use(express.static(publicDir));

  // Make config available to routes
  app.locals.JWT_SECRET = JWT_SECRET;

  // Health
  app.get("/api/health", (_, res) => res.json({ ok: true }));

  // Auth gating: only /api/login and static are public.
  app.use("/api", (req, res, next) => {
    if (req.path === "/login") return next();
    return authMiddleware(JWT_SECRET)(req, res, next);
  });

  // API routes
  app.use("/api", routes);

  // SPA-ish fallback to login
  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
