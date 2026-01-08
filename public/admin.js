(async function () {
  const me = await ensureAuth("admin");
  if (!me) return;

  const byId = (id) => {
    const n = document.getElementById(id);
    if (!n) throw new Error(`Missing element #${id} in admin.html`);
    return n;
  };

  byId("meBadge").textContent = `Admin: ${me.username}`;
  byId("logoutBtn").addEventListener("click", () => {
    API.clearToken();
    window.location.href = "/";
  });

  // Tabs
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    templates: byId("tab-templates"),
    districts: byId("tab-districts"),
    submissions: byId("tab-submissions"),
  };

  function setTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(panels).forEach(([k, v]) => v.classList.toggle("hidden", k !== name));
  }
  tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // ---- id helpers (SQLite numeric + Mongo _id) ----
  const normalizeId = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (typeof v === "object") {
      if (v.$oid) return String(v.$oid);
      if (v._id) return normalizeId(v._id);
    }
    return String(v);
  };
  const tplId = (t) => normalizeId(t?.id ?? t?._id);
  const fieldId = (f) => normalizeId(f?.id ?? f?._id);
  const userId = (u) => normalizeId(u?.id ?? u?._id);
  const subId = (s) => normalizeId(s?.id ?? s?._id);

  // State
  let templates = [];
  let selectedTemplateId = null;
  let districts = [];
  let submissions = [];
  let selectedSubmissionId = null;

  // Elements
  const templateListEl = byId("templateList");
  const tplEmptyEl = byId("templateEditorEmpty");
  const tplEditorEl = byId("templateEditor");
  const tplNameEl = byId("tplName");
  const fieldListEl = byId("fieldList");

  function pill(text) { return el("span", { class: "pill" }, text); }

  async function loadTemplates() {
    try {
      const resp = await API.request("/api/admin/templates");
      templates = Array.isArray(resp) ? resp : [];
      renderTemplateList();

      if (selectedTemplateId) {
        const still = templates.find((t) => tplId(t) === selectedTemplateId);
        if (!still) selectTemplate(null);
        else await selectTemplate(selectedTemplateId, true);
      }
    } catch (e) {
      console.error("loadTemplates failed:", e);
      toast(e.message, "err");
    }
  }

  function renderTemplateList() {
    templateListEl.innerHTML = "";
    if (!templates.length) {
      templateListEl.appendChild(el("div", { class: "muted small" }, "No templates yet."));
      return;
    }
    templates.forEach((t) => {
      const id = tplId(t);
      const node = el("div", {
        class: "item" + (id === selectedTemplateId ? " active" : ""),
        onclick: () => selectTemplate(id)
      },
        el("div", { class: "item-title" }, t.name || "Untitled"),
        el("div", { class: "item-sub" },
          pill(t.published ? "Published" : "Draft"),
          pill(`${t.field_count ?? (t.fields?.length ?? 0)} fields`),
          pill(`Updated: ${fmtDate(t.updated_at)}`)
        )
      );
      templateListEl.appendChild(node);
    });
  }

  async function selectTemplate(id, skipRenderList = false) {
    selectedTemplateId = id ? String(id) : null;
    if (!skipRenderList) renderTemplateList();

    if (!selectedTemplateId) {
      tplEmptyEl.classList.remove("hidden");
      tplEditorEl.classList.add("hidden");
      return;
    }

    // show loading state quickly
    tplEmptyEl.classList.add("hidden");
    tplEditorEl.classList.remove("hidden");
    tplNameEl.value = "Loading...";
    fieldListEl.innerHTML = el("div", { class: "muted small" }, "Loading fields...").outerHTML;

    try {
      const tpl = await API.request(`/api/admin/templates/${encodeURIComponent(selectedTemplateId)}`);
      if (!tpl) throw new Error("Template details response is empty (possible 304/cache).");

      tplNameEl.value = tpl.name || "";
      renderFields(Array.isArray(tpl.fields) ? tpl.fields : []);
    } catch (e) {
      console.error("selectTemplate failed:", e);
      toast(e.message, "err");

      tplNameEl.value = "";
      fieldListEl.innerHTML = "";
      tplEmptyEl.classList.remove("hidden");
      tplEditorEl.classList.add("hidden");
    }
  }

  function renderFields(fields) {
    fieldListEl.innerHTML = "";
    if (!fields.length) {
      fieldListEl.appendChild(el("div", { class: "muted small" }, "No fields. Click + Add Field."));
      return;
    }

    fields.forEach((f) => {
      const fid = fieldId(f);
      const row = el("div", { class: "field-row" },
        el("input", { class: "input", value: f.label || "", "data-id": fid, "data-kind": "label" }),
        el("select", { class: "select", "data-id": fid, "data-kind": "type" },
          ...["text", "textarea", "number", "date", "select"].map((opt) => {
            const o = el("option", { value: opt }, opt);
            if (opt === f.type) o.selected = true;
            return o;
          })
        ),
        el("select", { class: "select", "data-id": fid, "data-kind": "required" },
          (() => { const o = el("option", { value: "0" }, "optional"); if (!f.required) o.selected = true; return o; })(),
          (() => { const o = el("option", { value: "1" }, "required"); if (f.required) o.selected = true; return o; })(),
        ),
        el("div", { class: "row gap8 wrap" },
          el("button", { class: "btn", onclick: () => editOptions(f) }, "Options"),
          el("button", { class: "btn danger", onclick: () => deleteField(fid) }, "Delete"),
        )
      );
      fieldListEl.appendChild(row);
    });
  }

  async function saveFieldEdits() {
    if (!selectedTemplateId) return;

    const labelInputs = Array.from(fieldListEl.querySelectorAll('[data-kind="label"]'));
    const typeInputs = Array.from(fieldListEl.querySelectorAll('[data-kind="type"]'));
    const reqInputs = Array.from(fieldListEl.querySelectorAll('[data-kind="required"]'));

    for (const inp of labelInputs) {
      const id = String(inp.getAttribute("data-id"));
      const label = inp.value.trim();
      const type = typeInputs.find(x => String(x.getAttribute("data-id")) === id)?.value || "text";
      const required = (reqInputs.find(x => String(x.getAttribute("data-id")) === id)?.value || "0") === "1";
      await API.request(`/api/admin/fields/${encodeURIComponent(id)}`, { method: "PUT", body: { label, type, required } });
    }

    await loadTemplates();
    await selectTemplate(selectedTemplateId, true);
  }

  async function deleteField(fieldIdStr) {
    const ok = confirm("Delete this field?");
    if (!ok) return;
    await API.request(`/api/admin/fields/${encodeURIComponent(fieldIdStr)}`, { method: "DELETE" });
    await selectTemplate(selectedTemplateId, true);
    await loadTemplates();
  }

  function editOptions(field) {
    if (field.type !== "select") {
      Modal.open("Options", el("div", {}, el("div", { class: "muted" }, "Options are only for type = select.")), [
        el("button", { class: "btn", onclick: () => document.getElementById("modalClose").click() }, "Close")
      ]);
      return;
    }

    const ta = el("textarea", { class: "input", style: "min-height:140px", placeholder: "One option per line" }, (field.options || []).join("\n"));
    const body = el("div", { class: "form" },
      el("div", { class: "small muted" }, "Enter select options (one per line)."),
      ta
    );

    const saveBtn = el("button", {
      class: "btn primary",
      onclick: async () => {
        const options = ta.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        await API.request(`/api/admin/fields/${encodeURIComponent(fieldId(field))}`, { method: "PUT", body: { options } });
        document.getElementById("modalClose").click();
        await selectTemplate(selectedTemplateId, true);
        await loadTemplates();
        toast("Options saved ✅", "ok");
      }
    }, "Save");

    Modal.open("Edit Options", body, [
      el("button", { class: "btn", onclick: () => document.getElementById("modalClose").click() }, "Cancel"),
      saveBtn
    ]);
  }

  // Buttons
  byId("newTemplateBtn").addEventListener("click", async () => {
    const name = prompt("Template name (Marathi/English):", "नवीन टेबल / New Table");
    if (!name) return;

    try {
      const tpl = await API.request("/api/admin/templates", { method: "POST", body: { name } });
      await loadTemplates();
      const id = tplId(tpl) || tplId(templates.find(x => x.name === name));
      if (id) await selectTemplate(id);
      toast("Template created ✅", "ok");
    } catch (e) {
      console.error(e);
      toast(e.message, "err");
    }
  });

  byId("saveTplBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    await API.request(`/api/admin/templates/${encodeURIComponent(selectedTemplateId)}`, { method: "PUT", body: { name: tplNameEl.value.trim() } });
    await loadTemplates();
    toast("Saved ✅", "ok");
  });

  byId("deleteTplBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    const ok = confirm("Delete this template and all its fields?");
    if (!ok) return;
    await API.request(`/api/admin/templates/${encodeURIComponent(selectedTemplateId)}`, { method: "DELETE" });
    selectedTemplateId = null;
    await loadTemplates();
    await selectTemplate(null);
    toast("Deleted ✅", "ok");
  });

  byId("addFieldBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    const label = prompt("Field label (Marathi/English):", "माहिती / Information");
    if (!label) return;
    await API.request(`/api/admin/templates/${encodeURIComponent(selectedTemplateId)}/fields`, { method: "POST", body: { label, type: "text", required: false } });
    await selectTemplate(selectedTemplateId, true);
    await loadTemplates();
    toast("Field added ✅", "ok");
  });

  byId("publishBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    await saveFieldEdits();
    await API.request(`/api/admin/templates/${encodeURIComponent(selectedTemplateId)}/publish`, { method: "POST" });
    await loadTemplates();
    toast("Published ✅", "ok");
  });

  // Districts + submissions loaders (unchanged logic, but safer ids)
  byId("createDistrictBtn").addEventListener("click", async () => {
    const msg = byId("districtMsg");
    showMsg(msg, "");
    try {
      const username = byId("dUsername").value.trim();
      const district_name = byId("dName").value.trim();
      const password = byId("dPassword").value;
      if (!username || !district_name || !password) throw new Error("Fill all fields.");
      await API.request("/api/admin/users", { method: "POST", body: { username, district_name, password, role: "district" } });
      showMsg(msg, "Created!", true);
      byId("dUsername").value = "";
      byId("dName").value = "";
      byId("dPassword").value = "";
      await loadDistricts();
      toast("District user created ✅", "ok");
    } catch (e) {
      showMsg(msg, e.message, false);
      toast(e.message, "err");
    }
  });

  async function loadDistricts() {
    const list = byId("districtList");
    districts = await API.request("/api/admin/users?role=district");
    districts = Array.isArray(districts) ? districts : [];
    list.innerHTML = "";
    if (!districts.length) {
      list.appendChild(el("div", { class: "muted small" }, "No district users yet."));
      return;
    }
    districts.forEach(d => {
      list.appendChild(
        el("div", { class: "item" },
          el("div", { class: "item-title" }, d.district_name || d.username),
          el("div", { class: "item-sub" }, pill(`@${d.username}`), pill(`id:${userId(d)}`))
        )
      );
    });
  }

  const submissionListEl = byId("submissionList");
  const submissionPreviewEl = byId("submissionPreview");

  async function loadSubmissions() {
    submissions = await API.request("/api/admin/submissions");
    submissions = Array.isArray(submissions) ? submissions : [];
    renderSubmissions();
  }

  function renderSubmissions() {
    submissionListEl.innerHTML = "";
    if (!submissions.length) {
      submissionListEl.appendChild(el("div", { class: "muted small" }, "No assigned templates yet."));
      return;
    }
    submissions.forEach(s => {
      const sid = subId(s);
      submissionListEl.appendChild(
        el("div", { class: "item" + (sid === selectedSubmissionId ? " active" : ""), onclick: () => selectSubmission(sid) },
          el("div", { class: "item-title" }, `${s.template_name} — ${s.district_name}`),
          el("div", { class: "item-sub" },
            pill(String(s.status || "").toUpperCase()),
            pill(`Sent: ${s.sent_at ? fmtDate(s.sent_at) : "-"}`),
            pill(`Updated: ${fmtDate(s.updated_at)}`)
          )
        )
      );
    });
  }

  async function selectSubmission(id, skipList = false) {
    selectedSubmissionId = id ? String(id) : null;
    if (!skipList) renderSubmissions();

    const sub = await API.request(`/api/admin/submissions/${encodeURIComponent(selectedSubmissionId)}`);
    submissionPreviewEl.innerHTML = "";

    const rows = (sub.values || []).map(v => [v.label, v.value ?? ""]);
    const table = el("table", { class: "table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Field"), el("th", {}, "Value"))),
      el("tbody", {}, ...rows.map(r => el("tr", {}, el("td", {}, r[0]), el("td", {}, r[1]))))
    );

    submissionPreviewEl.appendChild(
      el("div", {},
        el("div", { class: "small muted", style: "margin-bottom:10px;" },
          `Template: ${sub.template_name} | District: ${sub.district_name} | Status: ${String(sub.status || "").toUpperCase()}`
        ),
        table,
        el("div", { class: "row gap8", style: "margin-top:12px;justify-content:flex-end;" },
          el("button", { class: "btn", onclick: () => exportSubmissionCsv(sub) }, "Export CSV")
        )
      )
    );
  }

  function exportSubmissionCsv(sub) {
    const csv = toCsv([["Field", "Value"], ...(sub.values || []).map(v => [v.label, v.value ?? ""])]);
    download(`submission_${sub.district_name}_${sub.template_name}.csv`.replaceAll(" ", "_"), csv, "text/csv;charset=utf-8");
    toast("CSV exported ✅", "ok");
  }

  byId("refreshSubsBtn").addEventListener("click", async () => {
    await loadSubmissions();
    toast("Refreshed ✅", "ok");
  });

  byId("unlockBtn").addEventListener("click", async () => {
    if (!selectedSubmissionId) return alert("Select a submission.");
    await API.request(`/api/admin/submissions/${encodeURIComponent(selectedSubmissionId)}/unlock`, { method: "POST" });
    await loadSubmissions();
    toast("Unlocked ✅", "ok");
  });

  // Auto-save edits
  document.addEventListener("change", async (e) => {
    if (!selectedTemplateId) return;
    if (e.target?.getAttribute?.("data-id")) {
      try { await saveFieldEdits(); } catch (err) { console.warn(err); }
    }
  });

  // Boot
  await loadTemplates();
  await loadDistricts();
  await loadSubmissions();
})();
