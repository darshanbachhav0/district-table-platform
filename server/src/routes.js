const express = require("express");
const bcrypt = require("bcryptjs");
const { signToken, requireRole } = require("./auth");
const { run, get, all } = require("./db");
const { sendSubmissionEmail } = require("./mailer");

const router = express.Router();

function nowISO() { return new Date().toISOString(); }
function slugKey(label) {
  const base = String(label || "field").trim().toLowerCase();
  const cleaned = base
    .replace(/[\u0900-\u097F]/g, "") // remove devanagari from key
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || ("field_" + Math.random().toString(36).slice(2, 8));
}

// Public: login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Username and password required." });

    const user = await get("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const secret = req.app?.locals?.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Server misconfigured: missing JWT secret." });

    const token = signToken(user, secret);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, district_name: user.district_name || null } });
  } catch (e) {
    console.error("Login failed:", e);
    return res.status(500).json({ error: "Login failed. Check server logs." });
  }
});

// Auth: me
router.get("/me", async (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role, district_name: req.user.district_name || null });
});

/* ===================== ADMIN ===================== */

// list users
router.get("/admin/users", requireRole("admin"), async (req, res) => {
  const role = req.query.role;
  const rows = role
    ? await all("SELECT id, username, role, district_name FROM users WHERE role = ? ORDER BY id DESC", [role])
    : await all("SELECT id, username, role, district_name FROM users ORDER BY id DESC");
  res.json(rows);
});

// create district user
router.post("/admin/users", requireRole("admin"), async (req, res) => {
  const { username, password, role, district_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required." });
  const r = role || "district";
  if (!["district","admin"].includes(r)) return res.status(400).json({ error: "Invalid role." });

  const existing = await get("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) return res.status(400).json({ error: "Username already exists." });

  const hash = await bcrypt.hash(password, 10);
  const out = await run("INSERT INTO users(username,password_hash,role,district_name) VALUES (?,?,?,?)",
    [username, hash, r, district_name || null]);
  res.json({ id: out.id });
});

// templates list
router.get("/admin/templates", requireRole("admin"), async (req, res) => {
  const rows = await all(`
    SELECT t.*,
      (SELECT COUNT(*) FROM fields f WHERE f.template_id=t.id) AS field_count
    FROM templates t
    ORDER BY t.updated_at DESC
  `);
  res.json(rows);
});

// create template
router.post("/admin/templates", requireRole("admin"), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required." });
  const ts = nowISO();
  const r = await run(
    "INSERT INTO templates(name,published,created_by,created_at,updated_at) VALUES (?,?,?,?,?)",
    [name, 0, req.user.id, ts, ts]
  );
  res.json({ id: r.id });
});

// get template details
router.get("/admin/templates/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const tpl = await get("SELECT * FROM templates WHERE id = ?", [id]);
  if (!tpl) return res.status(404).json({ error: "Template not found." });

  const fields = await all("SELECT * FROM fields WHERE template_id = ? ORDER BY order_index ASC, id ASC", [id]);
  res.json({
    ...tpl,
    fields: fields.map(f => ({ ...f, required: !!f.required, options: f.options_json ? JSON.parse(f.options_json) : [] }))
  });
});

// update template
router.put("/admin/templates/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required." });
  await run("UPDATE templates SET name=?, updated_at=? WHERE id=?", [name, nowISO(), id]);
  res.json({ ok: true });
});

// delete template
router.delete("/admin/templates/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  await run("DELETE FROM templates WHERE id=?", [id]);
  res.json({ ok: true });
});

// add field
router.post("/admin/templates/:id/fields", requireRole("admin"), async (req, res) => {
  const template_id = Number(req.params.id);
  const tpl = await get("SELECT * FROM templates WHERE id=?", [template_id]);
  if (!tpl) return res.status(404).json({ error: "Template not found." });

  const { label, type, required } = req.body || {};
  if (!label) return res.status(400).json({ error: "label required." });
  const t = ["text","textarea","number","date","select"].includes(type) ? type : "text";
  const key = slugKey(label);

  const maxOrder = await get("SELECT COALESCE(MAX(order_index),0) AS m FROM fields WHERE template_id=?", [template_id]);
  const order_index = (maxOrder?.m || 0) + 1;

  try{
    await run(
      "INSERT INTO fields(template_id,field_key,label,type,required,options_json,order_index) VALUES (?,?,?,?,?,?,?)",
      [template_id, key, label, t, required ? 1 : 0, "[]", order_index]
    );
  }catch(e){
    // if duplicate key, add random suffix
    const key2 = key + "_" + Math.random().toString(36).slice(2,5);
    await run(
      "INSERT INTO fields(template_id,field_key,label,type,required,options_json,order_index) VALUES (?,?,?,?,?,?,?)",
      [template_id, key2, label, t, required ? 1 : 0, "[]", order_index]
    );
  }

  await run("UPDATE templates SET updated_at=? WHERE id=?", [nowISO(), template_id]);
  res.json({ ok: true });
});

// update field
router.put("/admin/fields/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const f = await get("SELECT * FROM fields WHERE id=?", [id]);
  if (!f) return res.status(404).json({ error: "Field not found." });

  const { label, type, required, options } = req.body || {};
  const t = type && ["text","textarea","number","date","select"].includes(type) ? type : f.type;
  const reqd = (required === undefined) ? f.required : (required ? 1 : 0);
  const lbl = (label === undefined) ? f.label : String(label);

  let options_json = f.options_json;
  if (options !== undefined){
    options_json = JSON.stringify(Array.isArray(options) ? options : []);
  }

  await run("UPDATE fields SET label=?, type=?, required=?, options_json=? WHERE id=?",
    [lbl, t, reqd, options_json, id]);
  await run("UPDATE templates SET updated_at=? WHERE id=?", [nowISO(), f.template_id]);
  res.json({ ok: true });
});

// delete field
router.delete("/admin/fields/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const f = await get("SELECT * FROM fields WHERE id=?", [id]);
  if (!f) return res.status(404).json({ error: "Field not found." });
  await run("DELETE FROM fields WHERE id=?", [id]);
  await run("UPDATE templates SET updated_at=? WHERE id=?", [nowISO(), f.template_id]);
  res.json({ ok: true });
});

// publish template
router.post("/admin/templates/:id/publish", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  await run("UPDATE templates SET published=1, updated_at=? WHERE id=?", [nowISO(), id]);
  res.json({ ok: true });
});

// assign template to districts
router.post("/admin/templates/:id/assign", requireRole("admin"), async (req, res) => {
  const template_id = Number(req.params.id);
  const tpl = await get("SELECT * FROM templates WHERE id=?", [template_id]);
  if (!tpl) return res.status(404).json({ error: "Template not found." });
  if (!tpl.published) return res.status(400).json({ error: "Publish the template before assigning." });

  const { districtUserIds } = req.body || {};
  if (!Array.isArray(districtUserIds) || !districtUserIds.length) return res.status(400).json({ error: "districtUserIds required." });

  const ts = nowISO();
  for (const uid of districtUserIds){
    const user = await get("SELECT * FROM users WHERE id=? AND role='district'", [uid]);
    if (!user) continue;

    // upsert assignment
    const existing = await get("SELECT id FROM assignments WHERE template_id=? AND district_user_id=?", [template_id, uid]);
    if (existing) {
      await run("UPDATE assignments SET updated_at=? WHERE id=?", [ts, existing.id]);
    } else {
      await run(
        "INSERT INTO assignments(template_id,district_user_id,status,created_at,updated_at) VALUES (?,?,?,?,?)",
        [template_id, uid, "draft", ts, ts]
      );
    }

    // ensure values rows exist for each field
    const fields = await all("SELECT field_key FROM fields WHERE template_id=?", [template_id]);
    const assignment = await get("SELECT id FROM assignments WHERE template_id=? AND district_user_id=?", [template_id, uid]);
    for (const fld of fields){
      const kv = await get("SELECT id FROM values_kv WHERE assignment_id=? AND field_key=?", [assignment.id, fld.field_key]);
      if (!kv){
        await run("INSERT INTO values_kv(assignment_id,field_key,value,updated_at) VALUES (?,?,?,?)",
          [assignment.id, fld.field_key, "", ts]);
      }
    }
  }

  res.json({ ok: true });
});

// submissions list (all assignments)
router.get("/admin/submissions", requireRole("admin"), async (req, res) => {
  const rows = await all(`
    SELECT a.id, a.status, a.sent_at, a.updated_at,
           t.name AS template_name,
           u.username AS district_username,
           COALESCE(u.district_name, u.username) AS district_name
    FROM assignments a
    JOIN templates t ON t.id = a.template_id
    JOIN users u ON u.id = a.district_user_id
    ORDER BY a.updated_at DESC
  `);
  res.json(rows);
});

// submission details
router.get("/admin/submissions/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const a = await get(`
    SELECT a.*, t.name AS template_name, COALESCE(u.district_name, u.username) AS district_name
    FROM assignments a
    JOIN templates t ON t.id=a.template_id
    JOIN users u ON u.id=a.district_user_id
    WHERE a.id=?
  `, [id]);
  if (!a) return res.status(404).json({ error: "Submission not found." });

  const fields = await all("SELECT field_key, label, order_index FROM fields WHERE template_id=? ORDER BY order_index ASC, id ASC", [a.template_id]);
  const values = await all("SELECT field_key, value FROM values_kv WHERE assignment_id=?", [id]);
  const vmap = new Map(values.map(v => [v.field_key, v.value]));

  res.json({
    id: a.id,
    status: a.status,
    sent_at: a.sent_at,
    updated_at: a.updated_at,
    template_name: a.template_name,
    district_name: a.district_name,
    values: fields.map(f => ({ field_key: f.field_key, label: f.label, value: vmap.get(f.field_key) ?? "" }))
  });
});

// unlock submission for district editing
router.post("/admin/submissions/:id/unlock", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  await run("UPDATE assignments SET status='draft', sent_at=NULL, updated_at=? WHERE id=?", [nowISO(), id]);
  res.json({ ok: true });
});

/* ===================== DISTRICT ===================== */

// list assignments for district user
router.get("/district/assignments", requireRole("district"), async (req, res) => {
  const rows = await all(`
    SELECT a.id, a.status, a.sent_at, a.updated_at,
           t.name AS template_name
    FROM assignments a
    JOIN templates t ON t.id = a.template_id
    WHERE a.district_user_id=?
    ORDER BY a.updated_at DESC
  `, [req.user.id]);
  res.json(rows);
});

// assignment details
router.get("/district/assignments/:id", requireRole("district"), async (req, res) => {
  const id = Number(req.params.id);
  const a = await get(`
    SELECT a.*, t.name AS template_name
    FROM assignments a
    JOIN templates t ON t.id=a.template_id
    WHERE a.id=? AND a.district_user_id=?
  `, [id, req.user.id]);
  if (!a) return res.status(404).json({ error: "Assignment not found." });

  const fields = await all("SELECT field_key, label, type, required, options_json, order_index FROM fields WHERE template_id=? ORDER BY order_index ASC, id ASC", [a.template_id]);
  const values = await all("SELECT field_key, value FROM values_kv WHERE assignment_id=?", [id]);

  res.json({
    id: a.id,
    template_name: a.template_name,
    status: a.status,
    sent_at: a.sent_at,
    updated_at: a.updated_at,
    fields: fields.map(f => ({ field_key: f.field_key, label: f.label, type: f.type, required: !!f.required, options: f.options_json ? JSON.parse(f.options_json) : [] })),
    values
  });
});

// save values (draft)
router.put("/district/assignments/:id", requireRole("district"), async (req, res) => {
  const id = Number(req.params.id);
  const a = await get("SELECT * FROM assignments WHERE id=? AND district_user_id=?", [id, req.user.id]);
  if (!a) return res.status(404).json({ error: "Assignment not found." });
  if (a.status === "sent") return res.status(400).json({ error: "Already sent. Ask admin to unlock." });

  const { values } = req.body || {};
  if (!Array.isArray(values)) return res.status(400).json({ error: "values[] required." });

  const ts = nowISO();
  for (const v of values){
    if (!v.field_key) continue;
    await run(
      "INSERT INTO values_kv(assignment_id,field_key,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(assignment_id,field_key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      [id, v.field_key, String(v.value ?? ""), ts]
    );
  }
  await run("UPDATE assignments SET updated_at=? WHERE id=?", [ts, id]);
  res.json({ ok: true });
});

// send (lock + email)
router.post("/district/assignments/:id/send", requireRole("district"), async (req, res) => {
  const id = Number(req.params.id);
  const a = await get(`
    SELECT a.*, t.name AS template_name
    FROM assignments a
    JOIN templates t ON t.id=a.template_id
    WHERE a.id=? AND a.district_user_id=?
  `, [id, req.user.id]);
  if (!a) return res.status(404).json({ error: "Assignment not found." });
  if (a.status === "sent") return res.status(400).json({ error: "Already sent." });

  // validate required fields
  const fields = await all("SELECT field_key, label, required, order_index FROM fields WHERE template_id=? ORDER BY order_index ASC, id ASC", [a.template_id]);
  const values = await all("SELECT field_key, value FROM values_kv WHERE assignment_id=?", [id]);
  const vmap = new Map(values.map(v => [v.field_key, (v.value ?? "").trim()]));

  const missing = fields.filter(f => f.required && !vmap.get(f.field_key));
  if (missing.length){
    return res.status(400).json({ error: "Required fields missing: " + missing.map(m => m.label).join(", ") });
  }

  const ts = nowISO();
  await run("UPDATE assignments SET status='sent', sent_at=?, updated_at=? WHERE id=?", [ts, ts, id]);

  // email admin (best-effort)
  const adminEmail = process.env.ADMIN_EMAIL;
  let emailResult = null;

  const rows = fields
    .sort((x,y) => (x.order_index||0)-(y.order_index||0))
    .map(f => ({ label: f.label, value: vmap.get(f.field_key) || "" }));

  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.4">
      <h2>District Submission</h2>
      <p><b>District:</b> ${req.user.district_name || req.user.username}</p>
      <p><b>Template:</b> ${a.template_name}</p>
      <p><b>Sent at:</b> ${ts}</p>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <thead><tr><th align="left">Field</th><th align="left">Value</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.value)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;

  try{
    emailResult = await sendSubmissionEmail(process.env, {
      to: adminEmail,
      subject: `Submission: ${req.user.district_name || req.user.username} — ${a.template_name}`,
      html
    });
  }catch(e){
    console.warn("Email send failed:", e.message);
  }

  res.json({
    ok: true,
    message: emailResult?.ok ? "Sent to admin (email delivered) ✅" :
             emailResult?.skipped ? "Sent to admin ✅ (email not configured; see server console)" :
             "Sent to admin ✅ (email failed; check server logs)"
  });
});

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

module.exports = router;
