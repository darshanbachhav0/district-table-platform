const API = {
  token: () => localStorage.getItem("dt_token") || "",
  setToken: (t) => localStorage.setItem("dt_token", t),
  clearToken: () => localStorage.removeItem("dt_token"),

  async request(path, { method = "GET", body, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": API.token() ? `Bearer ${API.token()}` : "",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `Request failed: ${res.status}`;
      throw new Error(msg);
    }
    return data;
  },

  async me() {
    return API.request("/api/me");
  },

  async login(username, password) {
    return API.request("/api/login", { method: "POST", body: { username, password } });
  },
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  });
  children.flat().filter(Boolean).forEach((c) => {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  });
  return node;
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString();
}

function showMsg(elm, text, ok=true){
  elm.textContent = text || "";
  elm.className = "msg " + (ok ? "ok" : "err");
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

function toCsv(rows){
  const esc = (v) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes("\n") || s.includes("\"")) return '"' + s.replaceAll('"','""') + '"';
    return s;
  };
  return rows.map(r => r.map(esc).join(",")).join("\n");
}

function download(filename, content, mime="text/plain;charset=utf-8"){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Simple modal */
const Modal = {
  open(title, bodyNode, footButtons=[]){
    const b = document.getElementById("modalBackdrop");
    const m = document.getElementById("modal");
    const t = document.getElementById("modalTitle");
    const body = document.getElementById("modalBody");
    const foot = document.getElementById("modalFoot");
    const close = document.getElementById("modalClose");

    t.textContent = title;
    body.innerHTML = "";
    if (typeof bodyNode === "string") body.innerHTML = bodyNode;
    else body.appendChild(bodyNode);

    foot.innerHTML = "";
    footButtons.forEach(btn => foot.appendChild(btn));

    const hide = () => {
      b.classList.add("hidden");
      m.classList.add("hidden");
      close.removeEventListener("click", hide);
      b.removeEventListener("click", hide);
    };

    close.addEventListener("click", hide);
    b.addEventListener("click", hide);

    b.classList.remove("hidden");
    m.classList.remove("hidden");
    return { hide };
  }
};

async function ensureAuth(role){
  try{
    const me = await API.me();
    if (role && me.role !== role) {
      window.location.href = "/";
      return null;
    }
    return me;
  } catch(e){
    API.clearToken();
    window.location.href = "/";
    return null;
  }
}
