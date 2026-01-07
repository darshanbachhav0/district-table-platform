(async function(){
  // If already logged in, redirect
  try{
    const me = await API.me();
    if (me?.role === "admin") return window.location.href = "/admin.html";
    if (me?.role === "district") return window.location.href = "/district.html";
  }catch{ /* ignore */ }

  const form = document.getElementById("loginForm");
  const msg = document.getElementById("loginMsg");
  const u = document.getElementById("username");
  const p = document.getElementById("password");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showMsg(msg, "");
    try{
      const data = await API.login(u.value.trim(), p.value);
      API.setToken(data.token);
      if (data.user.role === "admin") window.location.href = "/admin.html";
      else window.location.href = "/district.html";
    }catch(err){
      showMsg(msg, err.message, false);
    }
  });
})();