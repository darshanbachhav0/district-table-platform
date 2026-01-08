(async function () {
  const me = await ensureAuth("admin");
  if (!me) return;

  // ---- helpers to support both SQL (id) and Mongo (_id) ----
  function normId(x) {
    if (x === undefined || x === null) return null;
    if (typeof x === "object" && x.$oid) return String(x.$oid);
    return String(x);
  }
  function idOf(obj) {
    if (!obj) return null;
    return normId(obj.id ?? obj._id);
  }
  function enc(x) {
    return encodeURIComponent(String(x));
  }
  function safeToast(text) {
    const n = el(
      "div",
      {
        class: "item",
        style:
          "position:fixed;right:18px;bottom:18px;z-index:999;background:rgba(2,8,20,0.70);max-width:320px;",
      },
      text
    );
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 1800);
  }

  document.getElementById("meBadge").textContent = `Admin: ${me.username}`;
  document.getElementById("logoutBtn").addEventListener("click", () => {
    API.clearToken();
    window.location.href = "/";
  });

  // Tabs
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    templates: document.getElementById("tab-templates"),
    districts: document.getElementById("tab-districts"),
    submissions: document.getElementById("tab-submissions"),
  };
  function setTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(panels).forEach(([k, v]) =>
      v.classList.toggle("hidden", k !== name)
    );
  }
  tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // State
  let templates = [];
  let selectedTemplateId = null;
  let districts = [];
  let submissions = [];
  let selectedSubmissionId = null;

  // Elements
  const templateListEl = document.getElementById("templateList");
  const tplEmptyEl = document.getElementById("templateEditorEmpty");
  const tplEditorEl = document.getElementById("templateEditor");
  const tplNameEl = document.getElementById("tplName");
  const fieldListEl = document.getElementById("fieldList");

  function pill(text) {
    return el("span", { class: "pill" }, text);
  }

  async function loadTemplates() {
    templates = await API.request("/api/admin/templates");
    renderTemplateList();

    // keep selection if still exists
    if (selectedTemplateId) {
      const still = templates.find((t) => idOf(t) === selectedTemplateId);
      if (!still) {
        await selectTemplate(null);
      } else {
        await selectTemplate(selectedTemplateId, true);
      }
    }
  }

  function renderTemplateList() {
    templateListEl.innerHTML = "";
    if (!templates.length) {
      templateListEl.appendChild(
        el("div", { class: "muted small" }, "No templates yet. Click + New Template.")
      );
      return;
    }

    templates.forEach((t) => {
      const tid = idOf(t);
      const node = el(
        "div",
        {
          class: "item" + (tid === selectedTemplateId ? " active" : ""),
          onclick: () => selectTemplate(tid),
        },
        el("div", { class: "item-title" }, t.name),
        el(
          "div",
          { class: "item-sub" },
          pill(t.published ? "Published" : "Draft"),
          pill(`${t.field_count ?? 0} fields`),
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

    try {
      const tpl = await API.request(`/api/admin/templates/${enc(selectedTemplateId)}`);
      tplEmptyEl.classList.add("hidden");
      tplEditorEl.classList.remove("hidden");
      tplNameEl.value = tpl.name || "";
      renderFields(tpl.fields || []);
    } catch (e) {
      safeToast(e.message);
      tplEmptyEl.classList.remove("hidden");
      tplEditorEl.classList.add("hidden");
      selectedTemplateId = null;
      renderTemplateList();
    }
  }

  function renderFields(fields) {
    fieldListEl.innerHTML = "";
    if (!fields.length) {
      fieldListEl.appendChild(
        el("div", { class: "muted small" }, "No fields. Click + Add Field.")
      );
      return;
    }

    fields.forEach((f) => {
      const fid = idOf(f);
      const row = el(
        "div",
        { class: "field-row" },
        el("input", {
          class: "input",
          value: f.label,
          "data-id": fid,
          "data-kind": "label",
        }),
        el(
          "select",
          { class: "select", "data-id": fid, "data-kind": "type" },
          ...["text", "textarea", "number", "date", "select"].map((opt) => {
            const o = el("option", { value: opt }, opt);
            if (opt === f.type) o.selected = true;
            return o;
          })
        ),
        el(
          "select",
          { class: "select", "data-id": fid, "data-kind": "required" },
          (() => {
            const o = el("option", { value: "0" }, "optional");
            if (!f.required) o.selected = true;
            return o;
          })(),
          (() => {
            const o = el("option", { value: "1" }, "required");
            if (f.required) o.selected = true;
            return o;
          })()
        ),
        el(
          "div",
          { class: "row gap8" },
          el(
            "button",
            { class: "btn", onclick: () => editOptions(f) },
            "Options"
          ),
          el(
            "button",
            { class: "btn danger", onclick: () => deleteField(fid) },
            "Delete"
          )
        )
      );
      fieldListEl.appendChild(row);
    });
  }

  async function saveFieldEdits() {
    if (!selectedTemplateId) return;

    const labelInputs = Array.from(
      fieldListEl.querySelectorAll('[data-kind="label"]')
    );
    const typeInputs = Array.from(
      fieldListEl.querySelectorAll('[data-kind="type"]')
    );
    const reqInputs = Array.from(
      fieldListEl.querySelectorAll('[data-kind="required"]')
    );

    for (const inp of labelInputs) {
      const fid = String(inp.getAttribute("data-id"));
      const label = inp.value.trim();
      const type =
        typeInputs.find((x) => String(x.getAttribute("data-id")) === fid)?.value ||
        "text";
      const required =
        (reqInputs.find((x) => String(x.getAttribute("data-id")) === fid)?.value ||
          "0") === "1";

      await API.request(`/api/admin/fields/${enc(fid)}`, {
        method: "PUT",
        body: { label, type, required },
      });
    }

    await loadTemplates();
    await selectTemplate(selectedTemplateId, true);
  }

  async function deleteField(fieldId) {
    const ok = confirm("Delete this field?");
    if (!ok) return;
    await API.request(`/api/admin/fields/${enc(fieldId)}`, { method: "DELETE" });
    await selectTemplate(selectedTemplateId, true);
    await loadTemplates();
    safeToast("Field deleted");
  }

  function editOptions(field) {
    if (field.type !== "select") {
      Modal.open(
        "Options",
        el("div", {}, el("div", { class: "muted" }, "Options are only for type = select.")),
        [el("button", { class: "btn", onclick: () => document.getElementById("modalClose").click() }, "Close")]
      );
      return;
    }

    const fid = idOf(field);
    const ta = el(
      "textarea",
      { class: "input", style: "min-height:140px", placeholder: "One option per line" },
      (field.options || []).join("\n")
    );

    const body = el(
      "div",
      { class: "form" },
      el("div", { class: "small muted" }, "Enter select options (one per line)."),
      ta
    );

    const saveBtn = el(
      "button",
      {
        class: "btn primary",
        onclick: async () => {
          const options = ta.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);

          await API.request(`/api/admin/fields/${enc(fid)}`, {
            method: "PUT",
            body: { options },
          });

          document.getElementById("modalClose").click();
          await selectTemplate(selectedTemplateId, true);
          await loadTemplates();
          safeToast("Options saved");
        },
      },
      "Save"
    );

    Modal.open("Edit Options", body, [
      el("button", { class: "btn", onclick: () => document.getElementById("modalClose").click() }, "Cancel"),
      saveBtn,
    ]);
  }

  // New Template
  document.getElementById("newTemplateBtn").addEventListener("click", async () => {
    const name = prompt("Template name (Marathi/English):", "नवीन टेबल / New Table");
    if (!name) return;

    const created = await API.request("/api/admin/templates", {
      method: "POST",
      body: { name },
    });

    const newId = normId(created?.id ?? created?._id);
    await loadTemplates();
    if (newId) await selectTemplate(newId);
    safeToast("Template created");
  });

  // Save template name
  document.getElementById("saveTplBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    await API.request(`/api/admin/templates/${enc(selectedTemplateId)}`, {
      method: "PUT",
      body: { name: tplNameEl.value.trim() },
    });
    await loadTemplates();
    safeToast("Saved");
  });

  // Delete template
  document.getElementById("deleteTplBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    const ok = confirm("Delete this template and all its fields?");
    if (!ok) return;

    await API.request(`/api/admin/templates/${enc(selectedTemplateId)}`, {
      method: "DELETE",
    });

    selectedTemplateId = null;
    await loadTemplates();
    await selectTemplate(null);
    safeToast("Deleted");
  });

  // Add field
  document.getElementById("addFieldBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;

    const label = prompt("Field label (Marathi/English):", "माहिती / Information");
    if (!label) return;

    await API.request(`/api/admin/templates/${enc(selectedTemplateId)}/fields`, {
      method: "POST",
      body: { label, type: "text", required: false },
    });

    await selectTemplate(selectedTemplateId, true);
    await loadTemplates();
    safeToast("Field added");
  });

  // Publish template
  document.getElementById("publishBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;
    await saveFieldEdits();
    await API.request(`/api/admin/templates/${enc(selectedTemplateId)}/publish`, {
      method: "POST",
    });
    await loadTemplates();
    safeToast("Published");
  });

  // Assign template to districts
  document.getElementById("assignBtn").addEventListener("click", async () => {
    if (!selectedTemplateId) return;

    districts = await API.request("/api/admin/users?role=district");
    const checks = districts.map((d) => {
      const did = idOf(d);
      const cb = el("input", { type: "checkbox", value: did });
      const row = el(
        "label",
        { class: "item", style: "display:flex;align-items:center;gap:10px;cursor:pointer;" },
        cb,
        el(
          "div",
          {},
          el("div", { class: "item-title" }, d.district_name || d.username),
          el("div", { class: "item-sub" }, `@${d.username}`)
        )
      );
      return { d, cb, row };
    });

    const body = el(
      "div",
      {},
      el("div", { class: "small muted" }, "Select districts to assign this template:"),
      el(
        "div",
        {
          style:
            "margin-top:10px;display:flex;flex-direction:column;gap:10px;max-height:320px;overflow:auto;padding-right:6px;",
        },
        ...checks.map((x) => x.row)
      )
    );

    const assignBtn = el(
      "button",
      {
        class: "btn primary",
        onclick: async () => {
          const ids = checks.filter((x) => x.cb.checked).map((x) => String(x.cb.value));
          if (!ids.length) return alert("Select at least one district.");

          await API.request(`/api/admin/templates/${enc(selectedTemplateId)}/assign`, {
            method: "POST",
            body: { districtUserIds: ids },
          });

          document.getElementById("modalClose").click();
          safeToast("Assigned");
        },
      },
      "Assign"
    );

    Modal.open("Assign Template", body, [
      el("button", { class: "btn", onclick: () => document.getElementById("modalClose").click() }, "Cancel"),
      assignBtn,
    ]);
  });

  // Create district user
  document.getElementById("createDistrictBtn").addEventListener("click", async () => {
    const msg = document.getElementById("districtMsg");
    showMsg(msg, "");

    try {
      const username = document.getElementById("dUsername").value.trim();
      const district_name = document.getElementById("dName").value.trim();
      const password = document.getElementById("dPassword").value;

      if (!username || !district_name || !password) throw new Error("Fill all fields.");

      await API.request("/api/admin/users", {
        method: "POST",
        body: { username, district_name, password, role: "district" },
      });

      showMsg(msg, "Created!", true);
      document.getElementById("dUsername").value = "";
      document.getElementById("dName").value = "";
      document.getElementById("dPassword").value = "";

      await loadDistricts();
      safeToast("District user created");
    } catch (e) {
      showMsg(msg, e.message, false);
      safeToast(e.message);
    }
  });

  async function loadDistricts() {
    const list = document.getElementById("districtList");
    districts = await API.request("/api/admin/users?role=district");

    list.innerHTML = "";
    if (!districts.length) {
      list.appendChild(el("div", { class: "muted small" }, "No district users yet."));
      return;
    }

    districts.forEach((d) => {
      list.appendChild(
        el(
          "div",
          { class: "item" },
          el("div", { class: "item-title" }, d.district_name || d.username),
          el("div", { class: "item-sub" }, pill(`@${d.username}`), pill(`id:${idOf(d)}`))
        )
      );
    });
  }

  // Submissions
  const submissionListEl = document.getElementById("submissionList");
  const submissionPreviewEl = document.getElementById("submissionPreview");

  async function loadSubmissions() {
    submissions = await API.request("/api/admin/submissions");
    renderSubmissions();

    if (selectedSubmissionId) {
      const still = submissions.find((s) => idOf(s) === selectedSubmissionId);
      if (!still) {
        selectedSubmissionId = null;
        submissionPreviewEl.innerHTML = "Select a submission to preview.";
      } else {
        await selectSubmission(selectedSubmissionId, true);
      }
    }
  }

  function renderSubmissions() {
    submissionListEl.innerHTML = "";
    if (!submissions.length) {
      submissionListEl.appendChild(el("div", { class: "muted small" }, "No assigned templates yet."));
      return;
    }

    submissions.forEach((s) => {
      const sid = idOf(s);
      submissionListEl.appendChild(
        el(
          "div",
          {
            class: "item" + (sid === selectedSubmissionId ? " active" : ""),
            onclick: () => selectSubmission(sid),
          },
          el("div", { class: "item-title" }, `${s.template_name} — ${s.district_name}`),
          el(
            "div",
            { class: "item-sub" },
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
    if (!selectedSubmissionId) return;

    const sub = await API.request(`/api/admin/submissions/${enc(selectedSubmissionId)}`);
    submissionPreviewEl.innerHTML = "";

    const rows = (sub.values || []).map((v) => [v.label, v.value ?? ""]);
    const table = el(
      "table",
      { class: "table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Field"), el("th", {}, "Value"))),
      el("tbody", {}, ...rows.map((r) => el("tr", {}, el("td", {}, r[0]), el("td", {}, r[1]))))
    );

    submissionPreviewEl.appendChild(
      el(
        "div",
        {},
        el(
          "div",
          { class: "small muted", style: "margin-bottom:10px;" },
          `Template: ${sub.template_name} | District: ${sub.district_name} | Status: ${String(sub.status).toUpperCase()}`
        ),
        table,
        el(
          "div",
          { class: "row gap8", style: "margin-top:12px;justify-content:flex-end;" },
          el("button", { class: "btn", onclick: () => exportSubmissionCsv(sub) }, "Export CSV")
        )
      )
    );
  }

  function exportSubmissionCsv(sub) {
    const csv = toCsv([["Field", "Value"], ...(sub.values || []).map((v) => [v.label, v.value ?? ""])]);
    download(
      `submission_${sub.district_name}_${sub.template_name}.csv`.replaceAll(" ", "_"),
      csv,
      "text/csv;charset=utf-8"
    );
    safeToast("CSV exported");
  }

  document.getElementById("refreshSubsBtn").addEventListener("click", async () => {
    await loadSubmissions();
    safeToast("Refreshed");
  });

  document.getElementById("unlockBtn").addEventListener("click", async () => {
    if (!selectedSubmissionId) return alert("Select a submission.");
    await API.request(`/api/admin/submissions/${enc(selectedSubmissionId)}/unlock`, { method: "POST" });
    await loadSubmissions();
    safeToast("Unlocked");
  });

  // Auto-save field edits on change
  document.addEventListener("change", async (e) => {
    if (!selectedTemplateId) return;
    if (e.target?.getAttribute?.("data-id")) {
      try {
        await saveFieldEdits();
      } catch (err) {
        console.warn(err);
      }
    }
  });

  // initial load
  await loadTemplates();
  await loadDistricts();
  await loadSubmissions();
})();
