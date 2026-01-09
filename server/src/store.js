const { db } = require("./mongo");

function nowISO() {
  return new Date().toISOString();
}
function col(name) {
  return db().collection(name);
}

/** Robust number conversion for BSON Long/Int32/Decimal128/etc */
function toSafeInt(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;

  // Handle BSON numeric objects
  if (typeof v === "object") {
    if (typeof v.toNumber === "function") {
      const n = v.toNumber();
      return Number.isFinite(n) ? n : NaN;
    }
    if (typeof v.valueOf === "function") {
      const vv = v.valueOf();
      if (typeof vv === "number" && Number.isFinite(vv)) return vv;
    }
    if (typeof v.toString === "function") {
      const n = Number(v.toString());
      return Number.isFinite(n) ? n : NaN;
    }
  }

  // strings
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : NaN;
  }

  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const COUNTER_MAP = {
  users: "users",
  templates: "templates",
  fields: "fields",
  assignments: "assignments",
  values_kv: "values_kv",
};

/** Get max numeric id from collection (ignores NaN/null/string that can't convert) */
async function getMaxId(collectionName) {
  const rows = await col(collectionName)
    .aggregate([
      {
        $project: {
          id_num: {
            $convert: {
              input: "$id",
              to: "long",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      { $match: { id_num: { $ne: null } } },
      { $group: { _id: null, maxId: { $max: "$id_num" } } },
    ])
    .toArray();

  const maxId = rows[0]?.maxId;
  const n = toSafeInt(maxId);
  return Number.isFinite(n) ? n : 0;
}

/** Ensure counter exists and is >= max(id) in its collection */
async function syncCounter(counterName, collectionName) {
  const maxId = await getMaxId(collectionName);

  const c = await col("_counters").findOne({ _id: counterName });
  const current = toSafeInt(c?.value);

  const nextBase = Number.isFinite(current) ? Math.max(current, maxId) : maxId;

  await col("_counters").updateOne(
    { _id: counterName },
    { $set: { value: nextBase } },
    { upsert: true }
  );
}

/**
 * Atomic nextId that auto-fixes bad counter types:
 * - converts value to long (onError/onNull => 0)
 * - adds +1
 */
async function nextId(counterName, collectionName = COUNTER_MAP[counterName] || counterName) {
  // keep counter aligned to DB max to avoid collisions
  await syncCounter(counterName, collectionName);

  const res = await col("_counters").findOneAndUpdate(
    { _id: counterName },
    [
      {
        $set: {
          value: {
            $add: [
              {
                $convert: {
                  input: "$value",
                  to: "long",
                  onError: 0,
                  onNull: 0,
                },
              },
              1,
            ],
          },
        },
      },
    ],
    { upsert: true, returnDocument: "after" }
  );

  const out = toSafeInt(res?.value?.value);
  if (!Number.isFinite(out)) {
    // last-resort: force reset to max id and retry once
    await syncCounter(counterName, collectionName);
    const res2 = await col("_counters").findOneAndUpdate(
      { _id: counterName },
      [
        {
          $set: {
            value: {
              $add: [
                {
                  $convert: {
                    input: "$value",
                    to: "long",
                    onError: 0,
                    onNull: 0,
                  },
                },
                1,
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "after" }
    );
    const out2 = toSafeInt(res2?.value?.value);
    if (!Number.isFinite(out2)) {
      throw new Error(`Failed to generate id for counter '${counterName}'. Check _counters collection.`);
    }
    return out2;
  }

  return out;
}

/** Repair documents whose id is missing/null/NaN/string/etc */
async function repairBadIds(collectionName, counterName) {
  const bad = await col(collectionName)
    .aggregate([
      {
        $project: {
          _id: 1,
          id_num: {
            $convert: {
              input: "$id",
              to: "long",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      { $match: { id_num: null } },
    ])
    .toArray();

  if (!bad.length) return { repaired: 0 };

  // make sure counter is aligned first
  await syncCounter(counterName, collectionName);

  let repaired = 0;
  for (const d of bad) {
    const newId = await nextId(counterName, collectionName);
    await col(collectionName).updateOne(
      { _id: d._id },
      { $set: { id: newId, updated_at: nowISO() } }
    );
    repaired++;
  }
  return { repaired };
}

/** Run on server startup */
async function repairDatabase() {
  // fix ids first (so max(id) works properly)
  await repairBadIds("users", "users");
  await repairBadIds("templates", "templates");
  await repairBadIds("fields", "fields");
  await repairBadIds("assignments", "assignments");
  await repairBadIds("values_kv", "values_kv");

  // sync counters again after repairs
  await syncCounter("users", "users");
  await syncCounter("templates", "templates");
  await syncCounter("fields", "fields");
  await syncCounter("assignments", "assignments");
  await syncCounter("values_kv", "values_kv");
}

async function ensureIndexes() {
  // Important indexes (wrap each in try so server doesn't die)
  try { await col("users").createIndex({ id: 1 }, { unique: true }); } catch {}
  try { await col("users").createIndex({ username: 1 }, { unique: true }); } catch {}

  try { await col("templates").createIndex({ id: 1 }, { unique: true }); } catch {}
  try { await col("templates").createIndex({ updated_at: -1 }); } catch {}

  try { await col("fields").createIndex({ id: 1 }, { unique: true }); } catch {}
  try { await col("fields").createIndex({ template_id: 1, order_index: 1 }); } catch {}
  try { await col("fields").createIndex({ template_id: 1, field_key: 1 }, { unique: true }); } catch {}

  try { await col("assignments").createIndex({ id: 1 }, { unique: true }); } catch {}
  try { await col("assignments").createIndex({ template_id: 1, district_user_id: 1 }, { unique: true }); } catch {}
  try { await col("assignments").createIndex({ district_user_id: 1, updated_at: -1 }); } catch {}

  try { await col("values_kv").createIndex({ id: 1 }, { unique: true }); } catch {}
  try { await col("values_kv").createIndex({ assignment_id: 1, field_key: 1 }, { unique: true }); } catch {}
}

/* ================= USERS ================= */

async function getUserByUsername(username) {
  return await col("users").findOne({ username: String(username) });
}

async function getUserPublicById(id) {
  return await col("users").findOne(
    { id: Number(id) },
    { projection: { _id: 0, id: 1, username: 1, role: 1, district_name: 1 } }
  );
}

async function createUser({ username, password_hash, role, district_name }) {
  const id = await nextId("users");
  await col("users").insertOne({
    id,
    username: String(username),
    password_hash: String(password_hash),
    role,
    district_name: district_name || null,
  });
  return id;
}

async function listUsers({ role } = {}) {
  const q = {};
  if (role) q.role = role;

  return await col("users")
    .find(q, { projection: { _id: 0, id: 1, username: 1, role: 1, district_name: 1 } })
    .sort({ id: -1 })
    .toArray();
}

/* ================= TEMPLATES ================= */

async function listTemplates() {
  // ensure ids are clean before returning (prevents id:null in UI)
  await repairBadIds("templates", "templates");

  return await col("templates")
    .aggregate([
      { $lookup: { from: "fields", localField: "id", foreignField: "template_id", as: "fields" } },
      { $addFields: { field_count: { $size: "$fields" } } },
      { $project: { fields: 0 } },
      { $sort: { updated_at: -1 } },
    ])
    .toArray();
}

async function createTemplate({ name, created_by }) {
  const id = await nextId("templates");
  const ts = nowISO();

  await col("templates").insertOne({
    id,
    name: String(name),
    published: false,
    created_by: created_by ?? null,
    created_at: ts,
    updated_at: ts,
  });

  return id;
}

async function getTemplateById(id) {
  return await col("templates").findOne({ id: Number(id) }, { projection: { _id: 0 } });
}

async function getTemplateDetail(id) {
  const tpl = await col("templates").findOne({ id: Number(id) }, { projection: { _id: 0 } });
  if (!tpl) return null;

  const fields = await col("fields")
    .find({ template_id: Number(id) }, { projection: { _id: 0 } })
    .sort({ order_index: 1, id: 1 })
    .toArray();

  return {
    ...tpl,
    fields: fields.map((f) => ({
      ...f,
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options : [],
    })),
  };
}

async function updateTemplate(id, { name }) {
  await col("templates").updateOne(
    { id: Number(id) },
    { $set: { name: String(name), updated_at: nowISO() } }
  );
}

async function publishTemplate(id) {
  await col("templates").updateOne(
    { id: Number(id) },
    { $set: { published: true, updated_at: nowISO() } }
  );
}

async function deleteTemplateCascade(template_id) {
  template_id = Number(template_id);

  const assignmentDocs = await col("assignments")
    .find({ template_id }, { projection: { _id: 0, id: 1 } })
    .toArray();

  const assignmentIds = assignmentDocs.map((a) => a.id);
  if (assignmentIds.length) {
    await col("values_kv").deleteMany({ assignment_id: { $in: assignmentIds } });
  }

  await col("assignments").deleteMany({ template_id });
  await col("fields").deleteMany({ template_id });
  await col("templates").deleteOne({ id: template_id });
}

/* ================= FIELDS ================= */

function slugKey(label) {
  const base = String(label || "field").trim().toLowerCase();
  const cleaned = base
    .replace(/[\u0900-\u097F]/g, "") // remove devanagari from key
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "field_" + Math.random().toString(36).slice(2, 8);
}

async function addField({ template_id, label, type, required }) {
  template_id = Number(template_id);

  const validTypes = ["text", "textarea", "number", "date", "select"];
  const t = validTypes.includes(type) ? type : "text";

  const last = await col("fields")
    .find({ template_id }, { projection: { _id: 0, order_index: 1 } })
    .sort({ order_index: -1 })
    .limit(1)
    .toArray();

  const order_index = (last[0]?.order_index || 0) + 1;

  let key = slugKey(label);
  const id = await nextId("fields");

  try {
    await col("fields").insertOne({
      id,
      template_id,
      field_key: key,
      label: String(label),
      type: t,
      required: !!required,
      options: [],
      order_index,
    });
  } catch (e) {
    // duplicate key -> retry with suffix
    key = key + "_" + Math.random().toString(36).slice(2, 5);
    await col("fields").insertOne({
      id,
      template_id,
      field_key: key,
      label: String(label),
      type: t,
      required: !!required,
      options: [],
      order_index,
    });
  }

  await col("templates").updateOne({ id: template_id }, { $set: { updated_at: nowISO() } });
}

async function getFieldById(id) {
  return await col("fields").findOne({ id: Number(id) }, { projection: { _id: 0 } });
}

async function updateField(id, { label, type, required, options }) {
  const f = await getFieldById(id);
  if (!f) return;

  const validTypes = ["text", "textarea", "number", "date", "select"];
  const patch = {};

  if (label !== undefined) patch.label = String(label);
  if (type !== undefined) patch.type = validTypes.includes(type) ? type : f.type;
  if (required !== undefined) patch.required = !!required;
  if (options !== undefined) patch.options = Array.isArray(options) ? options : [];

  await col("fields").updateOne({ id: Number(id) }, { $set: patch });
  await col("templates").updateOne({ id: f.template_id }, { $set: { updated_at: nowISO() } });
}

async function deleteField(id) {
  const f = await getFieldById(id);
  if (!f) return;

  await col("fields").deleteOne({ id: Number(id) });
  await col("templates").updateOne({ id: f.template_id }, { $set: { updated_at: nowISO() } });
}

/* ================= ASSIGNMENTS / VALUES ================= */

async function assignTemplateToDistricts(template_id, districtUserIds) {
  template_id = Number(template_id);

  const tpl = await getTemplateById(template_id);
  if (!tpl) throw new Error("Template not found.");
  if (!tpl.published) {
    const err = new Error("Publish the template before assigning.");
    err.status = 400;
    throw err;
  }

  const fields = await col("fields")
    .find({ template_id }, { projection: { _id: 0, field_key: 1 } })
    .toArray();

  const fieldKeys = fields.map((f) => f.field_key);
  const ts = nowISO();

  for (const uid of districtUserIds) {
    const user = await col("users").findOne(
      { id: Number(uid), role: "district" },
      { projection: { _id: 0, id: 1 } }
    );
    if (!user) continue;

    const existing = await col("assignments").findOne(
      { template_id, district_user_id: Number(uid) },
      { projection: { _id: 0, id: 1 } }
    );

    let assignmentId;
    if (existing) {
      assignmentId = existing.id;
      await col("assignments").updateOne({ id: assignmentId }, { $set: { updated_at: ts } });
    } else {
      assignmentId = await nextId("assignments");
      await col("assignments").insertOne({
        id: assignmentId,
        template_id,
        district_user_id: Number(uid),
        status: "draft",
        sent_at: null,
        created_at: ts,
        updated_at: ts,
      });
    }

    if (fieldKeys.length) {
      const ops = fieldKeys.map((k) => ({
        updateOne: {
          filter: { assignment_id: assignmentId, field_key: k },
          update: {
            $setOnInsert: {
              id: 0,
              assignment_id: assignmentId,
              field_key: k,
              value: "",
              updated_at: ts,
            },
          },
          upsert: true,
        },
      }));

      await col("values_kv").bulkWrite(ops, { ordered: false });

      const missingId = await col("values_kv")
        .find({ assignment_id: assignmentId, id: 0 }, { projection: { _id: 1 } })
        .toArray();

      for (const d of missingId) {
        const newId = await nextId("values_kv");
        await col("values_kv").updateOne({ _id: d._id }, { $set: { id: newId } });
      }
    }
  }
}

async function listSubmissions() {
  return await col("assignments")
    .aggregate([
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
          template_name: "$t.name",
          district_username: "$u.username",
          district_name: { $ifNull: ["$u.district_name", "$u.username"] },
        },
      },
      { $sort: { updated_at: -1 } },
    ])
    .toArray();
}

async function getSubmissionDetail(assignment_id) {
  assignment_id = Number(assignment_id);

  const a = await col("assignments").findOne({ id: assignment_id });
  if (!a) return null;

  const t = await getTemplateById(a.template_id);
  const u = await col("users").findOne(
    { id: a.district_user_id },
    { projection: { _id: 0, username: 1, district_name: 1 } }
  );

  const fields = await col("fields")
    .find(
      { template_id: a.template_id },
      { projection: { _id: 0, field_key: 1, label: 1, order_index: 1, id: 1 } }
    )
    .sort({ order_index: 1, id: 1 })
    .toArray();

  const values = await col("values_kv")
    .find({ assignment_id }, { projection: { _id: 0, field_key: 1, value: 1 } })
    .toArray();

  const vmap = new Map(values.map((v) => [v.field_key, v.value]));

  return {
    id: a.id,
    status: a.status,
    sent_at: a.sent_at,
    updated_at: a.updated_at,
    template_name: t?.name || "",
    district_name: u?.district_name || u?.username || "",
    values: fields.map((f) => ({
      field_key: f.field_key,
      label: f.label,
      value: vmap.get(f.field_key) ?? "",
    })),
  };
}

async function unlockSubmission(assignment_id) {
  await col("assignments").updateOne(
    { id: Number(assignment_id) },
    { $set: { status: "draft", sent_at: null, updated_at: nowISO() } }
  );
}

async function listDistrictAssignments(district_user_id) {
  district_user_id = Number(district_user_id);

  return await col("assignments")
    .aggregate([
      { $match: { district_user_id } },
      { $lookup: { from: "templates", localField: "template_id", foreignField: "id", as: "t" } },
      { $unwind: "$t" },
      { $project: { _id: 0, id: 1, status: 1, sent_at: 1, updated_at: 1, template_name: "$t.name" } },
      { $sort: { updated_at: -1 } },
    ])
    .toArray();
}

async function getDistrictAssignmentDetail(assignment_id, district_user_id) {
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id });
  if (!a) return null;

  const t = await getTemplateById(a.template_id);
  const fields = await col("fields")
    .find({ template_id: a.template_id }, { projection: { _id: 0 } })
    .sort({ order_index: 1, id: 1 })
    .toArray();

  const values = await col("values_kv")
    .find({ assignment_id }, { projection: { _id: 0, field_key: 1, value: 1 } })
    .toArray();

  return {
    id: a.id,
    template_name: t?.name || "",
    status: a.status,
    sent_at: a.sent_at,
    updated_at: a.updated_at,
    fields: fields.map((f) => ({
      ...f,
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options : [],
    })),
    values,
  };
}

async function saveDistrictValues(assignment_id, district_user_id, values) {
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id });
  if (!a) return { ok: false, status: 404, error: "Assignment not found." };
  if (a.status === "sent") return { ok: false, status: 400, error: "Already sent. Ask admin to unlock." };

  const ts = nowISO();
  const ops = [];

  for (const v of values) {
    if (!v.field_key) continue;
    ops.push({
      updateOne: {
        filter: { assignment_id, field_key: String(v.field_key) },
        update: {
          $set: { value: String(v.value ?? ""), updated_at: ts },
          $setOnInsert: { id: 0, assignment_id, field_key: String(v.field_key) },
        },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await col("values_kv").bulkWrite(ops, { ordered: false });

    const missingId = await col("values_kv")
      .find({ assignment_id, id: 0 }, { projection: { _id: 1 } })
      .toArray();

    for (const d of missingId) {
      const newId = await nextId("values_kv");
      await col("values_kv").updateOne({ _id: d._id }, { $set: { id: newId } });
    }
  }

  await col("assignments").updateOne({ id: assignment_id }, { $set: { updated_at: ts } });
  return { ok: true };
}

async function sendDistrictSubmission(assignment_id, district_user_id) {
  assignment_id = Number(assignment_id);
  district_user_id = Number(district_user_id);

  const a = await col("assignments").findOne({ id: assignment_id, district_user_id });
  if (!a) return { ok: false, status: 404, error: "Assignment not found." };
  if (a.status === "sent") return { ok: false, status: 400, error: "Already sent." };

  const fields = await col("fields")
    .find(
      { template_id: a.template_id },
      { projection: { _id: 0, field_key: 1, label: 1, required: 1, order_index: 1, id: 1 } }
    )
    .sort({ order_index: 1, id: 1 })
    .toArray();

  const values = await col("values_kv")
    .find({ assignment_id }, { projection: { _id: 0, field_key: 1, value: 1 } })
    .toArray();

  const vmap = new Map(values.map((v) => [v.field_key, (v.value ?? "").trim()]));

  const missing = fields.filter((f) => f.required && !vmap.get(f.field_key));
  if (missing.length) {
    return { ok: false, status: 400, error: "Required fields missing: " + missing.map((m) => m.label).join(", ") };
  }

  const ts = nowISO();
  await col("assignments").updateOne(
    { id: assignment_id },
    { $set: { status: "sent", sent_at: ts, updated_at: ts } }
  );

  const t = await getTemplateById(a.template_id);
  const u = await col("users").findOne(
    { id: district_user_id },
    { projection: { _id: 0, username: 1, district_name: 1 } }
  );

  const rows = fields.map((f) => ({ label: f.label, value: vmap.get(f.field_key) || "" }));

  return {
    ok: true,
    district_name: u?.district_name || u?.username || "",
    template_name: t?.name || "",
    sent_at: ts,
    rows,
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
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
          ${rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.value)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

module.exports = {
  repairDatabase,
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
  publishTemplate,
  deleteTemplateCascade,

  addField,
  getFieldById,
  updateField,
  deleteField,

  assignTemplateToDistricts,

  listSubmissions,
  getSubmissionDetail,
  unlockSubmission,

  listDistrictAssignments,
  getDistrictAssignmentDetail,
  saveDistrictValues,
  sendDistrictSubmission,

  buildSubmissionEmailHtml,
};
