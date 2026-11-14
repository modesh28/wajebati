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
/* ---------- automatic requests: the student's request reaches the owner's app, the owner taps "approve",
   and the signed code goes back to the student's app by itself. Messages pass through ntfy.sh (a free message relay).
   Requests are encrypted with the owner's key, so only the owner can read the student's name and ID;
   replies are signed codes that only work for that student's own e-learning account. ---------- */
const RELAY = "https://ntfy.sh/";
const REQ_TOPIC = "wajebati-req-" + OWNER_PUBKEY.slice(8, 24).replace(/[^A-Za-z0-9]/g, "x");
// a second topic only for the owner's phone notification (no names in it) — the owner subscribes to it in the ntfy app
const PING_TOPIC = "wajebati-ping-" + OWNER_PUBKEY.slice(30, 48).replace(/[^A-Za-z0-9]/g, "x");
const pingOwner = (text) => relayPost(PING_TOPIC, text, "?title=" + encodeURIComponent("واجباتي 📩") + "&tags=key&priority=high").catch(() => {});
async function ansTopic(user) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wajebati-ans|" + String(user).trim().toLowerCase())));
  return "wajebati-ans-" + [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function relayPost(topic, text, q = "") {
  const r = await fetch(RELAY + topic + q, { method: "POST", body: text }); if (!r.ok) throw new Error("relay " + r.status);
}
async function relayPoll(topic, since = "12h") {
  const r = await fetch(`${RELAY}${topic}/json?poll=1&since=${encodeURIComponent(since)}`); if (!r.ok) throw new Error("relay " + r.status);
  return (await r.text()).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(m => m && m.event === "message");
}
// encrypt the request for the owner (ECDH with the owner's public key + AES-GCM)
async function sealForOwner(obj) {
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const pub = await crypto.subtle.importKey("raw", b64u.dec(OWNER_PUBKEY), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return "W1." + b64u.enc(await crypto.subtle.exportKey("raw", eph.publicKey)) + "." + b64u.enc(iv) + "." + b64u.enc(c);
}
async function openAsOwner(txt) {
  try {
    const [v, e, iv, c] = String(txt).split("."); if (v !== "W1") return null;
    const priv = await crypto.subtle.importKey("pkcs8", b64u.dec(localStorage.getItem("owner.key")), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
    const pub = await crypto.subtle.importKey("raw", b64u.dec(e), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.dec(iv) }, key, b64u.dec(c))));
  } catch { return null; }
}
// owner: requests waiting for an answer (kept on the owner's phone, because the relay forgets after 12 hours)
async function fetchRequests() {
  const box = S.get("owner.reqs", {}); const done = S.get("owner.done", {});
  let msgs = []; try { msgs = await relayPoll(REQ_TOPIC); } catch {}
  for (const m of msgs) {
    if (box[m.id] || done[m.id]) continue;
    const r = await openAsOwner(m.message); if (!r || !r.user) continue;
    const u = String(r.user).toLowerCase();
    // already approved this student: send the code again automatically (they may have missed it)
    const prev = S.get("owner.log", []).filter(l => l.user.toLowerCase() === u && l.code && (l.exp === 0 || l.exp >= todayNum())).pop();
    if (prev) { done[m.id] = 1; ansTopic(u).then(t => relayPost(t, "OK." + prev.code)).catch(() => {}); continue; }
    for (const [k, v] of Object.entries(box)) if (v.user.toLowerCase() === u) delete box[k]; // keep only the newest request per student
    box[m.id] = { user: r.user, name: r.name || "", site: r.site || "", plan: r.plan || 0, t: m.time * 1000 };
  }
  S.set("owner.reqs", box); S.set("owner.done", done);
  return box;
}
window.ownerPendingCount = async () => isOwner() ? Object.keys(await fetchRequests()).length : 0;
const isOwner = () => !!localStorage.getItem("owner.key");
window.isAppOwner = () => isOwner() || isOwnerId();
const sessionUser = () => (Moodle.session && (Moodle.session.username || "")) || "";

// free trial: one week from the first time a student opens the app, then it needs a subscription
const TRIAL_DAYS = 3;
// the trial server (server/ folder, Cloudflare). Empty = trial is tracked on the phone only.
const TRIAL_SERVER = "https://wajebati-server.ut6uhhji.workers.dev";
const PAY = { cliq: "MOD287", name: "Mohammad Amer Salem Alshwiki", semester: 3, year: 5 };
function trialLeft(user) {
  const u = String(user).toLowerCase(); if (!u) return 0;
  // the server's answer wins: same dates on every phone and after reinstalling
  const sv = S.get("trial.srv", null);
  if (sv && sv.user === u) return Math.max(0, sv.end - (Date.now() + (sv.skew || 0)));
  let t = S.get("trial", null);
  if (!t || t.user !== u) { t = { user: u, start: Date.now(), seen: Date.now() }; S.set("trial", t); }
  // moving the phone's clock back doesn't bring the trial back
  if (Date.now() < (t.seen || 0) - 36e5) return 0;
  t.seen = Math.max(t.seen || 0, Date.now()); S.set("trial", t);
  return Math.max(0, t.start + TRIAL_DAYS * 864e5 - Date.now());
}
let trialSyncing = false;
async function syncTrial(user) {
  const u = String(user).toLowerCase(); if (!TRIAL_SERVER || !u || trialSyncing) return;
  const sv = S.get("trial.srv", null); if (sv && sv.user === u && Date.now() - sv.t < 3 * 36e5) return;
  trialSyncing = true;
  try {
    const r = await fetch(TRIAL_SERVER.replace(/\/$/, "") + "/trial", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: u }) });
    const j = await r.json();
    if (j && j.end) { S.set("trial.srv", { user: u, end: j.end, skew: j.now - Date.now(), t: Date.now() }); if (trialLeft(u) <= 0) route(); }
  } catch {} finally { trialSyncing = false; }
}
const isActivated = (user) => { const a = S.get("activation", null); return !!(a && a.user === String(user).toLowerCase() && (a.exp === 0 || a.exp >= todayNum())); };
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
  if (location.hash === "#subscribe") { viewActivate("trial"); return false; }
  if (!(act && act.user === user.toLowerCase())) syncTrial(user);
  if (!(act && act.user === user.toLowerCase()) && trialLeft(user) > 0) return true; // still in the free trial
  viewActivate(act && act.user === user.toLowerCase() ? "expired" : "trialover");
  return false;
};

function viewActivate(kind) {
  $tabbar.hidden = true; document.body.classList.add("no-tabs"); setTimeout(() => { $tabbar.hidden = true; }, 50);
  const user = sessionUser(), name = (Moodle.session.fullname || "");
  $app.innerHTML = `<div class="login"><div class="page" style="max-width:440px">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1 style="margin:0 0 6px">${kind === "expired" ? "انتهى اشتراكك" : kind === "trial" ? "اشترك بواجباتي ✨" : kind === "trialover" ? "خلصت التجربة المجانية 🎁" : "التطبيق بده تفعيل"}</h1>
    <p class="muted" style="margin:0 0 16px">${kind === "expired" ? "جدّد الاشتراك عشان ترجع تستخدم واجباتي." : kind === "trial" ? `باقيلك ${Math.ceil(trialLeft(user) / 864e5)} أيام من التجربة المجانية. اشترك هلأ عشان ما يوقف.` : kind === "trialover" ? "إن شاء الله عجبك! اشترك عشان تكمّل." : "واجباتي خاص، وبيشتغل بعد ما صاحب التطبيق يوافق عليك."}</p>
    <div class="card"><b>💳 الاشتراك</b>
      <div class="seg" id="aplan" style="margin:10px 0"><button data-d="120" class="on">فصل · ${PAY.semester} دنانير</button><button data-d="365">سنة · ${PAY.year} دنانير</button></div>
      <div class="small muted">حوّل المبلغ على <b>CliQ</b>:</div>
      <div style="display:flex;gap:8px;align-items:center;margin:6px 0"><code dir="ltr" style="flex:1;padding:10px;border-radius:10px;background:var(--accent-soft);font-size:18px;font-weight:700;text-align:center;letter-spacing:1px">${PAY.cliq}</code><button class="btn" id="acopy">📋 نسخ</button></div>
      <div class="small" dir="ltr" style="text-align:center">${PAY.name}</div>
      <div class="small muted" style="margin-top:8px">اكتب رقمك الجامعي بملاحظة التحويل، وبعدين اكبس «ابعت طلب تفعيل» تحت. أول ما يوصل المبلغ بيتفعّل عندك لحاله.</div></div>
    <div class="card"><div class="small muted">رقمك الجامعي</div><b dir="ltr" style="font-size:20px">${esc(user)}</b><div class="small muted">${esc(name)}</div>
      <button class="btn primary block" id="areq" style="margin-top:10px">📩 ابعت طلب تفعيل</button><div id="astate"></div></div>
    <div class="card"><div class="field"><label>وصلك كود التفعيل؟ الصقه هون</label><input class="input" id="acode" dir="ltr" placeholder="مثلاً 20270131.MEUCIQ…"></div>
      <div id="aerr"></div><button class="btn block" id="ago">✓ فعّل</button></div>
    ${kind === "trial" ? `<button class="link" onclick="location.hash='home'">← رجوع للتطبيق</button>` : `<button class="link" onclick="logout()">تسجيل خروج</button>`}</div></div>`;
  let plan = 120;
  document.getElementById("aplan").onclick = e => { const b = e.target.closest("button"); if (!b) return; plan = +b.dataset.d; document.querySelectorAll("#aplan button").forEach(x => x.classList.toggle("on", x === b)); };
  document.getElementById("acopy").onclick = () => { navigator.clipboard && navigator.clipboard.writeText(PAY.cliq).then(() => toast("✓ انسخ " + PAY.cliq)).catch(() => {}); };
  const st = document.getElementById("astate"), rb = document.getElementById("areq");
  const waiting = (sent) => { rb.textContent = "⏳ الطلب وصل، بنستنى الموافقة"; rb.disabled = true;
    st.innerHTML = `<div class="small muted" style="margin-top:8px">${sent ? "انبعت ✓ " : ""}أول ما صاحب التطبيق يوافق، رح يتفعّل عندك لحاله. خلّيك على هاي الصفحة أو ارجعلها بعدين.</div><button class="link small" id="ashare">أو ابعتله رسالة</button>`;
    document.getElementById("ashare").onclick = () => shareOrCopy({ title: "طلب تفعيل واجباتي", text: `مرحبا 👋 بعتلك طلب تفعيل على واجباتي.\nالاسم: ${name}\nالرقم الجامعي: ${user}` }); };
  const activate = async (code) => {
    const r = await verifyCode(user, code); if (!r || (r.exp !== 0 && r.exp < todayNum())) return false;
    S.set("activation", { user: user.toLowerCase(), code, exp: r.exp }); S.del("act.req"); accessOk = user; buzz(); confetti();
    toast("✓ تمت الموافقة، أهلاً فيك!"); location.hash = "home"; route(); return true;
  };
  // listen for the owner's answer
  let stop = false, since = "12h";
  const listen = async () => {
    const topic = await ansTopic(user);
    while (!stop && document.getElementById("astate")) {
      try {
        const msgs = await relayPoll(topic, since);
        for (const m of msgs) {
          since = m.id;
          if (m.message.startsWith("OK.") && await activate(m.message.slice(3))) { stop = true; return; }
          if (m.message === "NO" && (S.get("act.req", 0) < m.time * 1000)) { S.del("act.req"); rb.disabled = false; rb.textContent = "📩 ابعت الطلب مرة ثانية"; st.innerHTML = `<div class="err" style="margin-top:8px">صاحب التطبيق ما وافق على الطلب.</div>`; }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 6000));
    }
  };
  listen();
  if (S.get("act.req", 0) > Date.now() - 12 * 3600 * 1000) waiting(false);
  rb.onclick = async () => {
    rb.disabled = true; rb.textContent = "⏳ عم ببعت…";
    try {
      await relayPost(REQ_TOPIC, await sealForOwner({ user, name, plan, site: Moodle.SITE.replace(/^https:\/\//, "") }), "?title=" + encodeURIComponent("📩 طلب تفعيل جديد — واجباتي") + "&tags=key&click=" + encodeURIComponent(location.origin + location.pathname + "#admin"));
      pingOwner("في طالب بعتلك طلب تفعيل. افتح واجباتي ← الإعدادات ← تفعيل الطلاب ووافق عليه.");
      S.set("act.req", Date.now()); waiting(true);
    } catch {
      rb.disabled = false; rb.textContent = "📩 ابعت طلب تفعيل";
      st.innerHTML = `<div class="err" style="margin-top:8px">ما زبط الإرسال (النت؟). جرّب كمان مرة، أو ابعتله رسالة:</div>`;
      shareOrCopy({ title: "طلب تفعيل واجباتي", text: `مرحبا 👋 بدي أفعّل تطبيق واجباتي.\nالاسم: ${name}\nالرقم الجامعي: ${user}` });
    }
  };
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
    <h2 style="margin-top:0">📩 طلبات التفعيل</h2>
    <div class="field"><label>المدة (إذا الطالب ما اختار)</label><div class="seg" id="rd"><button data-d="7">أسبوع</button><button data-d="30">شهر</button><button data-d="120" class="on">فصل</button><button data-d="365">سنة</button><button data-d="0">دايم</button></div></div>
    <div id="reqs"><div class="card small muted">⏳ بجيب الطلبات…</div></div>
    <details class="card" id="pingcard" ${S.get("owner.ping") ? "" : "open"}><summary><b>🔔 خلّي الطلبات توصلك إشعار عتلفون</b> <span class="small muted">${S.get("owner.ping") ? "✓ مربوط" : "حتى لو التطبيق مسكّر"}</span></summary>
      <ol class="small" style="line-height:2;padding-inline-start:20px;margin:10px 0">
        <li>نزّل تطبيق <b>ntfy</b> المجاني: <a href="https://apps.apple.com/app/id1625396347" target="_blank" rel="noopener">آيفون</a> · <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">أندرويد</a></li>
        <li>افتحه، اسمح بالإشعارات، واكبس <b>+</b> (Subscribe to topic)</li>
        <li>الصق اسم القناة هاد واكبس Subscribe:</li></ol>
      <div style="display:flex;gap:8px"><code dir="ltr" style="flex:1;padding:10px;border-radius:10px;background:var(--accent-soft);word-break:break-all;font-size:13px">${PING_TOPIC}</code><button class="btn" id="pcopy">📋 نسخ</button></div>
      <button class="btn block" id="ptest" style="margin-top:8px">🔔 ابعت إشعار تجربة</button>
      <p class="small muted" style="margin:8px 0 0">الإشعار بيحكيلك إنه في طلب بس، بدون اسم الطالب أو رقمه. التفاصيل والموافقة بتكون هون.</p></details>
    <h2>أو اعمل كود بإيدك</h2>
    <div class="card"><div class="field"><label>الرقم الجامعي للطالب</label><input class="input" id="ou" dir="ltr" inputmode="numeric" placeholder="32201003009"></div>
      <div class="field"><label>المدة</label><div class="seg" id="od"><button data-d="7">أسبوع</button><button data-d="30">شهر</button><button data-d="120" class="on">فصل</button><button data-d="365">سنة</button><button data-d="0">دايم</button></div></div>
      <button class="btn primary block" id="ogo">اعمل كود</button><div id="oout"></div></div>
    ${log.length ? `<h2>آخر الأكواد</h2>${log.slice(-15).reverse().map(l => `<div class="card item" style="cursor:default"><div class="ic">🎟️</div><div class="body"><div class="title" dir="ltr">${esc(l.user)}</div><div class="due">${l.exp ? "لغاية " + String(l.exp).replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1") : "دايم"} · ${new Date(l.t).toLocaleDateString("ar-JO")}</div></div></div>`).join("")}` : ""}
    <p class="small muted">🔒 مفتاح المالك محفوظ على هاد الجهاز بس. لا تمسح بيانات المتصفح قبل ما تحفظ رابط المالك بمكان آمن.</p></div>`;
  const expFor = d => { if (!d) return 0; const x = new Date(); x.setDate(x.getDate() + d); return +x.toLocaleDateString("en-CA", { timeZone: "Asia/Amman" }).replace(/-/g, ""); };
  let rdays = 120;
  document.getElementById("rd").onclick = e => { const b = e.target.closest("button"); if (!b) return; rdays = +b.dataset.d; document.querySelectorAll("#rd button").forEach(x => x.classList.toggle("on", x === b)); };
  const drawReqs = async () => {
    const el = document.getElementById("reqs"); if (!el) return;
    const box = await fetchRequests(); const list = Object.entries(box).sort((a, b) => b[1].t - a[1].t);
    if (!document.getElementById("reqs")) return;
    el.innerHTML = list.length ? list.map(([id, r]) => `<div class="card"><div style="display:flex;gap:10px;align-items:center"><div class="ic" style="font-size:26px">🎓</div>
        <div style="flex:1;min-width:0"><b>${esc(r.name || "طالب")}</b><div class="small" dir="ltr" style="text-align:right">${esc(r.user)}</div>${r.plan ? `<div class="small"><span class="pill ok">بده: ${r.plan === 365 ? "سنة · " + PAY.year : "فصل · " + PAY.semester} دنانير</span></div>` : ""}
        <div class="small muted">${esc(r.site)} · ${new Date(r.t).toLocaleString("ar-JO", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })}</div></div></div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" style="flex:2" data-ok="${id}">✓ وافق</button><button class="btn" style="flex:1" data-no="${id}">✕ رفض</button></div></div>`).join("")
      : `<div class="card small muted">ما في طلبات جديدة. أول ما طالب يبعت طلب بيطلع هون.</div>`;
  };
  document.getElementById("reqs").onclick = async e => {
    const b = e.target.closest("button[data-ok],button[data-no]"); if (!b) return;
    const id = b.dataset.ok || b.dataset.no, box = S.get("owner.reqs", {}), r = box[id]; if (!r) return;
    b.disabled = true; b.textContent = "⏳";
    try {
      const topic = await ansTopic(r.user);
      if (b.dataset.ok) {
        const exp = expFor(r.plan || rdays), code = await signCode(r.user, exp);
        await relayPost(topic, "OK." + code);
        const l = S.get("owner.log", []); l.push({ user: r.user, name: r.name, exp, code, t: Date.now() }); S.set("owner.log", l.slice(-200));
        toast(`✓ تفعّل ${r.name || r.user}`); buzz();
      } else { await relayPost(topic, "NO"); toast("انرفض الطلب"); }
      delete box[id]; S.set("owner.reqs", box); const done = S.get("owner.done", {}); done[id] = 1; S.set("owner.done", done);
      drawReqs();
    } catch { b.disabled = false; b.textContent = b.dataset.ok ? "✓ وافق" : "✕ رفض"; toast("ما زبط الإرسال، تأكد من النت"); }
  };
  document.getElementById("pcopy").onclick = () => { navigator.clipboard && navigator.clipboard.writeText(PING_TOPIC).then(() => toast("✓ انسخ")).catch(() => {}); };
  document.getElementById("ptest").onclick = async () => { await pingOwner("هاد إشعار تجربة ✓ الربط شغّال، أي طلب تفعيل جديد رح يوصلك هيك."); S.set("owner.ping", 1); toast("انبعت، لازم يوصلك عتلفون خلال ثواني"); };
  drawReqs();
  const riv = setInterval(() => { if (!document.getElementById("reqs")) return clearInterval(riv); drawReqs(); }, 15000);
  let days = 120;
  document.getElementById("od").onclick = e => { const b = e.target.closest("button"); if (!b) return; days = +b.dataset.d; document.querySelectorAll("#od button").forEach(x => x.classList.toggle("on", x === b)); };
  document.getElementById("ogo").onclick = async () => {
    const u = document.getElementById("ou").value.trim(); if (!u) return;
    let exp = 0; if (days) { const d = new Date(); d.setDate(d.getDate() + days); exp = +d.toLocaleDateString("en-CA", { timeZone: "Asia/Amman" }).replace(/-/g, ""); }
    const code = await signCode(u, exp);
    const l = S.get("owner.log", []); l.push({ user: u, exp, code, t: Date.now() }); S.set("owner.log", l.slice(-200));
    document.getElementById("oout").innerHTML = `<div class="goodnote" style="word-break:break-all" dir="ltr">${esc(code)}</div><button class="btn block" id="osend">↗ ابعته للطالب</button>`;
    ansTopic(u).then(t => relayPost(t, "OK." + code)).catch(() => {}); // also reaches their app directly if they're waiting
    document.getElementById("osend").onclick = () => shareOrCopy({ title: "كود تفعيل واجباتي", text: `كود تفعيل واجباتي 🎉 (انسخه والصقه بالتطبيق):\n${code}` });
    buzz();
  };
};

// the owner opens a special link once to keep the key on their phone: #owner-<key>

// owner: on opening the app, tell them if students are waiting
setTimeout(async () => { try { if (!isOwner()) return; const n = await ownerPendingCount(); if (n) toast(`📩 عندك ${n} ${n === 1 ? "طلب تفعيل" : "طلبات تفعيل"} — من الإعدادات ← تفعيل الطلاب`); } catch {} }, 2500);
// badge on the settings button
(function () { const base = routes.settings; routes.settings = async (...a) => { await base(...a); if (window.isAppOwner && isAppOwner() && localStorage.getItem("owner.key")) ownerPendingCount().then(n => { const b = document.getElementById("reqbadge"); if (b && n) { b.hidden = false; b.textContent = n; } }).catch(() => {}); }; })();
// during the free week: a small banner on the home screen
(function () { const base = routes.home; routes.home = async (...a) => { await base(...a);
  try { const u = sessionUser(); if (!u || isOwner() || isOwnerId() || isActivated(u)) return; const left = trialLeft(u); if (!left) return;
    const d = Math.ceil(left / 864e5), el = document.createElement("div");
    el.className = "card"; el.style.cssText = "display:flex;align-items:center;gap:10px;cursor:pointer;border:1.5px solid var(--accent)";
    el.innerHTML = `<div style="font-size:26px">🎁</div><div style="flex:1"><b>تجربة مجانية · باقي ${d} ${d === 1 ? "يوم" : d === 2 ? "يومين" : "أيام"}</b><div class="small muted">اشترك بـ ${PAY.semester} دنانير للفصل أو ${PAY.year} للسنة</div></div><span class="pill ok">اشترك</span>`;
    el.onclick = () => { location.hash = "subscribe"; };
    const page = document.querySelector("#app .page"); if (page) page.insertBefore(el, page.children[1] || null);
  } catch {} }; })();
routes.subscribe = () => { location.hash = "home"; }; // already subscribed (or owner)
