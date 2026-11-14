/* واجباتي — owner approval: nobody can use the app until the owner sends them an activation code.
   Codes are signed with the owner's private key (kept only on the owner's phone) and bound to the student's
   university ID, so a code can't be shared or forged. */
const OWNER_PUBKEY = "BEaGH_mWMIJbi-HrDsUAV3BBbSUFvQma1jq17DXkmNIY91gJr_nYhNziKEPy7cHKWQCFbQ9tVagmv00Mo8S3FhQ";
// the owner's university ID always gets in; the code-making key is locked with the owner's password
const OWNER_IDS = ["32201003009"];
const OWNER_KEY_LOCKED = {"s":"TJSfOeQqfV6r0A0p1CtjDA","i":"flbiXLJa81u-Zc2P","c":"OAv81jyk9Jj-_Nrn4a2vhpbWnQrd1dw3UCrCvzO4eBBzRWgxHaIblrqVFqhDW4_dXX-4Zw2UZTw-Qet2nBc4jopv0AU-dl5BlauwI_g85HiM4vDFsXIDfyZJVR6EThix7Zia8JkAHohCWcjFTEw-ffsqq_pmmQQgnKegHy3bARQAP2yu55SJiaD7mDtDbkdUWsJKXGLtfVa6g1luyf27H_8MbWIJ-yDk_TPbUKxwKD9UFoqi9ZtxzwAIiMRnREAYUPLmR3Pxsi4"};
const isOwnerId = () => OWNER_IDS.includes(String((Moodle.session && Moodle.session.username) || "").trim());
async function unlockOwnerKey(pass) {
  const d = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass.trim().toLowerCase()), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: d(OWNER_KEY_LOCKED.s), iterations: 600000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pk = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: d(OWNER_KEY_LOCKED.i) }, key, d(OWNER_KEY_LOCKED.c)));
  localStorage.setItem("owner.key", pk); return true;
}
const b64u = { dec: s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0)),
  enc: b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
const msgFor = (user, exp) => new TextEncoder().encode(`wajebati|${String(user).trim().toLowerCase()}|${exp}`);
const todayNum = () => +new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Amman" }).replace(/-/g, "");
async function verifyCode(user, code) {
  try {
    const [exp, sig] = String(code).trim().split(".");
    if (!sig || !/^\d+$/.test(exp)) return false;
    const key = await crypto.subtle.importKey("raw", b64u.dec(OWNER_PUBKEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u.dec(sig), msgFor(user, exp));
    return ok ? { exp: +exp } : false;
  } catch { return false; }
}
async function signCode(user, exp) {
  const pk = localStorage.getItem("owner.key"); if (!pk) throw new Error("no key");
  const key = await crypto.subtle.importKey("pkcs8", b64u.dec(pk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, msgFor(user, exp));
  return `${exp}.${b64u.enc(sig)}`;
}
const isOwner = () => !!localStorage.getItem("owner.key");
window.isAppOwner = () => isOwner() || isOwnerId();
const sessionUser = () => (Moodle.session && (Moodle.session.username || "")) || "";

// called by the router: returns true if the app may open
let accessOk = null;
function claimOwner() {
  const m = location.hash.match(/^#owner-([A-Za-z0-9_-]{100,})$/);
  if (!m) return false;
  localStorage.setItem("owner.key", m[1]); history.replaceState(null, "", location.pathname + "#admin");
  setTimeout(() => toast("👑 صرت صاحب التطبيق على هاد الجهاز"), 600); return true;
}
window.accessGate = () => {
  if (claimOwner()) { route(); return false; }
  if (!Moodle.session) return true;
  if (isOwner() || isOwnerId()) return true;
  const user = sessionUser(); if (!user) return true; // older session without the ID: checked after it's fetched
  const act = S.get("activation", null);
  if (accessOk === user) return true;
  if (act && act.user === user.toLowerCase() && (act.exp === 0 || act.exp >= todayNum())) {
    verifyCode(user, act.code).then(r => { if (r && (r.exp === 0 || r.exp >= todayNum())) accessOk = user; else { S.del("activation"); route(); } });
    return true;
  }
  viewActivate(act && act.user === user.toLowerCase() ? "expired" : "new");
  return false;
};

function viewActivate(kind) {
  $tabbar.hidden = true; document.body.classList.add("no-tabs"); setTimeout(() => { $tabbar.hidden = true; }, 50);
  const user = sessionUser(), name = (Moodle.session.fullname || "");
  $app.innerHTML = `<div class="login"><div class="page" style="max-width:440px">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1 style="margin:0 0 6px">${kind === "expired" ? "انتهى اشتراكك" : "التطبيق بده تفعيل"}</h1>
    <p class="muted" style="margin:0 0 16px">${kind === "expired" ? "جدّد الاشتراك عشان ترجع تستخدم واجباتي." : "واجباتي خاص، وبيشتغل بعد ما صاحب التطبيق يوافق عليك."}</p>
    <div class="card"><div class="small muted">رقمك الجامعي</div><b dir="ltr" style="font-size:20px">${esc(user)}</b><div class="small muted">${esc(name)}</div>
      <button class="btn primary block" id="areq" style="margin-top:10px">📩 ابعت طلب تفعيل</button></div>
    <div class="card"><div class="field"><label>وصلك كود التفعيل؟ الصقه هون</label><input class="input" id="acode" dir="ltr" placeholder="مثلاً 20270131.MEUCIQ…"></div>
      <div id="aerr"></div><button class="btn block" id="ago">✓ فعّل</button></div>
    <button class="link" onclick="logout()">تسجيل خروج</button></div></div>`;
  document.getElementById("areq").onclick = () => shareOrCopy({ title: "طلب تفعيل واجباتي", text: `مرحبا 👋 بدي أفعّل تطبيق واجباتي.\nالاسم: ${name}\nالرقم الجامعي: ${user}` });
  document.getElementById("ago").onclick = async () => {
    const code = document.getElementById("acode").value.trim(); if (!code) return;
    // the owner can paste their owner link (or key) here — needed on iPhone, where the home-screen app
    // has its own storage separate from Safari
    const ok = code.match(/(?:#owner-)?(MIG[A-Za-z0-9_-]{100,})/);
    if (ok) {
      try {
        localStorage.setItem("owner.key", ok[1]);
        const test = await signCode("selftest", 0);
        if (!(await verifyCode("selftest", test))) throw 0;
        accessOk = user; buzz(); confetti(); toast("👑 صرت صاحب التطبيق على هاد الجهاز"); location.hash = "home"; route(); return;
      } catch { localStorage.removeItem("owner.key"); document.getElementById("aerr").innerHTML = `<div class="err">مفتاح المالك غلط.</div>`; return; }
    }
    const r = await verifyCode(user, code);
    if (!r) { document.getElementById("aerr").innerHTML = `<div class="err">الكود غلط أو مش إلك. تأكد إنك نسخته كامل.</div>`; return; }
    if (r.exp !== 0 && r.exp < todayNum()) { document.getElementById("aerr").innerHTML = `<div class="err">هاد الكود منتهي.</div>`; return; }
    S.set("activation", { user: user.toLowerCase(), code, exp: r.exp }); accessOk = user; buzz(); confetti();
    toast("✓ تفعّل التطبيق، أهلاً فيك!"); location.hash = "home"; route();
  };
}

/* ---------- owner panel: make activation codes ---------- */
routes.admin = async () => {
  if (!isOwner() && isOwnerId()) {
    $app.innerHTML = `<div class="page enter" style="max-width:440px"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>
      <div class="card" style="text-align:center"><div style="font-size:40px">🔑</div><b>كلمة سر المالك</b><p class="small muted">مرة وحدة بس على هاد الجهاز</p>
      <input class="input" id="opw" dir="ltr" autocapitalize="off" autocomplete="off" style="text-align:center;font-size:20px;letter-spacing:3px;margin:8px 0"><div id="operr"></div>
      <button class="btn primary block" id="opgo">فتح</button></div></div>`;
    document.getElementById("opgo").onclick = async () => {
      const b = document.getElementById("opgo"); b.disabled = true; b.textContent = "⏳…";
      try { await unlockOwnerKey(document.getElementById("opw").value); buzz(); routes.admin(); }
      catch { b.disabled = false; b.textContent = "فتح"; document.getElementById("operr").innerHTML = `<div class="err">كلمة السر غلط</div>`; }
    };
    return;
  }
  if (!isOwner()) { $app.innerHTML = `<div class="page"><div class="empty">هاي الصفحة لصاحب التطبيق بس.</div></div>`; return; }
  const log = S.get("owner.log", []);
  $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button><span class="pill ok">👑 صاحب التطبيق</span></div>
    <h1 style="margin:0 0 12px;font-size:22px">🔑 تفعيل الطلاب</h1>
    <div class="card"><div class="field"><label>الرقم الجامعي للطالب</label><input class="input" id="ou" dir="ltr" inputmode="numeric" placeholder="32201003009"></div>
      <div class="field"><label>المدة</label><div class="seg" id="od"><button data-d="30">شهر</button><button data-d="120" class="on">فصل</button><button data-d="365">سنة</button><button data-d="0">دايم</button></div></div>
      <button class="btn primary block" id="ogo">اعمل كود</button><div id="oout"></div></div>
    ${log.length ? `<h2>آخر الأكواد</h2>${log.slice(-15).reverse().map(l => `<div class="card item" style="cursor:default"><div class="ic">🎟️</div><div class="body"><div class="title" dir="ltr">${esc(l.user)}</div><div class="due">${l.exp ? "لغاية " + String(l.exp).replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1") : "دايم"} · ${new Date(l.t).toLocaleDateString("ar-JO")}</div></div></div>`).join("")}` : ""}
    <p class="small muted">🔒 مفتاح المالك محفوظ على هاد الجهاز بس. لا تمسح بيانات المتصفح قبل ما تحفظ رابط المالك بمكان آمن.</p></div>`;
  let days = 120;
  document.getElementById("od").onclick = e => { const b = e.target.closest("button"); if (!b) return; days = +b.dataset.d; document.querySelectorAll("#od button").forEach(x => x.classList.toggle("on", x === b)); };
  document.getElementById("ogo").onclick = async () => {
    const u = document.getElementById("ou").value.trim(); if (!u) return;
    let exp = 0; if (days) { const d = new Date(); d.setDate(d.getDate() + days); exp = +d.toLocaleDateString("en-CA", { timeZone: "Asia/Amman" }).replace(/-/g, ""); }
    const code = await signCode(u, exp);
    const l = S.get("owner.log", []); l.push({ user: u, exp, t: Date.now() }); S.set("owner.log", l.slice(-100));
    document.getElementById("oout").innerHTML = `<div class="goodnote" style="word-break:break-all" dir="ltr">${esc(code)}</div><button class="btn block" id="osend">↗ ابعته للطالب</button>`;
    document.getElementById("osend").onclick = () => shareOrCopy({ title: "كود تفعيل واجباتي", text: `كود تفعيل واجباتي 🎉 (انسخه والصقه بالتطبيق):\n${code}` });
    buzz();
  };
};

// the owner opens a special link once to keep the key on their phone: #owner-<key>
