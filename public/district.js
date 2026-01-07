(async function(){
  const me = await ensureAuth("district");
  if (!me) return;

  document.getElementById("meBadge").textContent = `${me.district_name || me.username}`;
  document.getElementById("districtSubtitle").textContent = `District: ${me.district_name || me.username}`;
  document.getElementById("logoutBtn").addEventListener("click", () => {
    API.clearToken();
    window.location.href = "/";
  });

  let assignments = [];
  let selectedAssignmentId = null;
  let selectedAssignment = null; // full details

  const listEl = document.getElementById("assignmentList");
  const emptyEl = document.getElementById("assignmentEmpty");
  const editorEl = document.getElementById("assignmentEditor");
  const titleEl = document.getElementById("assignmentTitle");
  const statusEl = document.getElementById("assignmentStatus");
  const fieldsEl = document.getElementById("formFields");
  const msgEl = document.getElementById("districtMsg");

  function pill(text){ return el("span", { class:"pill" }, text); }

  async function loadAssignments(){
    assignments = await API.request("/api/district/assignments");
    renderList();
    if (selectedAssignmentId){
      const still = assignments.find(a => a.id === selectedAssignmentId);
      if (!still){
        selectAssignment(null);
      }else{
        await selectAssignment(selectedAssignmentId, true);
      }
    }
  }

  function renderList(){
    listEl.innerHTML = "";
    if (!assignments.length){
      listEl.appendChild(el("div", { class:"muted small" }, "No assigned tables yet. Ask admin to assign."));
      return;
    }
    assignments.forEach(a => {
      listEl.appendChild(
        el("div", { class:"item" + (a.id===selectedAssignmentId ? " active":"") , onclick: () => selectAssignment(a.id) },
          el("div", { class:"item-title" }, a.template_name),
          el("div", { class:"item-sub" },
            pill(a.status.toUpperCase()),
            pill(`Updated: ${fmtDate(a.updated_at)}`),
            pill(`Sent: ${a.sent_at ? fmtDate(a.sent_at) : "-"}`)
          )
        )
      );
    });
  }

  async function selectAssignment(id, skipList=false){
    selectedAssignmentId = id;
    if (!skipList) renderList();

    if (!id){
      emptyEl.classList.remove("hidden");
      editorEl.classList.add("hidden");
      selectedAssignment = null;
      return;
    }

    selectedAssignment = await API.request(`/api/district/assignments/${id}`);
    emptyEl.classList.add("hidden");
    editorEl.classList.remove("hidden");

    titleEl.textContent = selectedAssignment.template_name;
    statusEl.textContent = `Status: ${selectedAssignment.status.toUpperCase()} • Last updated: ${fmtDate(selectedAssignment.updated_at)}`;

    renderForm(selectedAssignment.fields, selectedAssignment.values, selectedAssignment.status === "sent");
    showMsg(msgEl, "");
  }

  function renderForm(fields, values, locked){
    fieldsEl.innerHTML = "";
    const map = new Map((values||[]).map(v => [v.field_key, v.value ?? ""]));

    fields.forEach(f => {
      const label = el("label", { class:"label" }, f.label + (f.required ? " *" : ""));
      let input;

      const commonAttrs = { "data-key": f.field_key, disabled: locked ? "disabled" : null };
      if (f.type === "textarea"){
        input = el("textarea", { ...commonAttrs, class:"input", placeholder:"Type here..." }, map.get(f.field_key) || "");
      }else if (f.type === "number"){
        input = el("input", { ...commonAttrs, class:"input", type:"number", value: map.get(f.field_key) || "" });
      }else if (f.type === "date"){
        input = el("input", { ...commonAttrs, class:"input", type:"date", value: map.get(f.field_key) || "" });
      }else if (f.type === "select"){
        const sel = el("select", { ...commonAttrs, class:"select" },
          el("option", { value:"" }, "-- Select --"),
          ...(f.options||[]).map(opt => {
            const o = el("option", { value: opt }, opt);
            if (opt === (map.get(f.field_key) || "")) o.selected = true;
            return o;
          })
        );
        input = sel;
      }else{
        input = el("input", { ...commonAttrs, class:"input", type:"text", value: map.get(f.field_key) || "", placeholder:"मराठी/English मध्ये टाईप करा..." });
      }

      fieldsEl.appendChild(label);
      fieldsEl.appendChild(input);
    });

    // Buttons state
    document.getElementById("saveDraftBtn").disabled = locked;
    document.getElementById("sendBtn").disabled = locked;
  }

  function collectValues(){
    const inputs = Array.from(fieldsEl.querySelectorAll("[data-key]"));
    return inputs.map(i => ({
      field_key: i.getAttribute("data-key"),
      value: (i.tagName === "TEXTAREA") ? i.value : i.value
    }));
  }

  async function saveDraft(){
    if (!selectedAssignmentId) return;
    showMsg(msgEl, "");
    try{
      const values = collectValues();
      await API.request(`/api/district/assignments/${selectedAssignmentId}`, { method:"PUT", body:{ values } });
      showMsg(msgEl, "Draft saved.", true);
      await loadAssignments();
      await selectAssignment(selectedAssignmentId, true);
    }catch(e){
      showMsg(msgEl, e.message, false);
    }
  }

  async function sendToAdmin(){
    if (!selectedAssignmentId) return;
    showMsg(msgEl, "");
    const ok = confirm("Once sent, you cannot edit unless admin unlocks. Send now?");
    if (!ok) return;

    try{
      await saveDraft(); // ensure latest
      const resp = await API.request(`/api/district/assignments/${selectedAssignmentId}/send`, { method:"POST" });
      showMsg(msgEl, resp.message || "Sent!", true);
      await loadAssignments();
      await selectAssignment(selectedAssignmentId, true);
    }catch(e){
      showMsg(msgEl, e.message, false);
    }
  }

  document.getElementById("saveDraftBtn").addEventListener("click", saveDraft);
  document.getElementById("sendBtn").addEventListener("click", sendToAdmin);

  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    if (!selectedAssignment) return;
    const rows = [["Field","Value"], ...selectedAssignment.fields.map(f => {
      const v = (selectedAssignment.values||[]).find(x => x.field_key === f.field_key)?.value ?? "";
      return [f.label, v];
    })];
    const csv = toCsv(rows);
    download(`district_${me.username}_${selectedAssignment.template_name}.csv`.replaceAll(" ","_"), csv, "text/csv;charset=utf-8");
  });

  await loadAssignments();
})();