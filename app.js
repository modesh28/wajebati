/* واجباتي — main app */
const $app = document.getElementById("app");
const $tabbar = document.getElementById("tabbar");
const S = Moodle.store;
const TZ = "Asia/Amman";
const fmtDate = new Intl.DateTimeFormat("ar-JO", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("ar-JO", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg, ms = 1800) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
function left(sec) {
  const m = Math.floor(sec / 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d > 0) return `${d} يوم${h ? ` و${h} س` : ""}`;
  if (h > 0) return `${h} س و${mi} د`;
  return `${Math.max(mi, 0)} دقيقة`;
}
const now = () => Math.floor(Date.now() / 1000);
function urgency(due) { const s = due - now(); return s < 0 ? "past" : s < 2 * 86400 ? "urgent" : s < 5 * 86400 ? "soon" : "ok"; }
function cleanCourse(n) { return String(n || "").replace(/^\d{4}\/\d{4}-\d-\d+-/, "").replace(/-\d+-\d+$/, "").replace(/\s+/g, " ").trim(); }

/* ---------------- theme ---------------- */
function applyTheme() {
  const t = S.get("theme", "auto"), dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? "#121210" : "#14532d";
  window.__dark = dark;
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

/* ---------------- data ---------------- */
let data = S.get("mdl.cache", null); // {courses, items, fetched}
let loading = null;

async function refresh(force = false) {
  if (loading) return loading;
  if (!force && data && data.v === 2 && Date.now() - data.fetched < 5 * 60 * 1000) return data;
  loading = (async () => {
    const courses = await Moodle.courses();
    const ids = courses.map(c => c.id);
    const [assigns, quizzes] = await Promise.all([
      Moodle.assignments(ids).catch(() => []),
      Moodle.quizzes(ids).catch(() => [])
    ]);
    const cname = Object.fromEntries(courses.map(c => [c.id, cleanCourse(c.name)]));
    let events = [];
    try { events = await Moodle.upcomingEvents(); } catch {}
    const items = [...assigns, ...quizzes].map(i => ({ ...i, coursename: cname[i.courseid] || cleanCourse(i.coursename) }));
    // mark what still needs action (from the calendar's "action events")
    const pending = new Set(events.filter(e => e.actionable).map(e => `${e.module === "assign" ? "assign" : e.module}:${e.instance}`));
    items.forEach(i => i.pending = pending.has(`${i.kind}:${i.id}`));
    // check what you already submitted / finished, so it never shows as "مطلوب منك"
    const t = now();
    const check = items.filter(i => i.due && i.due > t - 7 * 86400 && i.due < t + 120 * 86400);
    await Promise.all(check.map(async i => {
      try {
        if (i.kind === "assign") {
          const st = await Moodle.submissionStatus(i.id);
          i.submitted = st.status === "submitted" || st.graded;
        } else {
          const r = await Moodle.call("mod_quiz_get_user_attempts", { quizid: i.id, status: "finished" });
          i.submitted = (r.attempts || []).length > 0;
        }
      } catch { i.submitted = !i.pending && events.length > 0 && i.due > t; }
    }));
    const prev = data;
    data = { v: 2, courses: courses.map(c => ({ ...c, name: cleanCourse(c.name) })), items, fetched: Date.now() };
    S.set("mdl.cache", data);
    notifyNew(prev, data);
    return data;
  })();
  try { return await loading; } finally { loading = null; }
}

// show cached data instantly; refresh quietly and redraw only if something changed
function offlineNote() { if (document.getElementById("offline")) return; const d = document.createElement("div"); d.id = "offline"; d.className = "offline"; d.textContent = "📶 ما في نت، بعرض آخر نسخة محفوظة"; document.body.appendChild(d); }
window.addEventListener("online", () => { const o = document.getElementById("offline"); o && o.remove(); if (Moodle.session) refresh(true).then(() => route()).catch(() => {}); });
window.addEventListener("offline", offlineNote);
async function ensureData(redraw) {
  if (!data) { await refresh(); return; }
  const h = location.hash, before = JSON.stringify(data.items);
  refresh().then(d => { const o = document.getElementById("offline"); o && o.remove(); if (location.hash === h && JSON.stringify(d.items) !== before) redraw && redraw(); }).catch(e => { if (e && e.code === "auth") handleErr(e); else offlineNote(); });
}
function upcoming() {
  if (!data) return [];
  const t = now();
  return data.items.filter(i => i.due && i.due > t - 3600 && i.due < t + 120 * 86400).sort((a, b) => a.due - b.due);
}
function doneSet() { return new Set(S.get("done", [])); }
function isDone(i) { return doneSet().has(`${i.kind}:${i.id}`) || i.submitted; }

/* ---------------- notifications ---------------- */
async function notifyNew(prev, cur) {
  if (!prev || !("Notification" in window) || Notification.permission !== "granted") return;
  const known = new Set(prev.items.map(i => `${i.kind}:${i.id}`));
  const fresh = cur.items.filter(i => !known.has(`${i.kind}:${i.id}`));
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const i of fresh.slice(0, 5)) {
    const title = i.kind === "quiz" ? "نزل كويز جديد 📝" : "نزل واجب جديد 📚";
    const body = `${i.name} — ${i.coursename}${i.due ? "\nالتسليم: " + fmtShort.format(new Date(i.due * 1000)) : ""}`;
    reg ? reg.showNotification(title, { body, icon: "icons/icon-192.png", tag: `${i.kind}-${i.id}`, data: { url: `./#${i.kind}-${i.id}` } })
        : new Notification(title, { body });
  }
}
function remindDeadlines() {
  if (!("Notification" in window) || Notification.permission !== "granted" || !data) return;
  const sent = S.get("reminded", {});
  const t = now();
  for (const i of upcoming()) {
    if (isDone(i)) continue;
    const s = i.due - t;
    for (const [win, label] of [[86400, "باقي أقل من يوم"], [3 * 3600, "باقي أقل من ٣ ساعات"]]) {
      const key = `${i.kind}:${i.id}:${win}`;
      if (s > 0 && s < win && !sent[key]) {
        sent[key] = 1;
        navigator.serviceWorker?.getRegistration().then(reg => reg && reg.showNotification(`⏰ ${label}`, { body: `${i.name} — ${i.coursename}`, icon: "icons/icon-192.png", tag: key, data: { url: `./#${i.kind}-${i.id}` } }));
      }
    }
  }
  S.set("reminded", sent);
}


/* ---------------- learning memory: spaced review + weak points ---------------- */
const SRS_DAYS = [0, 1, 2, 4, 8, 16];
function srsAll() { return S.get("srs", []); }
function srsSave(list) { S.set("srs", list.slice(-600)); }
function srsKey(q) { return String(q).trim().toLowerCase().slice(0, 120); }
function srsAdd(cards, src) {
  const list = srsAll(), have = new Map(list.map(c => [srsKey(c.q), c]));
  for (const c of cards) { if (!c.q || !c.a) continue; const k = srsKey(c.q); if (!have.has(k)) { const n = { q: c.q, a: c.a, src: src || "", box: 1, due: Date.now() }; list.push(n); have.set(k, n); } }
  srsSave(list);
}
function srsGrade(q, a, ok, src) {
  const list = srsAll(); let c = list.find(x => srsKey(x.q) === srsKey(q));
  if (!c) { c = { q, a, src: src || "", box: 1, due: Date.now() }; list.push(c); }
  c.box = ok ? Math.min((c.box || 1) + 1, 5) : 1;
  c.due = Date.now() + (ok ? SRS_DAYS[c.box] * 86400000 : 10 * 60000);
  srsSave(list);
}
function srsDue() { const t = Date.now(); return srsAll().filter(c => c.due <= t); }
function addWeak(topic, src) { const w = S.get("weak", []); w.push({ topic: String(topic).slice(0, 160), src: src || "", t: Date.now() }); S.set("weak", w.slice(-40)); }
function weakSummary() { return S.get("weak", []).slice(-10).map(w => `- ${w.topic}${w.src ? ` (${w.src})` : ""}`).join("\n"); }


/* ---------------- router ---------------- */
const routes = {};
routes.review = async () => {
  const due = srsDue();
  $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button><span class="pill ok">🧠 ${due.length} بطاقة</span></div>
    <h1 style="margin:0 0 4px;font-size:22px">مراجعة اليوم</h1><p class="muted small" style="margin:0 0 14px">بطاقات من كل ملفاتك، بترجعلك بالوقت الصح عشان ما تنساها.</p><div id="rv"></div></div>`;
  if (!due.length) { document.getElementById("rv").innerHTML = `<div class="card" style="text-align:center"><div style="font-size:40px">🎉</div><b>خلّصت مراجعة اليوم</b><p class="muted">ارجع بكرا، أو اعمل بطاقات من أي ملف.</p></div>`; return; }
  renderCards(document.getElementById("rv"), due.sort(() => Math.random() - .5).slice(0, 30).map(c => ({ q: c.q, a: c.a, src: c.src })), "مراجعة");
};
function go(r) { location.hash = r; }
async function route() {
  const h = location.hash.slice(1) || "home";
  if (/^owner-/.test(h) && window.accessGate) { accessGate(); return; }
  if (!Moodle.session && !/^(ch|room)-/.test(h)) { $tabbar.hidden = true; document.body.classList.add("no-tabs"); return viewLogin(); }
  const [name, arg] = h.split(/-(.+)/);
  if (!["ch", "room"].includes(name) && window.accessGate && !accessGate()) return;
  $tabbar.hidden = false; document.body.classList.remove("no-tabs");
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.route === (["course", "assign", "quiz", "study"].includes(name) ? (name === "course" || name === "study" ? "courses" : "home") : name)));
  const fn = routes[name] || routes.home;
  if (h !== route.last) { route.last = h; document.body.dataset.anim = "1"; clearTimeout(route.at); route.at = setTimeout(() => delete document.body.dataset.anim, 350); }
  if ((name === "ch" || name === "room") && !Moodle.session) { try { await fn(arg); } catch (e) { handleErr(e); } return; }
  try { await fn(arg); } catch (e) { handleErr(e); }
}
function handleErr(e) {
  if (e && e.code === "auth") { Moodle.logout(); toast("انتهت الجلسة، سجّل دخول مرة ثانية"); return route(); }
  console.error(e);
  $app.innerHTML = `<div class="page"><div class="err">${esc(e.message || "صار خطأ")}</div><button class="btn" onclick="route()">جرّب مرة ثانية</button></div>`;
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => go(t.dataset.route)));
window.addEventListener("hashchange", route);

/* ---------------- views ---------------- */
function viewLogin() {
  $app.innerHTML = `<div class="login"><div class="page">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1 style="margin:0 0 4px">واجباتي</h1>
    <p class="muted" style="margin:0 0 22px">سجّل دخول بنفس حساب الإي ليرنينج تبع جامعة البلقاء.</p>
    <div id="lerr"></div>
    <form id="lf">
      <div class="field"><label>الرقم الجامعي</label><input class="input" name="u" inputmode="numeric" autocomplete="username" required></div>
      <div class="field"><label>كلمة السر</label><input class="input" name="p" type="password" autocomplete="current-password" required></div>
      <button class="btn primary block" id="lb">تسجيل الدخول</button>
    </form>
    <p class="small muted" style="margin-top:16px">🔒 كلمة السر بتروح مباشرة لموقع الجامعة وما بتنحفظ. التطبيق بيحتفظ بمفتاح دخول على هاد الجهاز بس.</p>
  </div></div>`;
  document.getElementById("lf").onsubmit = async e => {
    e.preventDefault();
    const f = e.target, b = document.getElementById("lb");
    b.disabled = true; b.textContent = "لحظة…";
    try {
      await Moodle.login(f.u.value.trim(), f.p.value);
      f.p.value = "";
      go("home"); route();
    } catch (err) {
      document.getElementById("lerr").innerHTML = `<div class="err">${esc(err.message)}</div>`;
      b.disabled = false; b.textContent = "تسجيل الدخول";
    }
  };
}

function skel(n) { return Array.from({ length: n }, () => `<div class="card item skel"><div class="ic"></div><div class="body"><div class="sk w60"></div><div class="sk w90"></div></div></div>`).join(""); }
function itemRow(i) {
  const d = isDone(i), u = urgency(i.due), s = i.due - now();
  return `<div class="card item" onclick="go('${i.kind}-${i.id}')">
    <div class="ic">${i.kind === "quiz" ? "📝" : "📄"}</div>
    <div class="body"><div class="course">${esc(i.coursename)}</div><div class="title" dir="auto">${esc(i.name)}</div>
      <div class="due">${fmtShort.format(new Date(i.due * 1000))}</div></div>
    <span class="pill ${d ? "ok" : u}">${d ? "✓ مسلّم" : s < 0 ? "انتهى" : left(s)}</span>
  </div>`;
}

routes.home = async () => {
  const sess = Moodle.session;
  const first = (sess.fullname || "").split(" ")[0];
  const render = () => {
    const up = upcoming().filter(i => i.due > now());
    const todo = up.filter(i => !isDone(i));
    const next = todo[0];
    const week = todo.filter(i => i.due - now() < 7 * 86400).length;
    const quizzes = todo.filter(i => i.kind === "quiz").length;
    const past = upcoming().filter(i => i.due <= now()).slice(-3).reverse();
    $app.innerHTML = `<div class="page">
      <div class="top"><div><div class="sub">أهلين ${esc(first)} 👋</div><h1>واجباتي</h1></div>
        <div class="avatar">${sess.picture ? `<img src="${esc(Moodle.fileUrl(sess.picture))}" alt="">` : esc(first[0] || "؟")}</div></div>
      ${next ? `<div class="hero" onclick="go('${next.kind}-${next.id}')">
          <div class="lbl">${next.kind === "quiz" ? "الكويز الجاي" : "الواجب الجاي"} · ${esc(next.coursename)}</div>
          <div class="row"><div class="t" dir="auto">${esc(next.name)}</div><div class="cd">${left(next.due - now())}</div></div>
          <div class="lbl">${fmtDate.format(new Date(next.due * 1000))}</div></div>`
        : data ? `<div class="hero"><div class="t">ما عليك ولا إشي هلأ 🎉</div><div class="lbl">استمتع بوقتك</div></div>` : ""}
      <div class="stats">
        <div class="stat"><b>${todo.length}</b><span>مطلوب منك</span></div>
        <div class="stat"><b>${week}</b><span>هالأسبوع</span></div>
        <div class="stat"><b>${quizzes}</b><span>كويزات</span></div>
      </div>
      ${!AI.ready() ? `<button class="card planbtn" onclick="go('settings')"><span>✨</span><div><b>فعّل المساعد الذكي</b><div class="small muted">حط مفتاح الذكاء الاصطناعي مرة وحدة (دقيقة) وبتشتغل كل أدوات الدراسة</div></div></button>` : ""}
      <div id="brief"></div>
      ${srsDue().length ? `<button class="card planbtn" onclick="go('review')"><span>🧠</span><div><b>مراجعة اليوم: ${srsDue().length} بطاقة</b><div class="small muted">دقايق مراجعة بتثبّت اللي درسته</div></div></button>` : ""}
      ${window.homeExtras ? homeExtras() : ""}
      ${installBanner()}${notifBanner()}
      <h2>مطلوب منك</h2>
      ${todo.length ? todo.map(itemRow).join("") : data ? `<div class="empty">خلّصت كل إشي 👌</div>` : skel(4)}
      ${up.length > todo.length ? `<details class="donebox"><summary>✓ خلّصتها (${up.length - todo.length})</summary>${up.filter(isDone).map(itemRow).join("")}</details>` : ""}
      ${past.length ? `<h2>فات موعدها مؤخراً</h2>${past.map(itemRow).join("")}` : ""}
      <p class="small muted" style="text-align:center;margin-top:18px">${data ? "آخر تحديث: " + fmtShort.format(new Date(data.fetched)) : ""} · <a href="#" onclick="event.preventDefault();pull()">تحديث</a></p>
    </div>`;
  };
  render(); brief();
  window.pull = async () => { try { await refresh(true); render(); remindDeadlines(); toast("✓"); } catch (e) { handleErr(e); } };
  try { await refresh(); }
  catch (e) { if (e.code === "auth" || !data) throw e; offlineNote(); return; }
  if (location.hash.slice(1) === "home" || !location.hash) { render(); brief(); remindDeadlines(); }
};

// "خطة اليوم": a short smart plan from the assistant, made once a day in the background
let briefBusy = false, briefLive = "";
async function brief() {
  const el0 = document.getElementById("brief"); if (!el0 || !data || !AI.ready()) return;
  const todo = upcoming().filter(i => i.due > now() && !isDone(i)).slice(0, 8);
  if (!todo.length) return;
  const sig = new Date().toDateString() + "|" + todo.map(i => i.kind + i.id).join(",");
  const saved = S.get("brief", {});
  const draw = (txt, live) => { const el = document.getElementById("brief"); if (!el) return;
    el.innerHTML = `<div class="card brief"><div class="bhead"><span>✨ خطة اليوم</span>${live ? `<span class="dots"><i></i><i></i><i></i></span>` : `<button class="link" id="rebrief">↻</button>`}</div><div class="msg ai">${txt ? AI.md(txt) : `<span class="small muted">بجهّزلك خطة اليوم…</span>`}</div></div>`;
    const r = document.getElementById("rebrief"); if (r) r.onclick = () => { S.set("brief", {}); brief(); }; };
  if (saved.sig === sig && saved.text) return draw(saved.text);
  if (briefBusy) return draw(briefLive, true);
  briefBusy = true; briefLive = ""; draw("", true);
  try {
    const list = todo.map(i => `- ${i.kind === "quiz" ? "كويز" : "واجب"}: ${i.name} (${i.coursename}) — باقي ${left(i.due - now())}`).join("\n");
    const txt = await AI.chat({ system: "إنت مساعد دراسي ذكي. احكي لهجة أردنية، مختصر جداً ومحفّز.", depth: "fast",
      messages: [{ role: "user", text: `الوقت هلأ ${fmtDate.format(new Date())}. هاي المطلوب مني:\n${list}\n\nاعطيني خطة اليوم بـ 3 نقاط قصيرة بس (كل نقطة سطر): شو أعمل أول وليش، وجملة تحفيز قصيرة بالآخر. بدون مقدمات.` }],
      onText: t => { briefLive = t; draw(t, true); } });
    S.set("brief", { sig, text: txt }); draw(txt);
  } catch { const el = document.getElementById("brief"); if (el) el.innerHTML = ""; }
  briefBusy = false;
}

/* install the app on the phone (Android shows a real install button, iPhone gets a 2-step hint) */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if ((location.hash || "#home") === "#home") route(); });
window.addEventListener("appinstalled", () => { installEvt = null; S.set("installed", 1); });
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
function installBanner() {
  if (isStandalone() || S.get("installHide")) return "";
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!installEvt && !ios) return "";
  return `<div class="card" style="display:flex;align-items:center;gap:10px"><span style="font-size:28px">📲</span>
    <div style="flex:1"><b>نزّل واجباتي على تلفونك</b><div class="small muted">${ios ? "اكبس زر المشاركة ⬆️ تحت، وبعدين «Add to Home Screen»" : "بيصير زي أي تطبيق، وبتوصلك الإشعارات"}</div></div>
    ${ios ? "" : `<button class="btn primary" onclick="doInstall()">تنزيل</button>`}<button class="link" onclick="S.set('installHide',1);route()">✕</button></div>`;
}
window.doInstall = async () => { if (!installEvt) return; installEvt.prompt(); const r = await installEvt.userChoice.catch(() => ({})); installEvt = null; if (r.outcome === "accepted") buzz(); route(); };
function notifBanner() {
  if (!("Notification" in window) || Notification.permission !== "default") return "";
  return `<div class="card" style="display:flex;align-items:center;gap:10px">
    <div style="flex:1"><b>شغّل الإشعارات 🔔</b><div class="small muted">عشان أنبّهك لما ينزل واجب أو يقرّب موعد التسليم</div></div>
    <button class="btn primary" onclick="askNotif()">تشغيل</button></div>`;
}
window.askNotif = async () => {
  const p = await Notification.requestPermission();
  if (p === "granted") { toast("تمام، الإشعارات شغّالة ✓"); registerPeriodic(); }
  route();
};

routes.courses = async () => {
  if (!data) $app.innerHTML = `<div class="page"><div class="top"><h1>المواد</h1></div>${skel(5)}</div>`;
  await ensureData(() => routes.courses());
  const counts = {};
  upcoming().filter(i => i.due > now() && !isDone(i)).forEach(i => counts[i.courseid] = (counts[i.courseid] || 0) + 1);
  $app.innerHTML = `<div class="page"><div class="top"><h1>المواد</h1><span class="sub">${data.courses.length} مادة</span></div>
    ${!data.courses.length ? `<div class="empty">📭 ما في مواد مسجّلة هالفصل لسا</div>` : ""}${data.courses.map(c => `<div class="card item" onclick="go('course-${c.id}')">
      <div class="ic">📘</div><div class="body"><div class="title" dir="auto">${esc(c.name)}</div>
      <div class="due">${counts[c.id] ? `${counts[c.id]} مطلوب منك` : "ما في إشي مطلوب"}</div></div>
      ${counts[c.id] ? `<span class="pill soon">${counts[c.id]}</span>` : ""}</div>`).join("") || `<div class="empty">ما في مواد</div>`}
  </div>`;
};

routes.course = async (id) => {
  await ensureData(() => routes.course(id));
  const c = data.courses.find(x => x.id == id);
  const items = data.items.filter(i => i.courseid == id).sort((a, b) => (b.due || 0) - (a.due || 0));
  const tab = sessionStorage.getItem("ctab-" + id) || "files";
  $app.innerHTML = `<div class="page">
    <div class="top"><button class="back" onclick="history.back()">→ رجوع</button>
      <button class="back" onclick="openMoodle('/course/view.php?id=${id}')">الإي ليرنينج ↗</button></div>
    <h1 style="margin:0 0 14px;font-size:21px" dir="auto">${esc(c ? c.name : "")}</h1>
    <div class="seg" id="ctabs" style="margin-bottom:14px"><button data-t="files" class="${tab === "files" ? "on" : ""}">📂 المحتوى</button><button data-t="work" class="${tab === "work" ? "on" : ""}">📝 الواجبات (${items.length})</button></div>
    <div id="cbody"></div>
  </div>`;
  const body = document.getElementById("cbody");
  const showWork = () => {
    body.innerHTML = items.length ? items.map(i => i.due ? itemRow(i) : `<div class="card item" onclick="go('${i.kind}-${i.id}')"><div class="ic">${i.kind === "quiz" ? "📝" : "📄"}</div><div class="body"><div class="title" dir="auto">${esc(i.name)}</div><div class="due">بدون موعد</div></div></div>`).join("") : `<div class="empty">ما في واجبات بهاي المادة</div>`;
  };
  const showFiles = async () => {
    body.innerHTML = skel(4);
    try {
      const secs = await Study.courseContents(id, () => { if (location.hash === "#course-" + id && (sessionStorage.getItem("ctab-" + id) || "files") === "files") showFiles(); });
      if (!secs.length) { body.innerHTML = `<div class="empty">ما في ملفات بهاي المادة لسا</div>`; return; }
      const order = sessionStorage.getItem("corder-" + id) || "first";
      let n = 0; secs.forEach(sec => sec.files.forEach(x => x.num = ++n));
      const view = order === "first" ? secs : secs.slice().reverse().map(sec => ({ ...sec, files: sec.files.slice().reverse() }));
      body.innerHTML = `<div class="quick">
          <button onclick="go('exam-${id}')"><span>📅</span>وضع الامتحان</button>
          <button onclick="go('cquiz-${id}')"><span>🎯</span>امتحان تجريبي</button>
          <button onclick="go('notes-${id}')"><span>📒</span>ملاحظاتي</button></div>` + (AI.ready() ? `<button class="card planbtn" id="plan"><span>🌳</span><div><b>خطة دراسة المادة</b><div class="small muted">خريطة شجرية: شو تدرس أول وبأي ترتيب</div></div></button><div id="planout"></div>` : "") + `<div class="orderbar"><span class="small muted">${n} ملف · مرتبين زي الإي ليرنينج</span>
        <div class="seg mini" id="corder"><button data-o="first" class="${order === "first" ? "on" : ""}">من الأول ⬇</button><button data-o="last" class="${order === "last" ? "on" : ""}">الأحدث ⬆</button></div></div>` + view.map(sec => `<h2 dir="auto">${esc(sec.name)}</h2>` + sec.files.map(f => {
        const k = Study.kindOf(f);
        const click = f.link ? `window.open('${esc(f.url)}','_blank')` : Study.studyable(k) ? `go('study-${id}.${f.cmid}.${f.idx}')` : `openMoodle('/mod/resource/view.php?id=${f.cmid}')`;
        return `<div class="card item" onclick="${click}"><div class="ic file-${k}">${Study.icon(k)}<span class="num">${f.num}</span></div>
          <div class="body"><div class="title" dir="auto">${esc(f.title)}</div><div class="due" dir="auto">${esc(f.filename)} ${Study.sizeLabel(f.size) ? "· " + Study.sizeLabel(f.size) : ""}</div></div>
          ${Study.studyable(k) ? `<span class="pill ok">ادرس ✨</span>` : ""}</div>`;
      }).join("")).join("");
      document.getElementById("corder").onclick = e => { const b = e.target.closest("button"); if (!b) return; sessionStorage.setItem("corder-" + id, b.dataset.o); buzz(); showFiles(); };
      const pb = document.getElementById("plan");
      if (pb) pb.onclick = async () => {
        buzz(); const po = document.getElementById("planout"); const key = "plan:" + id + ":" + secs.map(x => x.files.length).join(",");
        const cached = await KV.get(key); if (cached) { renderMindmap(po, cached); po.scrollIntoView({ behavior: "smooth" }); return; }
        po.innerHTML = `<div class="card answer"></div>`; const w = waiter(po.firstChild); w.status("thinking");
        const outline = secs.map(sec => `## ${sec.name}\n` + sec.files.map(x => "- " + x.title).join("\n")).join("\n");
        const work = (data ? data.items.filter(i => i.courseid == id && i.due > now()) : []).map(i => `- ${i.kind === "quiz" ? "كويز" : "واجب"}: ${i.name} — ${fmtShort.format(new Date(i.due * 1000))}`).join("\n");
        try {
          const txt = await Study.ask(null, `هاي محتويات مادة "${c ? c.name : ""}" على الإي ليرنينج مرتبة حسب الأسابيع:\n${outline}\n${work ? "\nوالمطلوب الجاي:\n" + work : ""}\n\n` + Study.PROMPTS.mindmap.replace("لمحتوى الملف", "لخطة دراسة المادة كاملة (كل فرع رئيسي = مرحلة دراسة، وجوّاه المواضيع/الملفات، وبالملاحظة ليش هاد الترتيب أو نصيحة)"), () => {}, null, (k2, m) => w.status(k2, m));
          w.stop(); const j = Study.parseJSON(txt); KV.set(key, j); renderMindmap(po, j); buzz();
        } catch (er) { w.stop(); po.innerHTML = `<div class="err">${esc(er.message)}</div>`; }
      };
    } catch (e) { if (e.code === "auth") return handleErr(e); body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  document.getElementById("ctabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; sessionStorage.setItem("ctab-" + id, b.dataset.t);
    document.querySelectorAll("#ctabs button").forEach(x => x.classList.toggle("on", x === b)); b.dataset.t === "files" ? showFiles() : showWork(); };
  tab === "files" ? showFiles() : showWork();
};

routes.study = async (arg) => {
  const [courseid, cmid, idx] = arg.split(".");
  const secs = await Study.courseContents(courseid);
  let f = null; for (const s of secs) for (const x of s.files) if (x.cmid == cmid && x.idx == idx) f = x;
  if (!f) { $app.innerHTML = `<div class="page"><div class="empty">ما لقيت الملف</div></div>`; return; }
  const k = Study.kindOf(f);
  const cname = (data && (data.courses.find(c => c.id == courseid) || {}).name) || "";
  const fileLink = Moodle.fileUrl(f.url);
  const RES = t => "res:" + Study.fkey(f) + ":" + t;
  $app.innerHTML = `<div class="page enter">
    <div class="top"><button class="back" onclick="history.back()">→ رجوع</button><span id="docstate" class="pill past">⏳ بجهّز الملف…</span></div>
    <div class="filehead"><div class="bigic file-${k}">${Study.icon(k)}</div>
      <div style="min-width:0"><div class="small muted" dir="auto">${esc(cname)}</div><h1 style="margin:0;font-size:20px" dir="auto">${esc(f.title)}</h1>
      <div class="small muted" dir="auto">${esc(f.filename)} ${Study.sizeLabel(f.size) ? "· " + Study.sizeLabel(f.size) : ""}</div></div></div>
    <div class="btns" style="margin:14px 0 4px">
      <a class="btn" href="${esc(fileLink)}" target="_blank" rel="noopener" onclick="buzz()">📥 افتح الملف</a>
    </div>
    <div id="ferr"></div>
    ${!AI.ready() ? `<div class="card"><b>حط مفتاح الـ AI أول</b><div class="btns"><button class="btn primary" onclick="go('settings')">الإعدادات</button></div></div>` : `
    <div class="tools" id="tools">
      <button class="tool on" data-t="zero"><span>🎓</span>من الصفر</button>
      <button class="tool" data-t="summary"><span>📝</span>ملخّص</button>
      <button class="tool" data-t="podcast"><span>🎧</span>بودكاست</button>
      <button class="tool" data-t="video"><span>🎬</span>فيديو</button>
      <button class="tool" data-t="mindmap"><span>🌳</span>خريطة</button>
      <button class="tool" data-t="sim"><span>🎮</span>محاكاة</button>
      <button class="tool" data-t="diagram"><span>📊</span>رسم</button>
      <button class="tool" data-t="cards"><span>🃏</span>بطاقات</button>
      <button class="tool" data-t="quiz"><span>🎯</span>كويز</button>
    </div>
    <div id="out"></div>
    <h2>اسأل عن الملف</h2>
    <div class="sugg" id="fsugg"><button class="chip">شو أهم إشي ممكن يجي بالامتحان؟</button><button class="chip">اعطيني مثال محلول</button><button class="chip">اشرحلي أصعب جزء</button></div>
    <div id="fchat" class="chat"></div>
    <form class="composer" id="fcomp" style="position:static"><div class="bar">
      <textarea id="finp" rows="1" placeholder="اسأل أي إشي عن الملف…" dir="auto"></textarea>
      <button class="iconbtn send" id="fsend">↑</button></div></form>`}
  </div>`;

  let doc = null, docErr = null;
  if (!AI.ready()) Study.load(f).then(d => doc = d).catch(() => {});
  // ---- NotebookLM: send the file + a ready prompt
  if (!AI.ready()) return;

  // ---- get the file ready in the background right away (from cache = instant)
  const state = document.getElementById("docstate");
  const docP = Study.load(f).then(d => { doc = d; state.className = "pill ok"; state.textContent = "✓ الملف جاهز"; return d; })
    .catch(e => { docErr = e; state.className = "pill urgent"; state.textContent = "⚠️ ما نزل"; showFetchErr(e); throw e; });
  docP.catch(() => {});
  function showFetchErr(e) {
    const el = document.getElementById("ferr"); if (!el) return;
    if (e.code === "fetch") {
      el.innerHTML = `<div class="note"><b>موقع الجامعة ما خلّى التطبيق ينزّل الملف لحاله.</b><br>نزّله من «📥 افتح الملف» وارفعه من هون 👇
        <div class="btns"><label class="btn primary">📤 ارفع الملف<input type="file" id="localf" accept=".pdf,.pptx,.docx,.txt,image/*" hidden></label></div></div>`;
      document.getElementById("localf").onchange = async ev => {
        const file = ev.target.files[0]; if (!file) return;
        try { doc = await Study.fromLocal(file); Study.remember(f, doc, file); docErr = null; el.innerHTML = ""; state.className = "pill ok"; state.textContent = "✓ الملف جاهز"; buzz(); run(current, false); }
        catch (er) { el.innerHTML = `<div class="err">${esc(er.message)}</div>`; }
      };
    } else el.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
  const getDoc = async () => { if (doc) return doc; if (docErr && docErr.code === "fetch") throw docErr; return docP; };

  // ---- study tools: cached results show instantly; summary starts by itself
  const out = document.getElementById("out");
  let current = "zero", runId = 0;
  async function run(t, fresh) {
    current = t; const my = ++runId;
    document.querySelectorAll(".tool").forEach(b => b.classList.toggle("on", b.dataset.t === t));
    const cached = !fresh && await KV.get(RES(t));
    if (my !== runId) return;
    if (cached) { show(t, cached, true); if (t === "zero") getDoc().then(prefetch).catch(() => {}); return; }
    out.innerHTML = `<div class="card answer"></div>`;
    const box = out.firstChild, w = waiter(box);
    let d; try { w.status("read"); d = await getDoc(); } catch (e) { w.stop(); out.innerHTML = ""; return; }
    if (my !== runId) return;
    try {
      if (TEXT_TOOLS.includes(t)) {
        const txt = await Study.ask(d, t, x => { if (my === runId) (t === "sim" ? w.status("build") : w.text(x)); }, null, (kk, m) => w.status(kk, m));
        KV.set(RES(t), txt); if (my === runId) show(t, txt, false);
        if (t === "zero") prefetch(d);
      } else {
        const txt = await Study.ask(d, t, () => {}, null, (kk, m) => w.status(kk, m)); w.stop();
        const j = Study.parseJSON(txt); KV.set(RES(t), j); if (my === runId) show(t, j, false);
      }
      buzz();
    } catch (err) { w.stop(); if (my === runId) out.innerHTML = `<div class="err">${esc(/JSON/.test(err.message) ? "ما طلع الجواب مرتب، جرّب مرة ثانية." : err.message)}</div><button class="btn" onclick="this.previousElementSibling.remove();this.remove()">تمام</button>`; }
  }
  function show(t, val, fromCache) {
    const canShare = ["zero", "summary", "explain", "diagram", "mindmap"].includes(t);
    const redo = `<div class="redo-row">${canShare ? `<button class="link" data-share>↗ شارك كصورة</button>` : ""}<button class="link redo" data-redo="${t}">↻ ${fromCache ? "اعمل واحد جديد" : "جديد"}</button></div>`;
    if (t === "sim") { out.innerHTML = `<div></div>${redo}`; renderSim(out.firstChild, val); }
    else if (TEXT_TOOLS.includes(t)) { out.innerHTML = `<div class="card msg ai answer">${AI.md(val)}</div>${redo}`; enhance(out.firstChild); }
    else {
      out.innerHTML = `<div></div>${redo}`;
      const el = out.firstChild;
      if (t === "cards") { renderCards(el, (val.cards || []).slice(), f.title); srsAdd(val.cards || [], f.title); }
      else if (t === "quiz") renderQuiz(el, val.questions || [], f.title);
      else if (t === "mindmap") renderMindmap(el, val);
      else if (t === "video") renderVideo(el, val);
      else if (t === "podcast") renderPodcast(el, val);
    }
    out.querySelector("[data-redo]").onclick = () => run(t, true);
    const shb = out.querySelector("[data-share]"); if (shb) shb.onclick = () => shareCard(out.firstElementChild, f.title);
  }
  // get the other tools ready while you read the summary, so they open instantly
  let prefetching = false;
  async function prefetch(d) {
    if (prefetching) return; prefetching = true;
    for (const t of PREFETCH) {
      if (!document.body.contains(out)) break;
      if (await KV.get(RES(t))) continue;
      try { const txt = await Study.ask(d, t, () => {}, null, null); const j = Study.parseJSON(txt); await KV.set(RES(t), j);
        const b = document.querySelector(`.tool[data-t="${t}"]`); if (b) b.classList.add("ready"); } catch { break; }
    }
  }
  (async () => { for (const t of [...PREFETCH, "zero", "summary", "explain", "video", "podcast", "sim", "diagram"]) if (await KV.get(RES(t))) { const b = document.querySelector(`.tool[data-t="${t}"]`); if (b) b.classList.add("ready"); } })();
  document.getElementById("tools").onclick = e => { const b = e.target.closest(".tool"); if (b) { buzz(); run(b.dataset.t, false); } };
  run("zero", false);

  // ---- chat about the file
  const msgs = [];
  const fchat = document.getElementById("fchat"), finp = document.getElementById("finp");
  finp.addEventListener("input", () => { finp.style.height = "auto"; finp.style.height = Math.min(finp.scrollHeight, 140) + "px"; });
  document.getElementById("fsugg").onclick = e => { const b = e.target.closest(".chip"); if (b) { finp.value = b.textContent; document.getElementById("fcomp").requestSubmit(); } };
  document.getElementById("fcomp").onsubmit = async e => {
    e.preventDefault(); const q = finp.value.trim(); if (!q) return; finp.value = ""; buzz();
    const sg = document.getElementById("fsugg"); if (sg) sg.remove();
    const me = document.createElement("div"); me.className = "msg me"; me.textContent = q; fchat.appendChild(me);
    const ai = document.createElement("div"); ai.className = "msg ai"; fchat.appendChild(ai); const w = waiter(ai);
    ai.scrollIntoView({ block: "end", behavior: "smooth" });
    msgs.push({ role: "user", text: q });
    try { w.status("read"); const d = await getDoc(); const a = await Study.ask(d, null, txt => w.text(txt), msgs.slice(-12), (kk, m) => w.status(kk, m)); msgs.push({ role: "assistant", text: a }); enhance(ai); }
    catch (err) { w.stop(); msgs.pop(); ai.innerHTML = `<span style="color:var(--red)">${esc(err.code === "fetch" ? "ارفع الملف فوق أول 👆" : err.message)}</span>`; }
  };
};

const TEXT_TOOLS = ["zero", "summary", "explain", "sim", "diagram"];
const PREFETCH = ["mindmap", "cards", "quiz"]; // made quietly in the background after the summary

/* ---------- rich renderers: diagrams, simulations, mind maps, video lessons ---------- */
let mermaidP = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  return mermaidP || (mermaidP = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    sc.onload = () => { const dark = !!window.__dark; window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "IBM Plex Sans Arabic", suppressErrorRendering: true }); res(window.mermaid); };
    sc.onerror = () => rej(new Error("mermaid")); document.head.appendChild(sc); }));
}
// AI-written diagrams often have small mistakes (Arabic labels, brackets inside text) — quote labels so they parse
function fixMermaid(code) {
  let c = code.trim().replace(/^```\w*|```$/g, "").trim();
  if (!/^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|mindmap|timeline|pie|gantt)/m.test(c)) c = "flowchart TD\n" + c;
  c = c.replace(/;\s*/g, "\n");
  // A[some (text)] → A["some (text)"]  — also [[ ]], { }, (( )), ( )
  const q = t => '"' + t.trim().replace(/"/g, "'") + '"';
  const ID = "([\\w\\u0600-\\u06FF]+)";
  c = c.replace(new RegExp(ID + "\\[\\[(?!\")([^\\]\\n]+)\\]\\]", "g"), (m, id, t) => `${id}[[${q(t)}]]`)
       .replace(new RegExp(ID + "\\[(?![\"\\[])([^\\]\\n]+)\\]", "g"), (m, id, t) => `${id}[${q(t)}]`)
       .replace(new RegExp(ID + "\\{(?!\")([^}\\n]+)\\}", "g"), (m, id, t) => `${id}{${q(t)}}`)
       .replace(new RegExp(ID + "\\(\\((?!\")([^\\n]+?)\\)\\)", "g"), (m, id, t) => `${id}((${q(t)}))`)
       .replace(new RegExp(ID + "\\((?![\"(])([^()\\n]+)\\)", "g"), (m, id, t) => `${id}(${q(t)})`);
  // edge labels: -->|text| stay, but strip quotes problems
  return c;
}
let mmId = 0, mmQueue = Promise.resolve();
// mermaid can only draw one diagram at a time, so queue them
function drawMermaid(target, code) { const p = mmQueue.then(() => drawMermaid1(target, code)); mmQueue = p.catch(() => {}); return p; }
async function drawMermaid1(target, code) {
  const cleanup = () => document.querySelectorAll('body > [id^="dmm"], body > svg[id^="mm"], body > div[id^="dmm"]').forEach(n => n.remove());
  try {
    const m = await loadMermaid();
    let src = code.trim();
    let ok = await m.parse(src, { suppressErrors: true });
    if (!ok) { src = fixMermaid(src); ok = await m.parse(src, { suppressErrors: true }); }
    if (!ok) { cleanup(); target.remove(); return; }
    const { svg } = await m.render("mm" + (++mmId), src);
    cleanup();
    target.innerHTML = svg; target.classList.add("diagram");
    target.onclick = () => sheet(`<div class="diagram big">${svg}</div>`);
  } catch { cleanup(); target.remove(); }
}
function enhance(el) {
  el.querySelectorAll("pre.lang-mermaid").forEach(pre => { const d = document.createElement("div"); pre.replaceWith(d); drawMermaid(d, pre.textContent); });
  el.querySelectorAll("pre.lang-html").forEach(pre => { const code = pre.textContent; const d = document.createElement("div"); pre.replaceWith(d); renderSim(d, "```html\n" + code + "```"); });
}
function renderSim(el, txt) {
  const m = String(txt).match(/```html\s*([\s\S]*?)(```|$)/i); const code = m ? m[1] : String(txt);
  if (!/<(html|body|div|script)/i.test(code)) { el.innerHTML = `<div class="err">ما طلعت المحاكاة صح، اكبس «جديد» تحت.</div>`; return; }
  el.innerHTML = `<div class="simwrap"><div class="simbar"><span>🎮 محاكاة تفاعلية</span><button class="link" data-full>⛶ كبّر</button></div><iframe class="sim" sandbox="allow-scripts" title="محاكاة"></iframe></div>`;
  const fr = el.querySelector("iframe"); fr.srcdoc = code;
  el.querySelector("[data-full]").onclick = () => { const w = el.querySelector(".simwrap"); w.classList.toggle("full"); };
}
function renderMindmap(el, tree) {
  const node = (n, depth) => {
    const kids = (n.children || []);
    return `<li class="mm-n d${depth}${depth < 1 ? " open" : ""}">
      <button class="mm-b" ${kids.length ? "data-k" : ""}>${n.emoji ? `<span class="mm-e">${esc(n.emoji)}</span>` : ""}<span class="mm-t" dir="auto">${esc(n.title)}</span>${kids.length ? `<span class="mm-c">${kids.length}</span>` : ""}</button>
      ${n.note ? `<div class="mm-note" dir="auto">${esc(n.note)}</div>` : ""}
      ${kids.length ? `<ul>${kids.map(c => node(c, depth + 1)).join("")}</ul>` : ""}</li>`;
  };
  el.innerHTML = `<div class="card mm"><div class="mm-head"><b dir="auto">🌳 ${esc(tree.title || "خريطة المادة")}</b><button class="link" data-all>افتح الكل</button></div>
    <ul class="mm-root">${(tree.children || []).map((c, i) => node({ ...c, title: `${i + 1}. ${c.title}` }, 0)).join("")}</ul>
    <p class="small muted" style="margin:10px 0 0">ادرس بالترتيب من فوق لتحت. اكبس على أي فرع عشان تفتحه.</p></div>`;
  el.onclick = e => {
    const b = e.target.closest(".mm-b"); if (b) { b.parentElement.classList.toggle("open"); buzz(); return; }
    if (e.target.closest("[data-all]")) { const all = el.querySelectorAll(".mm-n"); const open = [...all].some(n => !n.classList.contains("open")); all.forEach(n => n.classList.toggle("open", open)); }
  };
}
function renderVideo(el, v) {
  const scenes = v.scenes || []; if (!scenes.length) { el.innerHTML = `<div class="err">ما طلع الدرس، جرّب «جديد».</div>`; return; }
  const themes = [["#0f766e", "#134e4a"], ["#4338ca", "#1e1b4b"], ["#b45309", "#451a03"], ["#be185d", "#4a044e"], ["#0369a1", "#082f49"], ["#15803d", "#052e16"], ["#7c3aed", "#2e1065"]];
  let i = 0, playing = false, timer = null, started = false;
  const synth = window.speechSynthesis;
  const arVoice = () => (synth ? synth.getVoices() : []).find(x => /^ar/i.test(x.lang)) || null;
  el.innerHTML = `<div class="vplayer" id="vpl">
      <div class="vstage" id="vs"></div>
      <div class="vsub" id="vsub" dir="auto"></div>
      <button class="vbig" id="vbig">▶</button>
      <div class="vhud">
        <div class="vsegs" id="vsegs">${scenes.map((_, k) => `<button data-k="${k}"><i></i></button>`).join("")}</div>
        <div class="vrow"><button class="vbtn" id="vplay">▶</button><button class="vbtn" id="vprev">⏮</button><button class="vbtn" id="vnext">⏭</button>
          <span class="vtitle" dir="auto">${esc(v.title || "")}</span><span class="vcount" id="vc"></span><button class="vbtn" id="vfs">⛶</button></div>
      </div></div>`;
  const P = el.querySelector("#vpl"), vs = el.querySelector("#vs"), sub = el.querySelector("#vsub"), big = el.querySelector("#vbig"), playBtn = el.querySelector("#vplay");
  const segs = [...el.querySelectorAll("#vsegs i")];
  let segT0 = 0, segDur = 1, raf = null;
  const tick = () => { if (!playing) return; const p = Math.min(1, (Date.now() - segT0) / segDur); segs.forEach((g, k) => g.style.width = k < i ? "100%" : k === i ? (p * 100) + "%" : "0%"); raf = requestAnimationFrame(tick); };
  const stopAll = () => { try { synth && synth.cancel(); } catch {} window.stopAiSpeech && stopAiSpeech(); clearTimeout(timer); cancelAnimationFrame(raf); };
  const draw = () => {
    const sc = scenes[i], th = themes[i % themes.length];
    P.style.setProperty("--c1", th[0]); P.style.setProperty("--c2", th[1]);
    vs.innerHTML = `<div class="vscene">
      <div class="vblob b1"></div><div class="vblob b2"></div>
      <div class="vemoji">${esc(sc.emoji || "🎯")}</div>
      <h3 dir="auto">${esc(sc.title || "")}</h3>
      <div class="vpoints">${(sc.points || []).map((p, k) => `<div class="vpt" dir="auto" data-k="${k}"><span>${k + 1}</span>${esc(p)}</div>`).join("")}</div>
      ${sc.diagram ? `<div class="vdiag"></div>` : ""}</div>`;
    if (sc.diagram) drawMermaid(vs.querySelector(".vdiag"), sc.diagram);
    el.querySelector("#vc").textContent = `${i + 1}/${scenes.length}`;
    segs.forEach((g, k) => g.style.width = k < i ? "100%" : "0%");
    sub.textContent = "";
  };
  // reveal the on-screen points one by one while the narrator talks
  const reveal = (dur) => { const pts = [...vs.querySelectorAll(".vpt")]; pts.forEach((p, k) => setTimeout(() => p.classList.add("on"), 300 + (dur * 0.8) * (k / Math.max(pts.length, 1)))); };
  const play = () => {
    stopAll(); if (!playing) return;
    const sc = scenes[i], text = (sc.say || sc.title || "").trim();
    const est = Math.max(4000, text.split(/\s+/).length * 430);
    segT0 = Date.now(); segDur = est; tick(); reveal(est);
    const next = () => { if (!playing) return; if (i < scenes.length - 1) { i++; draw(); play(); } else { playing = false; playBtn.textContent = "↺"; big.textContent = "↺"; P.classList.remove("playing"); segs.forEach(g => g.style.width = "100%"); } };
    // subtitles: show the narration, highlight word by word when the voice reports it
    const words = text.split(/\s+/);
    sub.innerHTML = words.map((w, k) => `<span data-w="${k}">${esc(w)}</span>`).join(" ");
    const myI = i;
    if (window.playAiSpeech) {
      if (scenes[i + 1]) aiSpeech((scenes[i + 1].say || scenes[i + 1].title || "").trim(), "Orus");
      playAiSpeech(text, "Orus", () => !playing || i !== myI).then(ok => {
        if (ok) { sub.querySelectorAll("span").forEach(sp => sp.classList.add("on")); if (playing && i === myI) timer = setTimeout(next, 500); }
        else if (playing && i === myI) browserVoice();
      });
      return;
    }
    browserVoice();
    function browserVoice() {
    const v = arVoice();
    if (synth && v) {
      const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = 1.05;
      let charIdx = 0; const starts = []; words.forEach(w => { starts.push(charIdx); charIdx += w.length + 1; });
      u.onboundary = e => { const k = starts.findIndex((st, j) => e.charIndex >= st && (j === starts.length - 1 || e.charIndex < starts[j + 1])); sub.querySelectorAll("span").forEach((sp, j) => sp.classList.toggle("on", j <= k)); };
      u.onstart = () => { segT0 = Date.now(); };
      u.onend = () => { timer = setTimeout(next, 600); }; u.onerror = () => { timer = setTimeout(next, est); };
      synth.speak(u);
    } else {
      words.forEach((_, k) => setTimeout(() => { const sp = sub.querySelector(`[data-w="${k}"]`); sp && sp.classList.add("on"); }, (est * 0.9) * (k / words.length)));
      timer = setTimeout(next, est);
    }
    }
  };
  const toggle = () => {
    buzz();
    if (playBtn.textContent === "↺") { i = 0; draw(); }
    playing = !playing; started = true;
    playBtn.textContent = playing ? "⏸" : "▶"; big.textContent = playing ? "" : "▶"; P.classList.toggle("playing", playing);
    playing ? play() : stopAll();
  };
  big.onclick = toggle; playBtn.onclick = toggle; vs.onclick = () => started && toggle();
  el.querySelector("#vnext").onclick = () => { if (i < scenes.length - 1) { i++; draw(); if (playing) play(); } };
  el.querySelector("#vprev").onclick = () => { if (i > 0) { i--; draw(); if (playing) play(); } };
  el.querySelector("#vsegs").onclick = e => { const b = e.target.closest("button"); if (!b) return; i = +b.dataset.k; draw(); if (playing) play(); };
  el.querySelector("#vfs").onclick = () => { try { document.fullscreenElement ? document.exitFullscreen() : (P.requestFullscreen ? P.requestFullscreen() : P.classList.toggle("fake-fs")); } catch { P.classList.toggle("fake-fs"); } };
  window.addEventListener("hashchange", stopAll, { once: true });
  if (synth) synth.getVoices();
  draw();
  // show the first scene's points so it doesn't look empty before you press play
  vs.querySelectorAll(".vpt").forEach(p => p.classList.add("on"));
  setTimeout(() => P.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
}

function renderPodcast(el, p) {
  const lines = p.lines || []; if (!lines.length) { el.innerHTML = `<div class="err">ما طلعت الحلقة، جرّب «جديد».</div>`; return; }
  const synth = window.speechSynthesis;
  const voices = () => (synth ? synth.getVoices() : []).filter(v => /^ar/i.test(v.lang));
  const hosts = [...new Set(lines.map(l => l.who))];
  let i = 0, playing = false, timer = null;
  el.innerHTML = `<div class="pod"><div class="pod-head"><div class="pod-art">🎧</div><div><div class="small" style="opacity:.7">بودكاست واجباتي</div><b dir="auto">${esc(p.title || "")}</b><div class="small" style="opacity:.7">${hosts.map(esc).join(" و")} · ${lines.length} مقطع</div></div></div>
    <div class="wave" id="wave">${Array.from({ length: 28 }, (_, k) => `<i style="animation-delay:${(k % 7) * 0.12}s"></i>`).join("")}</div>
    <div class="vctrl"><button class="iconbtn" id="pprev">⏮</button><button class="iconbtn send big" id="pplay">▶</button><button class="iconbtn" id="pnext">⏭</button></div>
    <div class="pod-lines" id="pl">${lines.map((l, k) => `<div class="pl ${hosts.indexOf(l.who) ? "b" : "a"}" data-k="${k}"><b>${esc(l.who)}</b><span dir="auto">${esc(l.text)}</span></div>`).join("")}</div></div>`;
  const wave = el.querySelector("#wave"), btn = el.querySelector("#pplay");
  const mark = () => { el.querySelectorAll(".pl").forEach((d, k) => d.classList.toggle("on", k === i)); const cur = el.querySelector(".pl.on"); if (cur && playing) cur.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const stop = () => { try { synth && synth.cancel(); } catch {} window.stopAiSpeech && stopAiSpeech(); clearTimeout(timer); wave.classList.remove("live"); };
  const aiVoice = k => (/سارة|ة$|ى$/.test(lines[k].who) ? "Aoede" : "Orus");
  const say = async () => {
    stop(); if (!playing) return; mark(); wave.classList.add("live");
    const l = lines[i], vs = voices(), h = hosts.indexOf(l.who), myI = i;
    const next = () => { if (!playing) return; if (i < lines.length - 1) { i++; say(); } else { playing = false; btn.textContent = "↺"; wave.classList.remove("live"); } };
    if (window.playAiSpeech) {
      if (lines[i + 1]) aiSpeech(lines[i + 1].text, aiVoice(i + 1)); // get the next line ready
      const ok = await playAiSpeech(l.text, aiVoice(i), () => !playing || i !== myI);
      if (ok) { if (playing && i === myI) timer = setTimeout(next, 150); return; }
      if (!playing || i !== myI) return;
    }
    if (synth && vs.length) {
      const u = new SpeechSynthesisUtterance(l.text); u.voice = vs[h % vs.length]; u.lang = u.voice.lang;
      u.pitch = vs.length > 1 ? 1 : (h ? 0.8 : 1.25); u.rate = 1.07;
      u.onend = () => { timer = setTimeout(next, 250); }; u.onerror = () => { timer = setTimeout(next, Math.max(2500, l.text.length * 65)); };
      synth.speak(u);
    } else timer = setTimeout(next, Math.max(2500, l.text.length * 65));
  };
  btn.onclick = () => { buzz(); if (btn.textContent === "↺") { i = 0; } playing = !playing; btn.textContent = playing ? "⏸" : "▶"; playing ? say() : stop(); };
  el.querySelector("#pnext").onclick = () => { if (i < lines.length - 1) { i++; mark(); if (playing) say(); } };
  el.querySelector("#pprev").onclick = () => { if (i > 0) { i--; mark(); if (playing) say(); } };
  el.querySelector("#pl").onclick = e => { const d = e.target.closest(".pl"); if (!d) return; i = +d.dataset.k; playing = true; btn.textContent = "⏸"; say(); };
  window.addEventListener("hashchange", stop, { once: true });
  if (synth) synth.getVoices();
  mark();
}

function sheet(html) {
  const el = document.createElement("div"); el.className = "sheet-wrap";
  el.innerHTML = `<div class="sheet"><div class="grab"></div>${html}<button class="btn block" style="margin-top:14px" data-close>سكّر</button></div>`;
  el.onclick = e => { if (e.target === el || e.target.hasAttribute("data-close")) { el.classList.add("out"); setTimeout(() => el.remove(), 200); } };
  document.body.appendChild(el);
}
function confetti() {
  const c = document.createElement("div"); c.className = "confetti";
  const colors = ["#6fcf97", "#f2b45c", "#ff8a80", "#7fb3ff", "#c39bff"];
  c.innerHTML = Array.from({ length: 70 }, (_, i) => `<i style="left:${Math.random() * 100}%;background:${colors[i % 5]};animation-delay:${Math.random() * .4}s;animation-duration:${1.6 + Math.random()}s;transform:rotate(${Math.random() * 360}deg)"></i>`).join("");
  document.body.appendChild(c); setTimeout(() => c.remove(), 3200);
}
window.buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch {} };

function renderCards(el, cards, src) {
  if (!cards.length) { el.innerHTML = `<div class="err">ما طلعت بطاقات، جرّب مرة ثانية.</div>`; return; }
  let i = 0, known = 0;
  const draw = () => {
    if (i >= cards.length) { el.innerHTML = `<div class="card" style="text-align:center"><div style="font-size:40px">🎉</div><b>خلصت البطاقات</b><p class="muted">عرفت ${known} من ${cards.length}</p><button class="btn primary" id="again">أعيدهم</button></div>`; document.getElementById("again").onclick = () => { i = 0; known = 0; draw(); }; return; }
    const c = cards[i];
    el.innerHTML = `<div class="flash" id="flash"><div class="flash-in"><div class="face front" dir="auto"><span class="small muted">سؤال ${i + 1} من ${cards.length}</span><div>${esc(c.q)}</div><span class="small muted">اكبس عشان تشوف الجواب</span></div>
      <div class="face back" dir="auto"><span class="small muted">الجواب</span><div>${esc(c.a)}</div></div></div></div>
      <div class="btns" style="justify-content:center"><button class="btn" id="no">🔁 لسا</button><button class="btn primary" id="yes">✓ عرفتها</button></div>
      <div class="progress"><div style="width:${(i / cards.length) * 100}%"></div></div>`;
    document.getElementById("flash").onclick = e => e.currentTarget.classList.toggle("flipped");
    document.getElementById("yes").onclick = () => { srsGrade(c.q, c.a, true, c.src || src); known++; i++; buzz(); draw(); };
    document.getElementById("no").onclick = () => { srsGrade(c.q, c.a, false, c.src || src); cards.push(cards[i]); i++; buzz(); draw(); };
  };
  draw();
}

function renderQuiz(el, qs, src, opts = {}) {
  if (!qs.length) { el.innerHTML = `<div class="err">ما طلعت أسئلة، جرّب مرة ثانية.</div>`; return; }
  let i = 0, score = 0;
  const draw = () => {
    if (i >= qs.length) {
      const pct = Math.round(score / qs.length * 100);
      if (pct >= 80) confetti();
      el.innerHTML = `<div class="card" style="text-align:center"><div style="font-size:40px">${pct >= 80 ? "🏆" : pct >= 50 ? "👍" : "📚"}</div><b>علامتك ${score} من ${qs.length}</b><p class="muted">${pct >= 80 ? "ممتاز، إنت جاهز!" : pct >= 50 ? "منيح، راجع الأسئلة اللي غلطت فيها." : "بدها مراجعة، جرّب الملخص أو البطاقات."}</p><button class="btn primary" id="again">أعيد الكويز</button></div>`;
      document.getElementById("again").onclick = () => { i = 0; score = 0; draw(); };
      const finalScore = score;
      if (window.makeChallenge && src !== "تحدّي") { const b = document.createElement("button"); b.className = "btn"; b.style.marginInlineStart = "8px"; b.textContent = "⚔️ تحدّى صاحبك"; b.onclick = () => makeChallenge(qs, finalScore, opts.title || src); document.getElementById("again").after(b); }
      opts.onDone && opts.onDone(finalScore); return;
    }
    const q = qs[i];
    el.innerHTML = `<div class="card"><div class="small muted">سؤال ${i + 1} من ${qs.length}</div><div class="qtext" dir="auto">${esc(q.q)}</div>
      <div class="opts">${q.options.map((o, j) => `<button class="opt" data-j="${j}" dir="auto">${esc(o)}</button>`).join("")}</div><div id="why"></div>
      <div class="progress"><div style="width:${(i / qs.length) * 100}%"></div></div></div>`;
    el.querySelector(".opts").onclick = e => {
      const b = e.target.closest(".opt"); if (!b || el.querySelector(".opt.right")) return;
      const j = +b.dataset.j, ok = j === +q.answer; if (ok) score++; try { navigator.vibrate && navigator.vibrate(ok ? 15 : [30, 40, 30]); } catch {}
      el.querySelectorAll(".opt").forEach((x, n) => { x.disabled = true; if (n === +q.answer) x.classList.add("right"); });
      if (!ok) { b.classList.add("wrong"); addWeak(q.q, src); srsAdd([{ q: q.q, a: `${q.options[+q.answer]} — ${q.why || ""}` }], src); }
      document.getElementById("why").innerHTML = `<div class="${ok ? "goodnote" : "note"}" dir="auto">${ok ? "✓ صح! " : "✗ "}${esc(q.why || "")}</div><button class="btn primary block" id="next">${i + 1 < qs.length ? "السؤال الجاي" : "شوف علامتك"}</button>`;
      document.getElementById("next").onclick = () => { i++; draw(); };
    };
  };
  draw();
}

window.openMoodle = async (path) => {
  const url = path.startsWith("http") ? path : Moodle.SITE + path;
  const w = window.open("about:blank", "_blank");
  const target = await Moodle.autologinUrl(url);
  if (w) w.location = target; else location.href = target;
};

routes.assign = async (id) => {
  await ensureData();
  const a = data.items.find(i => i.kind === "assign" && i.id == id);
  if (!a) { $app.innerHTML = `<div class="page"><div class="empty">ما لقيت الواجب</div></div>`; return; }
  $app.innerHTML = `<div class="page"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>${skel(3)}</div>`;
  let st;
  try { st = await Moodle.submissionStatus(a.id); } catch (e) { st = null; }
  if (st && st.status === "submitted") { a.submitted = true; }
  const types = a.configs.filter(c => c.subtype === "assignsubmission" && c.name === "enabled" && c.value === "1").map(c => c.plugin);
  const allowText = types.includes("onlinetext"), allowFiles = types.includes("file");
  const statusLabel = !st ? "—" : st.status === "submitted" ? "✓ مسلّم" : st.status === "draft" ? "مسودة (مش مسلّم)" : "لسا ما سلّمت";
  const s = a.due - now();
  $app.innerHTML = `<div class="page">
    <div class="top"><button class="back" onclick="history.back()">→ رجوع</button><span class="pill ${a.submitted ? "ok" : urgency(a.due)}">${a.submitted ? "✓ مسلّم" : a.due ? (s < 0 ? "انتهى" : "باقي " + left(s)) : "بدون موعد"}</span></div>
    <div class="small muted">${esc(a.coursename)}</div>
    <h1 style="margin:0 0 12px;font-size:21px" dir="auto">${esc(a.name)}</h1>
    <div class="card status">
      <div><span class="muted">موعد التسليم</span><b>${a.due ? fmtDate.format(new Date(a.due * 1000)) : "—"}</b></div>
      ${a.cutoff && a.cutoff !== a.due ? `<div><span class="muted">آخر موعد نهائي</span><b>${fmtDate.format(new Date(a.cutoff * 1000))}</b></div>` : ""}
      <div><span class="muted">حالة التسليم</span><b>${statusLabel}</b></div>
      ${st && st.grade ? `<div><span class="muted">العلامة</span><b>${esc(st.grade.replace(/<[^>]+>/g, ""))}</b></div>` : ""}
    </div>
    ${a.intro ? `<h2>الوصف</h2><div class="card intro" dir="auto">${Moodle.rewriteHtml(a.intro)}</div>` : ""}
    ${a.attachments.length ? `<h2>ملفات مرفقة</h2><div class="card files">${a.attachments.map(f => `<a href="${esc(Moodle.fileUrl(f.url))}" target="_blank" rel="noopener">📎 ${esc(f.name)}</a>`).join("")}</div>` : ""}
    ${st && (st.files.length || st.text) ? `<h2>اللي سلّمته</h2><div class="card files">
        ${st.files.map(f => `<a href="${esc(Moodle.fileUrl(f.url))}" target="_blank" rel="noopener">📄 ${esc(f.name)}</a>`).join("")}
        ${st.text ? `<div class="intro" dir="auto">${Moodle.rewriteHtml(st.text)}</div>` : ""}</div>` : ""}
    ${st && st.canedit && (allowText || allowFiles) ? `<h2>${st.status === "new" ? "سلّم الواجب" : "عدّل التسليم"}</h2>
      <div class="card">
        <div id="serr"></div>
        ${allowText ? `<div class="field"><label>الإجابة (نص)</label><textarea class="input" id="stext" rows="6" dir="auto"></textarea></div>` : ""}
        ${allowFiles ? `<div class="field"><label>الملفات</label><label class="filepick"><input type="file" id="sfiles" multiple hidden><span id="sfname">📎 اختار ملف أو أكثر</span></label>
          <div class="hint">${st.files.length ? "الملفات الجديدة رح تستبدل اللي سلّمته قبل." : "PDF أو Word أو صور…"}</div></div>` : ""}
        <button class="btn primary block" id="sbtn">${a.drafts ? "احفظ وسلّم" : "سلّم"}</button>
        <p class="small muted" style="margin:10px 0 0">بالتسليم إنت بتأكد إنه هاد شغلك الخاص.</p>
      </div>` : ""}
    <div class="btns">
      <button class="btn" onclick="openMoodle('/mod/assign/view.php?id=${a.cmid}')">افتح بالإي ليرنينج ↗</button>
      <button class="btn" onclick="askAI(${a.id})">✨ اسأل المساعد عنه</button>
      ${!a.submitted ? `<button class="btn" onclick="toggleDone('assign:${a.id}')">${doneSet().has("assign:" + a.id) ? "رجّعه مش مخلّص" : "✓ علّمه مخلّص"}</button>` : ""}
    </div>
  </div>`;
  const sfi = document.getElementById("sfiles");
  if (sfi) sfi.onchange = () => { const n = [...sfi.files].map(f => f.name); document.getElementById("sfname").textContent = n.length ? "📄 " + n.join("، ") : "📎 اختار ملف أو أكثر"; };
  const sbtn = document.getElementById("sbtn");
  if (st && st.text && document.getElementById("stext")) document.getElementById("stext").value = st.text.replace(/<br\s*\/?>/g, "\n").replace(/<\/p>\s*<p>/g, "\n\n").replace(/<[^>]+>/g, "");
  if (sbtn) sbtn.onclick = async () => {
    const textEl = document.getElementById("stext"), filesEl = document.getElementById("sfiles");
    const text = textEl ? textEl.value.trim() : null, files = filesEl ? [...filesEl.files] : [];
    if (!text && !files.length) { toast("اكتب إجابة أو اختار ملف"); return; }
    sbtn.disabled = true; sbtn.textContent = "بسلّم…";
    try {
      await Moodle.saveSubmission(a.id, { text: textEl ? esc(text).replace(/\n/g, "<br>") : undefined, files });
      if (a.drafts) await Moodle.submitForGrading(a.id);
      toast("تم التسليم ✓");
      routes.assign(id);
    } catch (e) {
      const corsy = /fetch|network|load failed/i.test(e.message);
      document.getElementById("serr").innerHTML = `<div class="err">${corsy ? "موقع الجامعة ما سمح برفع الملف من التطبيق. سلّمه من زر «افتح بالإي ليرنينج» تحت." : esc(e.message)}</div>`;
      sbtn.disabled = false; sbtn.textContent = "جرّب مرة ثانية";
    }
  };
};

window.toggleDone = (key) => { const d = doneSet(); d.has(key) ? d.delete(key) : d.add(key); S.set("done", [...d]); route(); };

routes.quiz = async (id) => {
  await ensureData();
  const q = data.items.find(i => i.kind === "quiz" && i.id == id);
  if (!q) { $app.innerHTML = `<div class="page"><div class="empty">ما لقيت الكويز</div></div>`; return; }
  let attempts = [], access = null;
  try { attempts = (await Moodle.call("mod_quiz_get_user_attempts", { quizid: q.id, status: "all" })).attempts || []; } catch {}
  try { access = await Moodle.call("mod_quiz_get_quiz_access_information", { quizid: q.id }); } catch {}
  let best = null; try { best = await Moodle.call("mod_quiz_get_user_best_grade", { quizid: q.id }); } catch {}
  const t = now(), opened = !q.open || q.open <= t, closed = q.due && q.due < t;
  const finished = attempts.filter(a => a.state === "finished").length;
  $app.innerHTML = `<div class="page">
    <div class="top"><button class="back" onclick="history.back()">→ رجوع</button><span class="pill ${finished ? "ok" : urgency(q.due)}">${finished ? "✓ حليته" : closed ? "سكّر" : !opened ? "لسا ما فتح" : q.due ? "باقي " + left(q.due - t) : "مفتوح"}</span></div>
    <div class="small muted">${esc(q.coursename)}</div>
    <h1 style="margin:0 0 12px;font-size:21px" dir="auto">${esc(q.name)}</h1>
    <div class="card status">
      <div><span class="muted">بفتح</span><b>${q.open ? fmtDate.format(new Date(q.open * 1000)) : "—"}</b></div>
      <div><span class="muted">بسكّر</span><b>${q.due ? fmtDate.format(new Date(q.due * 1000)) : "—"}</b></div>
      <div><span class="muted">المدة</span><b>${q.timelimit ? Math.round(q.timelimit / 60) + " دقيقة" : "مفتوحة"}</b></div>
      <div><span class="muted">المحاولات</span><b>${finished} من ${q.attempts || "∞"}</b></div>
      ${best && best.hasgrade ? `<div><span class="muted">أعلى علامة</span><b>${esc(String(best.grade))}</b></div>` : ""}
    </div>
    ${q.intro ? `<h2>التعليمات</h2><div class="card intro" dir="auto">${Moodle.rewriteHtml(q.intro)}</div>` : ""}
    ${access && access.accessrules && access.accessrules.length ? `<div class="note">${access.accessrules.map(esc).join("<br>")}</div>` : ""}
    <div class="btns">
      ${opened && !closed && (!q.attempts || finished < q.attempts || attempts.some(a => a.state === "inprogress")) ? `<button class="btn primary" onclick="go('qattempt-${q.id}')">${attempts.some(a => a.state === "inprogress") ? "▶ كمّل الكويز" : "▶ ابدأ الكويز هون"}</button>` : ""}
      <button class="btn" onclick="openMoodle('/mod/quiz/view.php?id=${q.cmid}')">افتح بالإي ليرنينج ↗</button>
    </div>
    <p class="small muted">بتحل الكويز من جوّا التطبيق، وإجاباتك بتنحفظ على الإي ليرنينج مباشرة. إذا في نوع سؤال ما بيظهر منيح، افتحه بالإي ليرنينج.</p>
  </div>`;
};


/* live "thinking" indicator so you always know it's working */
function waiter(el) {
  const t0 = Date.now(); let label = "بفكّر", model = "", started = false;
  const draw = () => { if (started) return; const sec = Math.floor((Date.now() - t0) / 1000);
    el.innerHTML = `<div class="typing"><span class="dots"><i></i><i></i><i></i></span><span>${label}… <b>${sec}ث</b></span></div>`; };
  draw(); const iv = setInterval(draw, 1000);
  return {
    status(kind, m) {
      if (m) model = m;
      if (kind === "tool") { label = m || "بشتغل"; model = ""; draw(); return; }
      label = kind === "thinking" ? "بفكّر بالجواب" : kind === "slow" ? "لحظة، بسرّعلك الجواب" : kind === "retry" ? "النت ضعيف، بعيد المحاولة" : kind === "read" ? "بقرأ الملف" : kind === "build" ? "ببني المحاكاة" : "بفكّر";
      draw();
    },
    text(t) { if (!started) { started = true; clearInterval(iv); } el.innerHTML = AI.md(t); },
    stop() { started = true; clearInterval(iv); }
  };
}


/* ---------------- assistant tools: it can look things up and open your files by itself ---------------- */
const norm = t => String(t || "").toLowerCase().replace(/[^\w؀-ۿ ]+/g, " ").replace(/\s+/g, " ").trim();
function findCourse(q) {
  if (!data) return null; const n = norm(q);
  return data.courses.find(c => String(c.id) === String(q)) || data.courses.find(c => norm(c.name) === n) ||
    data.courses.find(c => norm(c.name).includes(n) || n.includes(norm(c.name))) ||
    data.courses.map(c => ({ c, score: n.split(" ").filter(w => w.length > 2 && norm(c.name).includes(w)).length })).sort((a, b) => b.score - a.score).filter(x => x.score)[0]?.c || null;
}
function aiTools() {
  return [...(window.featureTools ? featureTools() : []), ...(window.featureTools2 ? featureTools2() : []),
    { name: "get_my_work", description: "Get the student's upcoming and recent assignments and quizzes from the e-learning, with due dates and whether each is already submitted.", label: () => "بشوف واجباتك…",
      execute: async () => { await refresh(); return { now: new Date().toISOString(), items: upcoming().map(i => ({ type: i.kind, name: i.name, course: i.coursename, due: new Date(i.due * 1000).toISOString(), time_left: i.due > now() ? left(i.due - now()) : "passed", done: !!isDone(i) })) }; } },
    { name: "list_courses", description: "List the student's courses this semester.", label: () => "بشوف موادك…",
      execute: async () => { await refresh(); return { courses: data.courses.map(c => ({ id: c.id, name: c.name })) }; } },
    { name: "list_course_files", description: "List the lecture files (slides, PDFs) of a course, numbered in course order (1 = first lecture). Use before opening a file.", label: a => "بشوف ملفات المادة…",
      parameters: { type: "object", properties: { course: { type: "string", description: "Course name (any part, Arabic or English) or id" } }, required: ["course"] },
      execute: async ({ course }) => { await refresh(); const c = findCourse(course); if (!c) return { error: "course not found", courses: data.courses.map(x => x.name) };
        const secs = await Study.courseContents(c.id); let n = 0; return { course: c.name, files: secs.flatMap(sec => sec.files.map(f => ({ number: ++n, section: sec.name, title: f.title, file: f.filename, type: Study.kindOf(f) }))) }; } },
    { name: "open_course_file", description: "Open and read a lecture file from a course so you can teach from it, quiz the student, or answer questions about it.", label: () => "بفتح الملف وبقرأه…",
      parameters: { type: "object", properties: { course: { type: "string" }, file_number: { type: "integer", description: "Number from list_course_files" } }, required: ["course", "file_number"] },
      execute: async ({ course, file_number }) => { await refresh(); const c = findCourse(course); if (!c) return { error: "course not found" };
        const secs = await Study.courseContents(c.id); const all = secs.flatMap(sec => sec.files); const f = all[(+file_number || 1) - 1]; if (!f) return { error: "no such file", count: all.length };
        if (!Study.studyable(Study.kindOf(f))) return { error: "this file type can't be read", title: f.title };
        let d; try { d = await Study.load(f); } catch (e) { return { error: e.code === "fetch" ? "the university site blocked downloading this file; ask the student to open it from the course page and upload it" : e.message }; }
        if (d.kind === "pdf") return { title: f.title, note: "The PDF is attached right after this message.", attach: [{ mime: "application/pdf", data: d.data }] };
        if (d.kind === "image") return { title: f.title, attach: [{ mime: d.mime, data: d.data }] };
        return { title: f.title, content: d.data.slice(0, 60000) }; } },
    { name: "get_assignment", description: "Get full details of one assignment or quiz (description/questions, due date, submission status) by name.", label: () => "بفتح تفاصيل الواجب…",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      execute: async ({ name }) => { await refresh(); const n = norm(name); const it = data.items.find(i => norm(i.name) === n) || data.items.find(i => norm(i.name).includes(n) || n.includes(norm(i.name))); if (!it) return { error: "not found" };
        const tmp = document.createElement("div"); tmp.innerHTML = it.intro || "";
        return { type: it.kind, name: it.name, course: it.coursename, due: it.due ? new Date(it.due * 1000).toISOString() : null, done: !!isDone(it), description: tmp.textContent.trim().slice(0, 6000) }; } },
    { name: "my_progress", description: "The student's learning memory: topics they got wrong in practice quizzes and how many review cards are due.", label: () => "بشوف تقدّمك…",
      execute: async () => ({ weak_topics: S.get("weak", []).slice(-15), review_cards_due: srsDue().length, review_cards_total: srsAll().length }) },
    { name: "add_review_cards", description: "Save flashcards into the student's spaced-repetition review deck (use after teaching something important or when asked).", label: () => "بحفظلك بطاقات مراجعة…",
      parameters: { type: "object", properties: { cards: { type: "array", items: { type: "object", properties: { q: { type: "string" }, a: { type: "string" } }, required: ["q", "a"] } }, topic: { type: "string" } }, required: ["cards"] },
      execute: async ({ cards, topic }) => { srsAdd(cards || [], topic || "المساعد"); return { saved: (cards || []).length }; } }
  ];
}

/* ---------------- AI ---------------- */
let chatMsgs = S.get("ai.chat", []); // [{role,text,images:[{mime,data,preview}]}]
let pendingImgs = [];
let aiBusy = false, aiAbort = null;

function aiContext() {
  const t = now();
  const list = data ? upcoming().filter(i => i.due > t - 7 * 86400).map(i =>
    `- [${i.kind === "quiz" ? "كويز" : "واجب"}] ${i.name} | ${i.coursename} | ${fmtDate.format(new Date(i.due * 1000))} | ${isDone(i) ? "مسلّم/مخلّص" : i.due < t ? "فات موعده" : "باقي " + left(i.due - t)}`
  ).join("\n") : "(ما في بيانات بعد)";
  const courses = data ? data.courses.map(c => c.name).join("، ") : "";
  return `إنت "المساعد" جوّا تطبيق واجباتي، مساعد دراسي ذكي جداً لـ ${Moodle.session?.fullname || "طالب"}، طالب سنة خامسة نظم حاسوبية بجامعة البلقاء التطبيقية بالأردن.
احكي باللهجة الأردنية بشكل طبيعي وواضح، والمصطلحات التقنية والكود بالإنجليزي. خليك مختصر إلا إذا طلب تفصيل.
الوقت هلأ: ${fmtDate.format(new Date())} (توقيت عمّان).
مواده: ${courses}
واجباته وكويزاته من الإي ليرنينج:
${list}

لما يفيد، استخدم رسومات: \`\`\`mermaid للمخططات (وكل نص جوّا الأشكال بين تنصيص مثل A[\"نص\"]) (خطوات، علاقات، هياكل بيانات، خطط دراسة شجرية)، و\`\`\`html لمحاكاة تفاعلية صغيرة (صفحة كاملة بدون مكتبات خارجية، RTL) لما المفهوم بينفهم بالتجربة (Stack, Queue, sorting…).
عندك أدوات: بتقدر تشوف واجباته، وتفتح ملفات أي مادة وتقرأها (list_course_files ثم open_course_file)، وتجيب تفاصيل أي واجب، وتشوف نقاط ضعفه، وتحفظله بطاقات مراجعة، وتقرأ ملاحظاته ومواعيد امتحاناته ووقت دراسته وعلاماته، وتدوّر جوّا ملفاته (search_my_files). استخدمها لحالك أول ما تفيد، بدون ما تسأله "بدك أفتح الملف؟" — افتح وجاوب. إذا قال "محاضرة ٣" أو "أول ملف" افهمها بالترتيب.
${weakSummary() ? "نقاط ضعفه من الكويزات التدريبية (ركّز عليها لما تشرح):\n" + weakSummary() : ""}
بتقدر: ترتّبله الأولويات وتعمل خطط دراسة، تشرح أي مفهوم بأمثلة، تقرأ الصور اللي ببعتها (أسئلة، سلايدات، كود، أخطاء)، تراجع شغله وتعطيه ملاحظات، وتساعده بالبرمجة.
${AI.langRule()}
إنت بتقدر تسمع الرسائل الصوتية (ملفات الصوت المرفقة) وتشوف الصور وتقرأ الملفات. إذا بعتلك فويس، اسمعه وجاوب على محتواه طبيعي، وما تحكي أبداً إنك "نظام نصي" أو "ما بتسمع".
بالواجبات والكويزات اللي عليها علامات: هدفك إنه يفهم ويقدر يحل بنفسه، فاشرح وورجيه الطريقة وأمثلة مشابهة، بدل ما تعطيه نص جاهز ينسخه ويسلّمه.`;
}

window.askAI = (id) => {
  const a = data.items.find(i => i.id == id);
  if (!a) return;
  const tmp = document.createElement("div"); tmp.innerHTML = (a.intro || "").replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n");
  const intro = tmp.textContent.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 3000);
  aiDraft = `ساعدني أفهم هاد الواجب وأبلّش فيه: "${a.name}" (${a.coursename}).\n${intro ? "الوصف: " + intro : ""}`;
  go("ai");
};
let aiDraft = "";

routes.ai = async () => {
  const s = AI.settings();
  const ready = AI.ready();
  $app.innerHTML = `<div class="page chatpage">
    <div class="top"><div><h1>المساعد ✨</h1><div class="sub" id="aimodel">مساعدك الدراسي الذكي · شغّال ٢٤ ساعة</div></div>
      <div style="display:flex;gap:6px">${ready ? `<button class="back callbtn" onclick="startCall()">📞 مكالمة</button>` : ""}${chatMsgs.length ? `<button class="back" onclick="newChat()">جديدة</button>` : ""}</div></div>
    ${!ready ? `<div class="card"><b>لازم تحط مفتاح الـ AI أول مرة</b><p class="small muted" style="margin:6px 0 10px">المفتاح بيتخزّن على تلفونك بس، وما بيروح لأي مكان غير الشركة نفسها.</p><button class="btn primary" onclick="go('settings')">افتح الإعدادات</button></div>` : ""}
    <div class="chat" id="chat"></div>
    ${!chatMsgs.length && ready ? `<div class="sugg" id="sugg">
      <button class="chip">شو أبلّش فيه هلأ؟</button>
      <button class="chip">اعملي خطة دراسة لهالأسبوع</button>
      <button class="chip">درّسني أول محاضرة بأصعب مادة</button>
      <button class="chip" onclick="event.stopPropagation();snapSolve()">📸 صوّر سؤال واتحل</button>
      <button class="chip">📎 ارفعلي ملف أو صورة</button></div>` : ""}
    <form class="composer" id="composer">
      <div class="thumbs" id="thumbs"></div>
      <div class="bar">
        <button type="button" class="iconbtn" id="attach" title="صورة أو ملف">📎</button>
        <input type="file" id="imgin" accept="image/*,.pdf,.pptx,.docx,.txt" multiple hidden>
        <textarea id="inp" rows="1" placeholder="اسأل أي إشي…" dir="auto" ${ready ? "" : "disabled"}></textarea>
        <button type="button" class="iconbtn" id="mic" title="فويس" ${ready ? "" : "disabled"}>🎤</button>
        <button class="iconbtn send" id="send" ${ready ? "" : "disabled"}>↑</button>
      </div>
    </form>
  </div>`;
  const chat = document.getElementById("chat");
  chatMsgs.forEach(m => chat.appendChild(msgEl(m)));
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
  const inp = document.getElementById("inp");
  if (aiDraft) { inp.value = aiDraft; aiDraft = ""; }
  if (window.__autoSend) { window.__autoSend = false; setTimeout(() => sendAI(), 50); }
  const grow = () => { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight, 140) + "px"; };
  inp.addEventListener("input", grow); grow();
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); document.getElementById("composer").requestSubmit(); } });
  document.getElementById("attach").onclick = () => document.getElementById("imgin").click();
  document.getElementById("imgin").onchange = async e => {
    for (const f of e.target.files) {
      try {
        if (/^image\//.test(f.type)) pendingImgs.push(await AI.imageFromFile(f));
        else { const d = await Study.fromLocal(f); pendingImgs.push({ file: true, name: f.name, doc: d }); }
      } catch (err) { toast(err.message, 4000); }
    }
    e.target.value = ""; drawThumbs();
  };
  const sugg = document.getElementById("sugg");
  if (sugg) sugg.onclick = e => { const b = e.target.closest(".chip"); if (!b) return; if (b.textContent.includes("ارفع")) document.getElementById("imgin").click(); else { inp.value = b.textContent; document.getElementById("composer").requestSubmit(); } };
  document.getElementById("composer").onsubmit = e => { e.preventDefault(); sendAI(); };
  document.getElementById("mic").onclick = () => voiceNote();
  drawThumbs();
};
function drawThumbs() {
  const el = document.getElementById("thumbs"); if (!el) return;
  el.innerHTML = pendingImgs.map((im, i) => `<div>${im.file ? `<span class="filechip">📄 ${esc(im.name)}</span>` : `<img src="${im.preview}">`}<button type="button" onclick="pendingImgs.splice(${i},1);drawThumbs()">×</button></div>`).join("");
}
function msgEl(m) {
  const d = document.createElement("div");
  d.className = "msg " + (m.role === "user" ? "me" : "ai");
  if (m.role === "user") { d.innerHTML = m.voice ? `<span class="vnote">🎤 <span class="vbars">${"<i></i>".repeat(14)}</span> ${m.voice.secs}ث</span>` : (m.images || []).map(im => `<img src="data:${im.mime};base64,${im.data}">`).join("") + (m.fileNote || []).map(n => `<span class="filechip">📄 ${esc(n)}</span>`).join("") + esc(m.text); }
  else { d.innerHTML = AI.md(m.text || ""); setTimeout(() => { enhance(d); msgActions(d, m.text || ""); }, 0); }
  return d;
}
// small actions under each answer: copy, listen, share
function msgActions(el, text) {
  if (!text || el.querySelector(".mact")) return;
  const bar = document.createElement("div"); bar.className = "mact";
  bar.innerHTML = `<button title="نسخ">📋</button><button title="اسمع">🔊</button><button title="شارك">↗</button>`;
  const [cp, sp, sh] = bar.querySelectorAll("button");
  cp.onclick = async () => { try { await navigator.clipboard.writeText(text); cp.textContent = "✓"; buzz(); setTimeout(() => cp.textContent = "📋", 1200); } catch {} };
  let speaking = false;
  sp.onclick = async () => {
    if (speaking) { window.stopAiSpeech && stopAiSpeech(); try { speechSynthesis.cancel(); } catch {} speaking = false; sp.textContent = "🔊"; return; }
    speaking = true; sp.textContent = "⏹"; const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>|_]/g, "").slice(0, 1500);
    const ok = window.playAiSpeech ? await playAiSpeech(clean, "Orus", () => !speaking) : false;
    if (!ok && speaking) { await new Promise(res => { try { const u = new SpeechSynthesisUtterance(clean); const v = speechSynthesis.getVoices().find(x => /^ar/i.test(x.lang)); if (v) { u.voice = v; u.lang = v.lang; } u.onend = res; u.onerror = res; speechSynthesis.speak(u); } catch { res(); } }); }
    speaking = false; sp.textContent = "🔊";
  };
  sh.onclick = () => window.shareCard ? shareCard(el, "من المساعد") : null;
  el.appendChild(bar);
}
window.newChat = () => { chatMsgs = []; S.set("ai.chat", []); route(); };
async function sendAI(voice) {
  const inp = document.getElementById("inp");
  const text = voice ? (voice.transcript || "") : inp.value.trim();
  if (aiBusy) { aiAbort && aiAbort.abort(); return; }
  if (!text && !pendingImgs.length && !voice) return;
  const sugg = document.getElementById("sugg"); if (sugg) sugg.remove();
  const files = pendingImgs.filter(x => x.file), pics = pendingImgs.filter(x => !x.file);
  const docs = files.filter(x => x.doc.kind === "pdf").map(x => ({ mime: "application/pdf", data: x.doc.data }));
  const textFiles = files.filter(x => x.doc.kind === "text").map(x => `محتوى الملف "${x.name}":\n<<<\n${x.doc.data}\n>>>\n\n`).join("");
  const imgFiles = files.filter(x => x.doc.kind === "image").map(x => ({ mime: x.doc.mime, data: x.doc.data }));
  const userMsg = { role: "user", text: voice ? (text ? `(رسالة صوتية من الطالب، مرفق الصوت، وهاد نصها: «${text}») جاوب على اللي قاله مباشرة.` : "(رسالة صوتية من الطالب مرفقة كملف صوت) اسمعها وجاوب على اللي قاله مباشرة.") : text || (files.length ? "اقرأ الملف ولخّصلي أهم إشي فيه" : "شو بالصورة؟"),
    voice: voice ? { secs: voice.secs } : null, audio: voice && AI.settings().provider === "gemini" ? [{ mime: "audio/wav", data: voice.data }] : [],
    images: [...pics.map(({ mime, data }) => ({ mime, data })), ...imgFiles], docs, fileNote: files.map(x => x.name), hidden: textFiles };
  pendingImgs = []; drawThumbs(); inp.value = ""; inp.style.height = "auto";
  chatMsgs.push(userMsg);
  const chat = document.getElementById("chat");
  chat.appendChild(msgEl(userMsg));
  const bubble = msgEl({ role: "assistant", text: "" }); chat.appendChild(bubble);
  const w = waiter(bubble);
  window.scrollTo(0, document.body.scrollHeight);
  aiBusy = true; aiAbort = new AbortController();
  const sendBtn = document.getElementById("send"); sendBtn.textContent = "■";
  try {
    // keep last 20 messages; only the last 2 user turns keep their images (saves cost)
    const recent = chatMsgs.slice(-20).map((m, i, arr) => ({ ...m, text: (m.hidden || "") + (m.text || ""), images: i >= arr.length - 4 ? m.images : [], docs: i >= arr.length - 4 ? m.docs : [], audio: i >= arr.length - 2 ? m.audio : [] }));
    if (recent[0] && recent[0].role === "assistant") recent.shift();
    const full = await AI.chat({ system: aiContext(), messages: recent, signal: aiAbort.signal, tools: aiTools(), depth: "smart",

      onStatus: (k, m) => w.status(k, m),
      onText: t => { w.text(t); if (window.innerHeight + window.scrollY > document.body.scrollHeight - 200) window.scrollTo(0, document.body.scrollHeight); } });
    chatMsgs.push({ role: "assistant", text: full }); enhance(bubble); msgActions(bubble, full);
  } catch (e) {
    w.stop();
    if (e.name === "AbortError") { chatMsgs.push({ role: "assistant", text: bubble.textContent || "(وقّفت)" }); }
    else {
      bubble.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span> <button class="link" id="retrybtn">↻ جرّب كمان مرة</button>`;
      const failed = chatMsgs.pop();
      const rb = document.getElementById("retrybtn"); if (rb) rb.onclick = () => { bubble.previousElementSibling && bubble.previousElementSibling.remove(); bubble.remove(); pendingImgs = []; const inp2 = document.getElementById("inp"); if (failed.voice) return; inp2.value = failed.text; sendAI(); };
    }
  }
  // don't store old images forever (storage is small)
  chatMsgs = chatMsgs.slice(-40).map((m, i, arr) => i < arr.length - 6 ? { ...m, images: [], docs: [], hidden: "" } : m);
  try { S.set("ai.chat", chatMsgs.map(m => ({ ...m, docs: [], hidden: "", audio: [] }))); } catch {}
  aiBusy = false; aiAbort = null; if (sendBtn) sendBtn.textContent = "↑";
}


/* ---------------- voice: notes + live call ---------------- */
// record the mic and turn it into a small 16kHz WAV (works everywhere, the AI understands it)
async function recordStart() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try { await ctx.resume(); } catch {}
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = []; let level = 0, peak = 0;
  proc.onaudioprocess = e => { const d = e.inputBuffer.getChannelData(0); chunks.push(new Float32Array(d)); let m = 0; for (let i = 0; i < d.length; i += 64) m = Math.max(m, Math.abs(d[i])); level = m; peak = Math.max(peak, m); };
  src.connect(proc); proc.connect(ctx.destination);
  return {
    get level() { return level; },
    async stop(cancel) {
      proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop());
      const rate = ctx.sampleRate; await ctx.close();
      if (cancel) return null;
      const len = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(len); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      const target = 16000, ratio = rate / target, n = Math.floor(len / ratio), pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) { const v = all[Math.floor(i * ratio)] || 0; pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff; }
      const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
      const w = (p, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(p + i, str.charCodeAt(i)); };
      w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
      new Int16Array(buf, 44).set(pcm);
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(new Blob([buf], { type: "audio/wav" })); });
      return { data: b64, secs: Math.round(n / target), peak };
    }
  };
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const srLang = () => AI.settings().lang === "en" ? "en-US" : "ar-JO";

async function voiceNote() {
  const bar = document.querySelector("#composer .bar"); if (!bar) return;
  let rec; try { rec = await recordStart(); } catch { toast("لازم تسمح للمايك 🎤", 3500); return; }
  buzz();
  // live transcript too (used when the provider can't hear audio)
  let transcript = ""; let sr = null;
  if (SR) { try { sr = new SR(); sr.lang = srLang(); sr.continuous = true; sr.interimResults = true; sr.onresult = e => { transcript = [...e.results].map(r => r[0].transcript).join(" "); }; sr.start(); } catch { sr = null; } }
  const t0 = Date.now();
  const rb = document.createElement("div"); rb.className = "recwrap";
  rb.innerHTML = `<button type="button" class="iconbtn" id="vcancel">✕</button><div class="recbar"><span class="recdot"></span><span id="rect">0:00</span><span class="vbars live" id="rlv">${"<i></i>".repeat(18)}</span></div><button type="button" class="iconbtn send" id="vsend">↑</button>`;
  bar.classList.add("rec"); bar.appendChild(rb);
  const bars = [...rb.querySelectorAll("#rlv i")];
  const iv = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); const el = document.getElementById("rect"); if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    bars.forEach((b, i) => b.style.height = (4 + Math.random() * rec.level * 60 * (0.5 + (i % 3) / 3)) + "px"); }, 120);
  const finish = async (cancel) => {
    clearInterval(iv); try { sr && sr.stop(); } catch {}
    const v = await rec.stop(cancel); rb.remove(); bar.classList.remove("rec");
    if (!v || v.secs < 1) { if (!cancel) toast("الفويس قصير كثير"); return; }
    if (v.peak < 0.01 && !transcript) { toast("ما وصلني صوت 🎤 تأكد إنه المايك شغّال ومش مكتوم", 4000); return; }
    sendAI({ ...v, transcript });
  };
  document.getElementById("vcancel").onclick = () => finish(true);
  document.getElementById("vsend").onclick = () => finish(false);
}

/* live call: talk, it answers out loud, and listens again */
window.startCallBasic = async () => {
  if (!AI.ready()) return;
  buzz();
  const ov = document.createElement("div"); ov.className = "call";
  ov.innerHTML = `<div class="call-top"><div class="small" style="opacity:.7">مكالمة مع</div><b>المساعد ✨</b></div>
    <button class="orb" id="orb"><span></span></button>
    <div class="call-state" id="cst">بتّصل…</div>
    <div class="call-text" id="ctx" dir="auto"></div>
    <div class="call-btns"><button class="cbtn" id="cmute">🎤</button><button class="cbtn end" id="cend">✕</button></div>`;
  document.body.appendChild(ov);
  const orb = ov.querySelector("#orb"), cst = ov.querySelector("#cst"), ctxEl = ov.querySelector("#ctx");
  const synth = window.speechSynthesis; synth && synth.getVoices();
  let alive = true, mode = "idle", sr = null, rec = null, abort = null, muted = false;
  const callMsgs = [];
  const set = (m, label) => { mode = m; ov.dataset.mode = m; cst.textContent = label; };
  const pickVoice = (txt) => { const vs = synth ? synth.getVoices() : []; const latin = (txt.match(/[a-z]/gi) || []).length > txt.length * 0.5;
    return (latin ? vs.find(v => /^en/i.test(v.lang)) : vs.find(v => /^ar/i.test(v.lang))) || vs.find(v => /^ar/i.test(v.lang)) || null; };
  let speakQ = [], speaking = false, streamDone = false;
  const clean = t => t.replace(/```[\s\S]*?```/g, " ").replace(/[*#`>|_]/g, "").replace(/\s+/g, " ").trim();
  const speakNext = () => {
    if (!alive) return;
    if (!speakQ.length) { speaking = false; if (streamDone) listen(); return; }
    speaking = true; const t = speakQ.shift();
    if (!synth) { setTimeout(speakNext, t.length * 60); return; }
    const u = new SpeechSynthesisUtterance(t); const v = pickVoice(t); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "ar";
    u.rate = 1.08; u.onend = speakNext; u.onerror = speakNext; synth.speak(u);
  };
  async function think(text, audio) {
    set("think", "بفكّر…"); buzz();
    callMsgs.push({ role: "user", text: text || "(فويس) اسمع وجاوب", audio: audio ? [audio] : [] });
    chatMsgs.push({ role: "user", text: text || "🎤 (مكالمة)" });
    abort = new AbortController(); speakQ = []; streamDone = false; let said = 0, full = "";
    try {
      full = await AI.chat({ system: aiContext() + "\nهاي مكالمة صوتية مباشرة زي مكالمة تلفون مع صاحب شاطر: احكي باللهجة الأردنية الطبيعية (شو، هلأ، يعني، تمام، ولا يهمك، إشي) مش فصحى، جمل قصيرة ودافية فيها روح، بدون رموز أو قوائم أو كود، 1-3 جمل إلا إذا طلب شرح؛ وإذا شرحت قسّمه واسأله «ماشي لهون؟». المصطلحات التقنية بالإنجليزي. إذا حكى إنجليزي رد إنجليزي.",
        messages: callMsgs.slice(-12).map((m, i, a) => ({ ...m, audio: i === a.length - 1 ? m.audio : [] })), depth: "smart", signal: abort.signal, tools: aiTools(),
        onText: t => {
          if (mode === "think") set("speak", "بحكي…");
          ctxEl.textContent = clean(t);
          // speak sentence by sentence as they arrive, no waiting for the whole answer
          const c = clean(t), rest = c.slice(said), m = rest.match(/^[\s\S]*?[.!؟?،\n](\s|$)/);
          if (m && m[0].trim().length > 2) { said += m[0].length; speakQ.push(m[0].trim()); if (!speaking) speakNext(); }
        } });
      const tail = clean(full).slice(said).trim(); if (tail) speakQ.push(tail);
      callMsgs.push({ role: "assistant", text: full }); chatMsgs.push({ role: "assistant", text: full });
      streamDone = true; if (!speaking) speakNext();
    } catch (e) { if (!alive) return; callMsgs.pop(); chatMsgs.pop(); set("idle", e.name === "AbortError" ? "اتفضل احكي" : "صار خطأ، احكي كمان مرة"); setTimeout(listen, 900); }
  }
  async function listen() {
    if (!alive) return; if (muted) { set("idle", "المايك مسكّر"); return; }
    try { synth && synth.cancel(); } catch {}
    set("listen", "بسمعك… احكي"); ctxEl.textContent = "";
    if (SR) {
      try {
        sr = new SR(); sr.lang = srLang(); sr.interimResults = true; sr.continuous = true;
        let final = "", quiet = null;
        sr.onresult = e => { const t = [...e.results].map(r => r[0].transcript).join(" "); ctxEl.textContent = t; final = t;
          clearTimeout(quiet); quiet = setTimeout(() => { try { sr.stop(); } catch {} }, 1300); };
        sr.onend = () => { clearTimeout(quiet); if (!alive || mode !== "listen") return; if (final.trim()) think(final.trim()); else listen(); };
        sr.onerror = ev => { if (ev.error === "not-allowed") { set("idle", "لازم تسمح للمايك 🎤"); alive && (muted = true); } };
        sr.start(); return;
      } catch {}
    }
    // no live speech recognition here: tap the circle to talk, tap again to send
    set("idle", "اكبس الدائرة وأحكي");
  }
  orb.onclick = async () => {
    buzz();
    if (mode === "speak" || mode === "think") { abort && abort.abort(); speakQ = []; try { synth.cancel(); } catch {} speaking = false; listen(); return; }
    if (!SR) {
      if (!rec) { try { rec = await recordStart(); set("listen", "بسجّل… اكبس لما تخلص"); } catch { set("idle", "لازم تسمح للمايك 🎤"); } }
      else { const v = await rec.stop(); rec = null; if (v && v.secs) think("", { mime: "audio/wav", data: v.data }); else set("idle", "اكبس الدائرة وأحكي"); }
    }
  };
  ov.querySelector("#cmute").onclick = e => { muted = !muted; e.target.textContent = muted ? "🔇" : "🎤"; if (muted) { try { sr && sr.abort(); } catch {} set("idle", "المايك مسكّر"); } else listen(); };
  const end = () => { alive = false; try { sr && sr.abort(); } catch {} try { synth && synth.cancel(); } catch {} abort && abort.abort(); rec && rec.stop(true);
    ov.classList.add("out"); setTimeout(() => ov.remove(), 200); try { S.set("ai.chat", chatMsgs.map(m => ({ ...m, docs: [], hidden: "", audio: [] }))); } catch {} if (location.hash === "#ai") route(); };
  ov.querySelector("#cend").onclick = end;
  window.addEventListener("hashchange", end, { once: true });
  const hello = AI.settings().lang === "en" ? "Hi! What do you want to study today?" : "أهلين! شو بدك ندرس اليوم؟";
  ctxEl.textContent = hello; set("speak", "بحكي…"); speakQ = [hello]; streamDone = true; speakNext();
};

/* ---------------- settings ---------------- */
routes.settings = async () => {
  const s = AI.settings(), sess = Moodle.session;
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  $app.innerHTML = `<div class="page">
    <div class="top"><h1>الإعدادات</h1></div>
    <h2>الحساب</h2>
    <div class="card item" style="cursor:default"><div class="avatar">${sess.picture ? `<img src="${esc(Moodle.fileUrl(sess.picture))}">` : ""}</div>
      <div class="body"><div class="title">${esc(sess.fullname)}</div><div class="due">الإي ليرنينج · جامعة البلقاء</div></div>
      <button class="btn" onclick="if(confirmOut())logout()">خروج</button></div>

    <h2>الإشعارات</h2>
    <div class="card">
      ${perm === "granted" ? "✓ الإشعارات شغّالة" : perm === "denied" ? "الإشعارات مسكّرة من إعدادات المتصفح/التلفون." : perm === "unsupported" ? "على آيفون: أضف التطبيق للشاشة الرئيسية الأول، وبعدين افتحه من الأيقونة وشغّل الإشعارات." : `<button class="btn primary" onclick="askNotif()">شغّل الإشعارات</button>`}
      <p class="small muted" style="margin:8px 0 0">التطبيق بيفحص الإي ليرنينج كل ما تفتحه، وبينبّهك بالواجبات الجديدة وقبل يوم و٣ ساعات من التسليم.</p>
    </div>

    <h2>الذكاء الاصطناعي</h2>
    <div class="card">
      <div id="pgemini">
        <div class="field"><label>مفتاح الذكاء الاصطناعي (API key)</label><input class="input" id="gk" type="password" dir="ltr" placeholder="AIza…" value="${esc(s.geminiKey)}">
          <div class="hint">من <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></div></div>
        <label class="field" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer"><input type="checkbox" id="gauto" ${s.geminiAuto ? "checked" : ""} style="margin-top:5px;width:18px;height:18px">
          <span><b>تبديل تلقائي بين الموديلات</b><span class="hint" style="display:block">بيستخدم أذكى موديل متاح، ولما يوصل حده بيحوّل للي بعده لحاله.</span></span></label>
        <div class="field" id="gmwrap" ${s.geminiAuto ? "hidden" : ""}><label>الموديل</label><input class="input" id="gm" dir="ltr" value="${esc(s.geminiModel)}"></div>
      </div>
      <div class="field" style="margin-top:6px"><label>لغة الشرح</label>
        <div class="seg" id="lang"><button data-l="both" class="${s.lang === "both" ? "on" : ""}">عربي + English</button><button data-l="ar" class="${s.lang === "ar" ? "on" : ""}">عربي</button><button data-l="en" class="${s.lang === "en" ? "on" : ""}">English</button></div>
        <div class="hint">بكل الحالات بيشرحلك من الصفر، خطوة خطوة.</div></div>
      <button class="btn primary block" id="saveai">حفظ</button>
      <p class="small muted" style="margin:10px 0 0">🔒 المفاتيح بتنحفظ على هاد الجهاز بس، والمحادثات بتروح مباشرة لخدمة الذكاء الاصطناعي بدون أي وسيط.</p>
    </div>

    <h2>المظهر</h2>
    <div class="card"><div class="seg" id="theme">
      <button data-th="light" class="${(S.get("theme", "auto")) === "light" ? "on" : ""}">☀️ فاتح</button>
      <button data-th="dark" class="${(S.get("theme", "auto")) === "dark" ? "on" : ""}">🌙 ليلي</button>
      <button data-th="auto" class="${(S.get("theme", "auto")) === "auto" ? "on" : ""}">📱 تلقائي</button></div></div>

    ${localStorage.getItem("owner.key") ? `<button class="card planbtn" onclick="go('admin')"><span>🔑</span><div><b>تفعيل الطلاب</b><div class="small muted">اعمل أكواد تفعيل للناس اللي بدك توافق عليهم</div></div></button>` : ""}
    <h2>عن التطبيق</h2>
    <div class="card small muted">واجباتي · نسخة 1.0 · مربوط مباشرة مع s1.ebalqa.courses<br>
      <a href="#" onclick="event.preventDefault();pull&&pull();go('home')">تحديث البيانات</a></div>
  </div>`;
  document.getElementById("theme").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.set("theme", b.dataset.th); applyTheme(); buzz(); document.querySelectorAll("#theme button").forEach(x => x.classList.toggle("on", x === b)); };
  document.getElementById("lang").onclick = e => { const b = e.target.closest("button"); if (!b) return; document.querySelectorAll("#lang button").forEach(x => x.classList.toggle("on", x === b)); AI.save({ lang: b.dataset.l }); buzz(); };
  document.getElementById("gauto").onchange = e => { document.getElementById("gmwrap").hidden = e.target.checked; };
  async function showChain() {
    const el = document.getElementById("gchain"), k = document.getElementById("gk").value.trim();
    if (!el || !k) return;
    const list = await AI.freeChain(k), cool = S.get("ai.cooldown", {});
    void list; void cool;
  }
  showChain();
  document.getElementById("saveai").onclick = () => {
    AI.save({ provider: "gemini",
      geminiKey: document.getElementById("gk").value.trim(), geminiModel: document.getElementById("gm").value.trim() || "gemini-3.8-flash",
      geminiAuto: document.getElementById("gauto").checked });
    S.del("ai.freechain"); showChain();
    buzz(); const b = document.getElementById("saveai"); b.textContent = "⏳ بتأكد من المفتاح…"; b.disabled = true;
    const key = document.getElementById("gk").value.trim();
    (async () => {
      let msg = "✓ انحفظ";
      if (key) { try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`); msg = r.ok ? "✓ المفتاح شغّال" : (r.status === 400 || r.status === 403) ? "✗ المفتاح غلط" : "✓ انحفظ"; } catch { msg = "✓ انحفظ (ما قدرت أتأكد، في مشكلة نت)"; } }
      S.del("ai.freechain"); b.disabled = false; b.textContent = msg; if (msg.startsWith("✗")) b.classList.add("bad"); else b.classList.remove("bad");
      setTimeout(() => { b.textContent = "حفظ"; b.classList.remove("bad"); }, 2500);
    })();
  };
};
window.confirmOut = () => { try { return window.confirm("متأكد بدك تطلع؟ رح تنمسح بياناتك من هاد الجهاز (الملاحظات، البطاقات، المحادثات)."); } catch { return true; } };
// logging out wipes everything personal from this device (someone else might log in next), keeps only theme + AI settings
window.logout = async () => {
  const keep = Object.fromEntries(["ai.settings", "theme", "owner.key", "owner.log", "activation"].map(k => [k, localStorage.getItem(k)]));
  Moodle.logout();
  try { localStorage.clear(); for (const [k, v] of Object.entries(keep)) if (v !== null) localStorage.setItem(k, v); } catch {}
  try { indexedDB.deleteDatabase("wajebati"); } catch {}
  try { (await caches.keys()).filter(k => k === "wajebati-state").forEach(k => caches.delete(k)); } catch {}
  location.replace(location.pathname); // fresh start, nothing left in memory
};

/* ---------------- PWA ---------------- */
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then(reg => { registerPeriodic(); reg.update && setInterval(() => reg.update().catch(() => {}), 30 * 60000); }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return; reloaded = true;
    // don't interrupt typing, a call or a room
    if (document.querySelector(".call, .room") || (document.activeElement && /TEXTAREA|INPUT/.test(document.activeElement.tagName))) { toast("✨ في تحديث جديد، سكّر التطبيق وافتحه"); return; }
    location.reload();
  });
}
async function registerPeriodic() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("periodicSync" in reg) await reg.periodicSync.register("check-elearning", { minInterval: 3 * 60 * 60 * 1000 });
  } catch {}
}
// keep a copy of the token where the service worker can read it (for background checks on Android)
function syncSessionToSW() {
  if (!("caches" in window)) return;
  caches.open("wajebati-state").then(c => c.put("session", new Response(JSON.stringify({ session: Moodle.session, known: data ? data.items.map(i => `${i.kind}:${i.id}`) : [] }))));
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Moodle.session) refresh().then(() => { remindDeadlines(); syncSessionToSW(); if ((location.hash.slice(1) || "home") === "home") route(); }).catch(() => {}); });

// start once every script (features, rooms, approval…) is loaded
document.addEventListener("DOMContentLoaded", () => route().then(syncSessionToSW));
if (Moodle.session && !Moodle.session.username) Moodle.call("core_webservice_get_site_info").then(i => { if (i.username) { Moodle.session.username = i.username; S.set("mdl.session", Moodle.session); route(); } }).catch(() => {});

document.getElementById("toast").addEventListener("click", e => e.currentTarget.hidden = true);

/* pull down on the home screen to refresh */
(() => {
  let y0 = null, pulled = 0, ind = null;
  document.addEventListener("touchstart", e => { if ((location.hash || "#home") === "#home" && window.scrollY <= 0) { y0 = e.touches[0].clientY; pulled = 0; } }, { passive: true });
  document.addEventListener("touchmove", e => {
    if (y0 === null) return; pulled = e.touches[0].clientY - y0; if (pulled < 10) return;
    if (!ind) { ind = document.createElement("div"); ind.className = "ptr"; ind.textContent = "↓"; document.body.appendChild(ind); }
    ind.style.transform = `translate(-50%, ${Math.min(pulled, 110) - 40}px) rotate(${pulled * 2}deg)`; ind.textContent = pulled > 80 ? "↻" : "↓";
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (ind) { const go2 = pulled > 80; ind.style.transform = "translate(-50%,-60px)"; const el = ind; ind = null; setTimeout(() => el.remove(), 250); if (go2 && window.pull) { buzz(); window.pull(); } }
    y0 = null;
  });
})();
