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
      // keep only numeric BSON types
      { $match: { $expr: { $in: [ { $type: "$id" }, ["int","long","double","decimal"] ] } } },
      // filter out NaN (because NaN !== NaN)
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

  // Detect corrupted counters (undefined, null, NaN, non-numeric string, etc.)
  const num = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(num)) return;

  const base = await getMaxNumericId(collectionName);
  await col("_counters").updateOne(
    { _id: counterName },
    { $set: { value: base } },
    { upsert: true }
  );
}

async function nextId(counterName, collectionName){
  // Self-heal counter if it was corrupted (common when value becomes NaN)
  await ensureCounterHealthy(counterName, collectionName);

  const res = await col("_counters").findOneAndUpdate(
    { _id: counterName },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  const out = Number(res?.value?.value);

  if (!Number.isFinite(out)) {
    // One last attempt: repair and retry
    await ensureCounterHealthy(counterName, collectionName);

    const res2 = await col("_counters").findOneAndUpdate(
      { _id: counterName },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after" }
    );

    const out2 = Number(res2?.value?.value);
    if (!Number.isFinite(out2)) {
      throw new Error(`Counter '${counterName}' is corrupted (value=${String(res2?.value?.value)}).`);
    }
    return out2;
  }

  return out;
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

/* ================= USERS ================= */

async function getUserByUsername(username){
  return await col("users").findOne({ username: String(username) });
}

async function getUserPublicById(id){
  const u = await col("users").findOne(
    { id: Number(id) },
    { projection: { _id: 0, id: 1, username: 1, role: 1, district_name: 1 } }
  );
  return u || null;
}

async function createUser({ username, password_hash, role, district_name }){
  const id = await nextId("users", "users");
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
  const rows = await col("users")
    .find(q, { projection: { _id: 0, password_hash: 0 } })
    .sort({ role: 1, username: 1 })
    .toArray();
  return rows;
}

/* ================= TEMPLATES ================= */

async function listTemplates(){
  const rows = await col("templates")
    .aggregate([
      // hide corrupted templates (id=NaN becomes null in JSON)
      { $match: { $expr: { $in: [ { $type: "$id" }, ["int","long","double","decimal"] ] } } },
      { $match: { $expr: { $eq: ["$id", "$id"] } } },
      { $lookup: { from: "fields", localField: "id", foreignField: "template_id", as: "fields" } },
      { $addFields: { field_count: { $size: "$fields" } } },
      { $project: { _id: 0, fields: 0 } },
      { $sort: { updated_at: -1 } }
    ])
    .toArray();
  return rows;
}

async function createTemplate({ name, created_by }){
  const id = await nextId("templates", "templates");
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
  id = Number(id);
  const tpl = await col("templates").findOne(
    { id },
    { projection: { _id: 0 } }
  );
  return tpl || null;
}

async function getTemplateDetail(id){
  const tpl = await getTemplateById(id);
  if (!tpl) return null;
  const fields = await col("fields")
    .find({ template_id: Number(id) }, { projection: { _id: 0 } })
    .sort({ order_index: 1, id: 1 })
    .toArray();

  return {
    ...tpl,
    fields: fields.map(f => ({ ...f, required: !!f.required, options: Array.isArray(f.options) ? f.options : [] }))
  };
}

async function updateTemplate(id, patch){
  id = Number(id);
  const ts = nowISO();
  await col("templates").updateOne(
    { id },
    { $set: { name: String(patch.name), updated_at: ts } }
  );
}

async function deleteTemplateCascade(template_id){
  template_id = Number(template_id);
  await col("templates").deleteOne({ id: template_id });
  await col("fields").deleteMany({ template_id });
  await col("assignments").deleteMany({ template_id });
  // values_kv is by assignment_id; assignments removed so orphan cleanup optional
}

/* ================= FIELDS ================= */

async function addField({ template_id, label, type, required }){
  template_id = Number(template_id);
  const validTypes = ["text","textarea","number","date","select"];
  const t = validTypes.includes(type) ? type : "text";

  const last = await col("fields")
    .find({ template_id }, { projection: { _id: 0, order_index: 1 } })
    .sort({ order_index: -1 })
    .limit(1)
    .toArray();

  const order_index = (last[0]?.order_index || 0) + 1;

  let key = slugKey(label);
  const id = await nextId("fields", "fields");

  // Enforce uniqueness per template (index also exists)
  try{
    await col("fields").insertOne({
      id,
      template_id,
      field_key: key,
      label: String(label),
      type: t,
      required: !!required,
      options: [],
      order_index
    });
  }catch(e){
    // If key collision occurs, retry with suffix
    key = key + "_" + Math.random().toString(36).slice(2,5);
    await col("fields").insertOne({
      id,
      template_id,
      field_key: key,
      label: String(label),
      type: t,
      required: !!required,
      options: [],
      order_index
    });
  }

  await col("templates").updateOne({ id: template_id }, { $set: { updated_at: nowISO() } });
}

async function getFieldById(id){
  const f = await col("fields").findOne({ id: Number(id) }, { projection: { _id: 0 } });
  return f || null;
}

async function updateField(id, patch){
  id = Number(id);
  const $set = {};
  if (patch.label != null) $set.label = String(patch.label);
  if (patch.type != null) $set.type = String(patch.type);
  if (patch.required != null) $set.required = !!patch.required;
  if (patch.options != null) $set.options = Array.isArray(patch.options) ? patch.options : [];

  await col("fields").updateOne({ id }, { $set });
}

async function deleteField(id){
  id = Number(id);
  const f = await col("fields").findOne({ id }, { projection: { _id: 0, template_id: 1 } });
  await col("fields").deleteOne({ id });
  if (f?.template_id != null) {
    await col("templates").updateOne({ id: f.template_id }, { $set: { updated_at: nowISO() } });
  }
}

/* ================= ASSIGNMENTS / SUBMISSIONS ================= */

async function assignTemplateToDistricts(template_id, districtUserIds){
  template_id = Number(template_id);

  // prevent assignment of unpublished templates
  const tpl = await getTemplateById(template_id);
  if (!tpl) {
    const err = new Error("Template not found.");
    err.status = 404;
    throw err;
  }
  if (!tpl.published) {
    const err = new Error("Template must be published before assignment.");
    err.status = 400;
    throw err;
  }

  const ts = nowISO();

  for (const uid of districtUserIds.map(Number)) {
    // upsert assignment
    const existing = await col("assignments").findOne({ template_id, district_user_id: uid });
    if (existing) continue;

    const id = await nextId("assignments", "assignments");
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

async function publishTemplate(id){
  id = Number(id);
  await col("templates").updateOne({ id }, { $set: { published: true, updated_at: nowISO() } });
}

async function listDistrictAssignments(district_user_id){
  district_user_id = Number(district_user_id);
  const rows = await col("assignments").aggregate([
    { $match: { district_user_id } },
    { $lookup: { from: "templates", localField: "template_id", foreignField: "id", as: "t" } },
    { $unwind: "$t" },
    {
      $project: {
        _id: 0,
        id: 1,
        status: 1,
        sent_at: 1,
        updated_at: 1,
        template: { id: "$t.id", name: "$t.name", published: "$t.published" }
      }
    },
    { $sort: { updated_at: -1 } }
  ]).toArray();
  return rows;
}

async function getDistrictAssignmentDetail(assignment_id, district_user_id){
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id }, { projection: { _id: 0 } });
  if (!a) return null;

  const tpl = await getTemplateDetail(a.template_id);
  if (!tpl) return null;

  const values = await col("values_kv").find(
    { assignment_id },
    { projection: { _id: 0, field_key: 1, value: 1 } }
  ).toArray();

  const vmap = new Map(values.map(v => [v.field_key, v.value]));

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

  const tpl = await getTemplateDetail(a.template_id);
  if (!tpl) return { ok: false, status: 404, error: "Template not found." };

  const fields = tpl.fields;

  // Upsert values
  for (const v of values) {
    const key = String(v.field_key || "");
    const val = (v.value ?? "").toString();

    const f = fields.find(x => x.field_key === key);
    if (!f) continue;

    await col("values_kv").updateOne(
      { assignment_id, field_key: key },
      { $set: { value: val, updated_at: nowISO() }, $setOnInsert: { id: await nextId("values_kv", "values_kv"), created_at: nowISO() } },
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
  const rows = await col("assignments").aggregate([
    { $lookup: { from: "templates", localField: "template_id", foreignField: "id", as: "t" } },
    { $lookup: { from: "users", localField: "district_user_id", foreignField: "id", as: "u" } },
    { $unwind: "$t" },
    { $unwind: "$u" },
    {
      $project: {
        _id: 0,
        id: 1,
        status: 1,
        sent_at: 1,
        updated_at: 1,
        template: { id: "$t.id", name: "$t.name" },
        district: { id: "$u.id", username: "$u.username", district_name: "$u.district_name" }
      }
    },
    { $sort: { updated_at: -1 } }
  ]).toArray();
  return rows;
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
    values: tpl?.fields?.map(f => ({
      label: f.label,
      value: vmap.get(f.field_key) ?? ""
    })) || []
  };
}

async function unlockSubmission(assignment_id){
  await col("assignments").updateOne(
    { id: Number(assignment_id) },
    { $set: { status: "draft", sent_at: null, updated_at: nowISO() } }
  );
}

function buildSubmissionEmailHtml({ districtName, templateName, sentAt, rows }){
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const tableRows = rows.map(r => `<tr><td style="padding:6px 10px;border:1px solid #ddd;"><b>${esc(r.label)}</b></td><td style="padding:6px 10px;border:1px solid #ddd;">${esc(r.value)}</td></tr>`).join("");
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;">
      <h2>New Submission</h2>
      <p><b>District:</b> ${esc(districtName)}</p>
      <p><b>Template:</b> ${esc(templateName)}</p>
      <p><b>Sent at:</b> ${esc(sentAt)}</p>
      <table style="border-collapse:collapse;border:1px solid #ddd;">${tableRows}</table>
    </div>
  `;
}

module.exports = {
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

  listDistrictAssignments,
  getDistrictAssignmentDetail,
  saveDistrictValues,
  sendDistrictSubmission,

  listSubmissions,
  getSubmissionDetail,
  unlockSubmission,

  buildSubmissionEmailHtml,
};
