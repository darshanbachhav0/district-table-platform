const jwt = require("jsonwebtoken");

/**
 * Works for both Mongo + SQLite versions.
 * We no longer query DB in middleware (prevents DB mismatch bugs).
 * Token itself carries the user identity/role.
 */

function signToken(user, secret) {
  const id = user.id ?? (user._id ? String(user._id) : null);

  return jwt.sign(
    {
      id,
      role: user.role,
      username: user.username,
      district_name: user.district_name || null,
    },
    secret,
    { expiresIn: "7d" }
  );
}

function authMiddleware(secret) {
  return (req, res, next) => {
    try {
      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

      if (!token) return res.status(401).json({ error: "Not authenticated." });

      const payload = jwt.verify(token, secret);

      // Trust token payload (no DB query here)
      req.user = {
        id: payload.id,
        username: payload.username,
        role: payload.role,
        district_name: payload.district_name || null,
      };

      return next();
    } catch (e) {
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
