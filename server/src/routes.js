const express = require("express");
const bcrypt = require("bcryptjs");
const { signToken, requireRole } = require("./auth");
const store = require("./store");
const { sendSubmissionEmail } = require("./mailer");

const router = express.Router();

// Public: login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Username and password required." });

    const user = await store.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const secret = req.app?.locals?.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Server misconfigured: missing JWT secret." });

    const token = signToken(user, secret);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, district_name: user.district_name || null }
    });
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

router.get("/admin/users", requireRole("admin"), async (req, res) => {
  const role = req.query.role;
  const rows = await store.listUsers(role ? { role } : {});
  res.json(rows);
});

router.post("/admin/users", requireRole("admin"), async (req, res) => {
  try{
    const { username, password, role, district_name } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required." });

    const r = role || "district";
    if (!["district","admin"].includes(r)) return res.status(400).json({ error: "Invalid role." });

    const existing = await store.getUserByUsername(username);
    if (existing) return res.status(400).json({ error: "Username already exists." });

    const hash = await bcrypt.hash(password, 10);
    const id = await store.createUser({ username, password_hash: hash, role: r, district_name: district_name || null });
    res.json({ id });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: "Failed to create user." });
  }
});

router.get("/admin/templates", requireRole("admin"), async (req, res) => {
  const rows = await store.listTemplates();
  res.json(rows);
});

router.post("/admin/templates", requireRole("admin"), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required." });
  const id = await store.createTemplate({ name, created_by: req.user.id });
  res.json({ id });
});

router.get("/admin/templates/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid template id." });
  const tpl = await store.getTemplateDetail(id);
  if (!tpl) return res.status(404).json({ error: "Template not found." });
  res.json(tpl);
});

router.put("/admin/templates/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid template id." });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required." });
  await store.updateTemplate(id, { name });
  res.json({ ok: true });
});

router.delete("/admin/templates/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid template id." });
  await store.deleteTemplateCascade(id);
  res.json({ ok: true });
});

router.post("/admin/templates/:id/fields", requireRole("admin"), async (req, res) => {
  const template_id = Number(req.params.id);
  if (!Number.isFinite(template_id)) return res.status(400).json({ error: "Invalid template id." });
  const tpl = await store.getTemplateById(template_id);
  if (!tpl) return res.status(404).json({ error: "Template not found." });

  const { label, type, required } = req.body || {};
  if (!label) return res.status(400).json({ error: "label required." });

  await store.addField({ template_id, label, type, required: !!required });
  res.json({ ok: true });
});

router.put("/admin/fields/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const f = await store.getFieldById(id);
  if (!f) return res.status(404).json({ error: "Field not found." });

  const { label, type, required, options } = req.body || {};
  await store.updateField(id, { label, type, required, options });
  res.json({ ok: true });
});

router.delete("/admin/fields/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const f = await store.getFieldById(id);
  if (!f) return res.status(404).json({ error: "Field not found." });

  await store.deleteField(id);
  res.json({ ok: true });
});

router.post("/admin/templates/:id/publish", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid template id." });
  await store.publishTemplate(id);
  res.json({ ok: true });
});

router.post("/admin/templates/:id/assign", requireRole("admin"), async (req, res) => {
  try{
    const template_id = Number(req.params.id);
    if (!Number.isFinite(template_id)) return res.status(400).json({ error: "Invalid template id." });
    const { districtUserIds } = req.body || {};
    if (!Array.isArray(districtUserIds) || !districtUserIds.length) {
      return res.status(400).json({ error: "districtUserIds required." });
    }

    await store.assignTemplateToDistricts(template_id, districtUserIds);
    res.json({ ok: true });
  }catch(e){
    const status = e.status || 500;
    res.status(status).json({ error: e.message || "Assign failed." });
  }
});

router.get("/admin/submissions", requireRole("admin"), async (req, res) => {
  const rows = await store.listSubmissions();
  res.json(rows);
});

router.get("/admin/submissions/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const sub = await store.getSubmissionDetail(id);
  if (!sub) return res.status(404).json({ error: "Submission not found." });
  res.json(sub);
});

router.post("/admin/submissions/:id/unlock", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  await store.unlockSubmission(id);
  res.json({ ok: true });
});

/* ===================== DISTRICT ===================== */

router.get("/district/assignments", requireRole("district"), async (req, res) => {
  const rows = await store.listDistrictAssignments(req.user.id);
  res.json(rows);
});

router.get("/district/assignments/:id", requireRole("district"), async (req, res) => {
  const id = Number(req.params.id);
  const a = await store.getDistrictAssignmentDetail(id, req.user.id);
  if (!a) return res.status(404).json({ error: "Assignment not found." });
  res.json(a);
});

router.put("/district/assignments/:id", requireRole("district"), async (req, res) => {
  const id = Number(req.params.id);
  const { values } = req.body || {};
  if (!Array.isArray(values)) return res.status(400).json({ error: "values[] required." });

  const out = await store.saveDistrictValues(id, req.user.id, values);
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ok: true });
});

router.post("/district/assignments/:id/send", requireRole("district"), async (req, res) => {
  const id = Number(req.params.id);

  const result = await store.sendDistrictSubmission(id, req.user.id);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

  // Email admin (optional)
  const adminEmail = process.env.ADMIN_EMAIL;
  let emailResult = null;

  if (adminEmail) {
    const html = store.buildSubmissionEmailHtml({
      districtName: result.district_name,
      templateName: result.template_name,
      sentAt: result.sent_at,
      rows: result.rows
    });

    try {
      emailResult = await sendSubmissionEmail(process.env, {
        to: adminEmail,
        subject: `Submission: ${result.district_name} — ${result.template_name}`,
        html
      });
    } catch (e) {
      console.warn("Email send failed:", e.message);
    }
  }

  res.json({
    ok: true,
    message: emailResult?.ok ? "Sent ✅ (email delivered)" :
             adminEmail ? "Sent ✅ (email failed; check logs)" :
             "Sent ✅"
  });
});

module.exports = router;
