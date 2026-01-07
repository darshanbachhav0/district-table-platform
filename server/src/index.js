require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { init } = require("./db");
const { seed } = require("./seed");
const { authMiddleware } = require("./auth");
const routes = require("./routes");

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";

async function main(){
  await init();
  await seed();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // Static frontend
  const publicDir = path.join(__dirname, "..", "..", "public");
  app.use(express.static(publicDir));

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
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Admin login: admin / admin123");
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
