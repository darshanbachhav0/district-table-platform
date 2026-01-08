const bcrypt = require("bcryptjs");
const store = require("./store");

async function ensureUser({ username, password, role, district_name }) {
  const existing = await store.getUserByUsername(username);
  if (existing) return existing.id;

  const hash = await bcrypt.hash(password, 10);
  const id = await store.createUser({
    username,
    password_hash: hash,
    role,
    district_name: district_name || null
  });
  return id;
}

async function seed({ adminUsername, adminPassword, districtDefaultPassword }) {
  if (!adminUsername || !adminPassword || !districtDefaultPassword) {
    throw new Error("seed() missing required credentials. Provide ADMIN_USERNAME, ADMIN_PASSWORD, DISTRICT_DEFAULT_PASSWORD in environment.");
  }

  await ensureUser({ username: adminUsername, password: adminPassword, role: "admin" });

  const defaults = [
    ["amravati_rural", "अमरावती ग्रामीण / Amravati Rural"],
    ["amravati_city", "अमरावती शहर / Amravati City"],
    ["buldhana", "बुलढाणा / Buldhana"],
    ["washim", "वाशिम / Washim"],
    ["yavatmal", "यवतमाळ / Yavatmal"],
    ["akola", "अकोला / Akola"]
  ];

  for (const [u, name] of defaults) {
    await ensureUser({ username: u, password: districtDefaultPassword, role: "district", district_name: name });
  }
}

module.exports = { seed };
