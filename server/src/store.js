const { db } = require("./mongo");

function nowISO(){ return new Date().toISOString(); }

function slugKey(label) {
  const base = String(label || "field").trim().toLowerCase();
  const cleaned = base
    .replace(/[\u0900-\u097F]/g, "") // remove devanagari from key
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || ("field_" + Math.random().toString(36).slice(2, 8));
}

function col(name){ return db().collection(name); }

async function getMaxNumericId(collectionName){
  if (!collectionName) return 0;
  const rows = await col(collectionName)
    .aggregate([
      { $match: { id: { $exists: true } } },
      { $match: { $expr: { $in: [ { $type: "$id" }, ["int","long","double","decimal"] ] } } },
      // Filter out NaN (NaN !== NaN)
      { $match: { $expr: { $eq: ["$id", "$id"] } } },
      { $group: { _id: null, maxId: { $max: "$id" } } }
    ])
    .toArray();
  const maxId = rows[0]?.maxId;
  return Number.isFinite(maxId) ? Number(maxId) : 0;
}

async function ensureCounterHealthy(counterName, collectionName){
  const c = await col("_counters").findOne({ _id: counterName });
  const raw = c?.value;
  const num = typeof raw === "number" ? raw : Number(raw);

  if (Number.isFinite(num)) return;

  const base = await getMaxNumericId(collectionName);
  await col("_counters").updateOne(
    { _id: counterName },
    { $set: { value: base } },
    { upsert: true }
  );
}

async function nextId(counterName, collectionName = null){
  // If counter is corrupted (e.g., NaN), self-heal from max(id) in that collection.
  await ensureCounterHealthy(counterName, collectionName);

  const res = await col("_counters").findOneAndUpdate(
    { _id: counterName },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  const out = Number(res?.value?.value);

  if (!Number.isFinite(out)) {
    // one last repair + retry
    await ensureCounterHealthy(counterName, collectionName);
    const res2 = await col("_counters").findOneAndUpdate(
      { _id: counterName },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    const out2 = Number(res2?.value?.value);
    if (!Number.isFinite(out2)) {
      throw new Error(`Counter '${counterName}' is corrupted and could not be repaired.`);
    }
    return out2;
  }

  return out;
}

/**
 * Repairs any templates that were created with id = NaN / null / missing.
 * This is what breaks the admin Template Builder.
 */
async function repairCorruptTemplateIds(){
  // match: id missing OR null OR NaN
  const bad = await col("templates").find({
    $or: [
      { id: { $exists: false } },
      { id: null },
      { $expr: { $ne: ["$id", "$id"] } } // NaN
    ]
  }).toArray();

  if (!bad.length) return { repaired: 0 };

  // Ensure templates counter is healthy before assigning new ids.
  await ensureCounterHealthy("templates", "templates");

  let repaired = 0;
  for (const doc of bad) {
    const newId = await nextId("templates", "templates");
    await col("templates").updateOne(
      { _id: doc._id },
      { $set: { id: newId, updated_at: nowISO() } }
    );
    repaired++;
  }
  return { repaired };
}

/**
 * Run once on startup to avoid NaN counters breaking IDs.
 */
async function repairCounters(){
  await ensureCounterHealthy("users", "users");
  await ensureCounterHealthy("templates", "templates");
  await ensureCounterHealthy("fields", "fields");
  await ensureCounterHealthy("assignments", "assignments");
  await ensureCounterHealthy("values_kv", "values_kv");
  await repairCorruptTemplateIds();
}

async function ensureIndexes(){
  await col("users").createIndex({ username: 1 }, { unique: true });
  await col("templates").createIndex({ updated_at: -1 });
  await col("fields").createIndex({ template_id: 1, order_index: 1 });
  await col("fields").createIndex({ template_id: 1, field_key: 1 }, { unique: true });
  await col("assignments").createIndex({ template_id: 1, district_user_id: 1 }, { unique: true });
  await col("assignments").createIndex({ district_user_id: 1, updated_at: -1 });
  await col("values_kv").createIndex({ assignment_id: 1, field_key: 1 }, { unique: true });
}

async function getUserByUsername(username){
  return await col("users").findOne({ username: String(username) });
}

async function getUserPublicById(id){
  return await col("users").findOne(
    { id: Number(id) },
    { projection: { _id: 0, id: 1, username: 1, role: 1, district_name: 1 } }
  );
}

async function createUser({ username, password_hash, role, district_name }){
  const id = await nextId("users","users");
  await col("users").insertOne({
    id,
    username: String(username),
    password_hash: String(password_hash),
    role,
    district_name: district_name || null
  });
  return id;
}

async function listUsers(filter={}){
  const q = {};
  if (filter.role) q.role = filter.role;
  return await col("users")
    .find(q, { projection: { _id: 0, password_hash: 0 } })
    .sort({ role: 1, username: 1 })
    .toArray();
}

async function listTemplates(){
  const rows = await col("templates")
    .aggregate([
      { $lookup: { from: "fields", localField: "id", foreignField: "template_id", as: "fields" } },
      { $addFields: { field_count: { $size: "$fields" } } },
      { $project: { _id: 0, fields: 0 } },
      { $sort: { updated_at: -1 } }
    ])
    .toArray();
  return rows;
}

async function createTemplate({ name, created_by }){
  const id = await nextId("templates","templates");
  const ts = nowISO();
  await col("templates").insertOne({
    id,
    name: String(name),
    published: false,
    created_by: created_by || null,
    created_at: ts,
    updated_at: ts
  });
  return id;
}

async function getTemplateById(id){
  return await col("templates").findOne(
    { id: Number(id) },
    { projection: { _id: 0 } }
  );
}

async function getTemplateDetail(id){
  const tpl = await getTemplateById(id);
  if (!tpl) return null;

  const fields = await col("fields")
    .find({ template_id: Number(id) }, { projection: { _id: 0 } })
    .sort({ order_index: 1, id: 1 })
    .toArray();

  return { ...tpl, fields };
}

async function updateTemplate(id, patch){
  await col("templates").updateOne(
    { id: Number(id) },
    { $set: { name: String(patch.name), updated_at: nowISO() } }
  );
}

async function deleteTemplateCascade(template_id){
  template_id = Number(template_id);
  await col("templates").deleteOne({ id: template_id });
  await col("fields").deleteMany({ template_id });
  await col("assignments").deleteMany({ template_id });
}

async function addField({ template_id, label, type, required }){
  template_id = Number(template_id);
  const valid = ["text","textarea","number","date","select"];
  const t = valid.includes(type) ? type : "text";

  const last = await col("fields")
    .find({ template_id }, { projection: { _id: 0, order_index: 1 } })
    .sort({ order_index: -1 })
    .limit(1)
    .toArray();

  const order_index = (last[0]?.order_index || 0) + 1;
  const id = await nextId("fields","fields");
  const field_key = slugKey(label);

  await col("fields").insertOne({
    id,
    template_id,
    field_key,
    label: String(label),
    type: t,
    required: !!required,
    options: [],
    order_index
  });

  await col("templates").updateOne(
    { id: template_id },
    { $set: { updated_at: nowISO() } }
  );
}

async function getFieldById(id){
  return await col("fields").findOne({ id: Number(id) }, { projection: { _id: 0 } });
}

async function updateField(id, patch){
  const $set = {};
  if (patch.label != null) $set.label = String(patch.label);
  if (patch.type != null) $set.type = String(patch.type);
  if (patch.required != null) $set.required = !!patch.required;
  if (patch.options != null) $set.options = Array.isArray(patch.options) ? patch.options : [];
  await col("fields").updateOne({ id: Number(id) }, { $set });
}

async function deleteField(id){
  await col("fields").deleteOne({ id: Number(id) });
}

async function publishTemplate(id){
  await col("templates").updateOne(
    { id: Number(id) },
    { $set: { published: true, updated_at: nowISO() } }
  );
}

async function assignTemplateToDistricts(template_id, districtUserIds){
  template_id = Number(template_id);
  const ts = nowISO();

  for (const uid of districtUserIds.map(Number)) {
    const existing = await col("assignments").findOne({ template_id, district_user_id: uid });
    if (existing) continue;

    const id = await nextId("assignments","assignments");
    await col("assignments").insertOne({
      id,
      template_id,
      district_user_id: uid,
      status: "draft",
      sent_at: null,
      created_at: ts,
      updated_at: ts
    });
  }
}

async function listDistrictAssignments(district_user_id){
  district_user_id = Number(district_user_id);
  return await col("assignments").aggregate([
    { $match: { district_user_id } },
    { $lookup: { from: "templates", localField: "template_id", foreignField: "id", as: "t" } },
    { $unwind: "$t" },
    { $project: { _id: 0, id: 1, status: 1, sent_at: 1, updated_at: 1, template: { id: "$t.id", name: "$t.name", published: "$t.published" } } },
    { $sort: { updated_at: -1 } }
  ]).toArray();
}

async function getDistrictAssignmentDetail(assignment_id, district_user_id){
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id }, { projection: { _id: 0 } });
  if (!a) return null;

  const tpl = await getTemplateDetail(a.template_id);
  if (!tpl) return null;

  const vals = await col("values_kv").find({ assignment_id }, { projection: { _id: 0, field_key: 1, value: 1 } }).toArray();
  const vmap = new Map(vals.map(v => [v.field_key, v.value]));

  return {
    id: a.id,
    status: a.status,
    sent_at: a.sent_at,
    updated_at: a.updated_at,
    template: tpl,
    values: tpl.fields.map(f => ({
      field_key: f.field_key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options : [],
      value: vmap.get(f.field_key) ?? ""
    }))
  };
}

async function saveDistrictValues(assignment_id, district_user_id, values){
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id }, { projection: { _id: 0 } });
  if (!a) return { ok: false, status: 404, error: "Assignment not found." };
  if (a.status === "sent") return { ok: false, status: 400, error: "Already sent. Ask admin to unlock." };

  for (const v of values) {
    const key = String(v.field_key || "");
    const val = (v.value ?? "").toString();

    await col("values_kv").updateOne(
      { assignment_id, field_key: key },
      { $set: { value: val, updated_at: nowISO() }, $setOnInsert: { id: await nextId("values_kv","values_kv"), created_at: nowISO() } },
      { upsert: true }
    );
  }

  await col("assignments").updateOne({ id: assignment_id }, { $set: { updated_at: nowISO() } });
  return { ok: true };
}

async function sendDistrictSubmission(assignment_id, district_user_id){
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id }, { projection: { _id: 0 } });
  if (!a) return { ok: false, status: 404, error: "Assignment not found." };
  if (a.status === "sent") return { ok: false, status: 400, error: "Already sent." };

  const tpl = await getTemplateDetail(a.template_id);
  if (!tpl) return { ok: false, status: 404, error: "Template not found." };

  const fields = tpl.fields;
  const values = await col("values_kv").find({ assignment_id }, { projection: { _id: 0, field_key: 1, value: 1 } }).toArray();
  const vmap = new Map(values.map(v => [v.field_key, (v.value ?? "").trim()]));

  const missing = fields.filter(f => f.required && !vmap.get(f.field_key));
  if (missing.length){
    return { ok: false, status: 400, error: "Required fields missing: " + missing.map(m => m.label).join(", ") };
  }

  const ts = nowISO();
  await col("assignments").updateOne(
    { id: assignment_id },
    { $set: { status: "sent", sent_at: ts, updated_at: ts } }
  );

  const district = await getUserPublicById(district_user_id);

  return {
    ok: true,
    district_name: district?.district_name || district?.username || "District",
    template_name: tpl.name,
    sent_at: ts,
    rows: fields.map(f => ({ label: f.label, value: vmap.get(f.field_key) || "" }))
  };
}

async function listSubmissions(){
  return await col("assignments").aggregate([
    { $lookup: { from: "templates", localField: "template_id", foreignField: "id", as: "t" } },
    { $lookup: { from: "users", localField: "district_user_id", foreignField: "id", as: "u" } },
    { $unwind: "$t" },
    { $unwind: "$u" },
    { $project: { _id: 0, id: 1, status: 1, sent_at: 1, updated_at: 1, template: { id: "$t.id", name: "$t.name" }, district: { id: "$u.id", username: "$u.username", district_name: "$u.district_name" } } },
    { $sort: { updated_at: -1 } }
  ]).toArray();
}

async function getSubmissionDetail(assignment_id){
  assignment_id = Number(assignment_id);

  const a = await col("assignments").findOne({ id: assignment_id }, { projection: { _id: 0 } });
  if (!a) return null;

  const tpl = await getTemplateDetail(a.template_id);
  const district = await getUserPublicById(a.district_user_id);

  const values = await col("values_kv").find({ assignment_id }, { projection: { _id: 0, field_key: 1, value: 1 } }).toArray();
  const vmap = new Map(values.map(v => [v.field_key, v.value]));

  return {
    id: a.id,
    status: a.status,
    sent_at: a.sent_at,
    updated_at: a.updated_at,
    template: tpl ? { id: tpl.id, name: tpl.name } : null,
    district,
    values: tpl?.fields?.map(f => ({ label: f.label, value: vmap.get(f.field_key) ?? "" })) || []
  };
}

async function unlockSubmission(assignment_id){
  await col("assignments").updateOne(
    { id: Number(assignment_id) },
    { $set: { status: "draft", sent_at: null, updated_at: nowISO() } }
  );
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function buildSubmissionEmailHtml({ districtName, templateName, sentAt, rows }) {
  return `
    <div style="font-family: Arial, sans-serif; line-height:1.4">
      <h2>District Submission</h2>
      <p><b>District:</b> ${escapeHtml(districtName)}</p>
      <p><b>Template:</b> ${escapeHtml(templateName)}</p>
      <p><b>Sent at:</b> ${escapeHtml(sentAt)}</p>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <thead><tr><th align="left">Field</th><th align="left">Value</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.value)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

module.exports = {
  repairCounters,

  ensureIndexes,
  getUserByUsername,
  getUserPublicById,
  createUser,
  listUsers,

  listTemplates,
  createTemplate,
  getTemplateById,
  getTemplateDetail,
  updateTemplate,
  deleteTemplateCascade,

  addField,
  getFieldById,
  updateField,
  deleteField,

  publishTemplate,
  assignTemplateToDistricts,

  listSubmissions,
  getSubmissionDetail,
  unlockSubmission,

  listDistrictAssignments,
  getDistrictAssignmentDetail,
  saveDistrictValues,
  sendDistrictSubmission,

  buildSubmissionEmailHtml
};
