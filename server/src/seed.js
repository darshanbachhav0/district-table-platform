const bcrypt = require("bcryptjs");
const { get, run, all } = require("./db");

async function ensureUser({ username, password, role, district_name }) {
  const existing = await get("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) return existing.id;

  const hash = await bcrypt.hash(password, 10);
  const r = await run(
    "INSERT INTO users(username,password_hash,role,district_name) VALUES (?,?,?,?)",
    [username, hash, role, district_name || null]
  );
  return r.id;
}

async function seed() {
  // Admin
  await ensureUser({ username: "admin", password: "admin123", role: "admin" });

  // Default districts
  const defaults = [
    ["amravati_rural", "अमरावती ग्रामीण / Amravati Rural"],
    ["amravati_city", "अमरावती शहर / Amravati City"],
    ["buldhana", "बुलढाणा / Buldhana"],
    ["washim", "वाशिम / Washim"],
    ["yavatmal", "यवतमाळ / Yavatmal"],
    ["akola", "अकोला / Akola"],
  ];
  for (const [u, name] of defaults) {
    await ensureUser({ username: u, password: "district123", role: "district", district_name: name });
  }
}

module.exports = { seed };
