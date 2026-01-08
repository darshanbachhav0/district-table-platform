const jwt = require("jsonwebtoken");
const store = require("./store");

function signToken(user, secret) {
  return jwt.sign(
    { id: user.id, role: user.role, username: user.username, district_name: user.district_name || null },
    secret,
    { expiresIn: "7d" }
  );
}

function authMiddleware(secret) {
  return async (req, res, next) => {
    try {
      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Not authenticated." });

      const payload = jwt.verify(token, secret);
      const user = await store.getUserPublicById(payload.id);
      if (!user) return res.status(401).json({ error: "Invalid user." });

      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token." });
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated." });
    if (req.user.role !== role) return res.status(403).json({ error: "Forbidden." });
    next();
  };
}

module.exports = { signToken, authMiddleware, requireRole };
