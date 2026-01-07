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

async function seed({ adminUsername, adminPassword, districtDefaultPassword }) {
  if (!adminUsername || !adminPassword || !districtDefaultPassword) {
    throw new Error(
      "seed() missing required credentials. Provide ADMIN_USERNAME, ADMIN_PASSWORD, DISTRICT_DEFAULT_PASSWORD in environment."
    );
  }

  // Admin
  await ensureUser({ username: adminUsername, password: adminPassword, role: "admin" });

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
    await ensureUser({ username: u, password: districtDefaultPassword, role: "district", district_name: name });
  }
}

module.exports = { seed };
