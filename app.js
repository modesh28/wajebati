/* واجباتي — main app */
const $app = document.getElementById("app");
const $tabbar = document.getElementById("tabbar");
const S = Moodle.store;
const TZ = "Asia/Amman";
const fmtDate = new Intl.DateTimeFormat("ar-JO", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("ar-JO", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg, ms = 2800) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
function left(sec) {
  const m = Math.floor(sec / 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d > 0) return `${d} يوم${h ? ` و${h} س` : ""}`;
  if (h > 0) return `${h} س و${mi} د`;
  return `${Math.max(mi, 0)} دقيقة`;
}
const now = () => Math.floor(Date.now() / 1000);
function urgency(due) { const s = due - now(); return s < 0 ? "past" : s < 2 * 86400 ? "urgent" : s < 5 * 86400 ? "soon" : "ok"; }
function cleanCourse(n) { return String(n || "").replace(/^\d{4}\/\d{4}-\d-\d+-/, "").replace(/-\d+-\d+$/, "").replace(/\s+/g, " ").trim(); }

/* ---------------- data ---------------- */
let data = S.get("mdl.cache", null); // {courses, items, fetched}
let loading = null;

async function refresh(force = false) {
  if (loading) return loading;
  if (!force && data && Date.now() - data.fetched < 5 * 60 * 1000) return data;
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
    const prev = data;
    data = { courses: courses.map(c => ({ ...c, name: cleanCourse(c.name) })), items, fetched: Date.now() };
    S.set("mdl.cache", data);
    notifyNew(prev, data);
    return data;
  })();
  try { return await loading; } finally { loading = null; }
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

/* ---------------- router ---------------- */
const routes = {};
function go(r) { location.hash = r; }
async function route() {
  const h = location.hash.slice(1) || "home";
  if (!Moodle.session) { $tabbar.hidden = true; document.body.classList.add("no-tabs"); return viewLogin(); }
  $tabbar.hidden = false; document.body.classList.remove("no-tabs");
  const [name, arg] = h.split(/-(.+)/);
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.route === (["course", "assign", "quiz", "study"].includes(name) ? (name === "course" || name === "study" ? "courses" : "home") : name)));
  const fn = routes[name] || routes.home;
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
      ${notifBanner()}
      <h2>الجاي</h2>
      ${up.length ? up.map(itemRow).join("") : data ? `<div class="empty">ما في إشي جاي 👌</div>` : `<div class="spinner"></div>`}
      ${past.length ? `<h2>فات موعدها مؤخراً</h2>${past.map(itemRow).join("")}` : ""}
      <p class="small muted" style="text-align:center;margin-top:18px">${data ? "آخر تحديث: " + fmtShort.format(new Date(data.fetched)) : ""} · <a href="#" onclick="event.preventDefault();pull()">تحديث</a></p>
    </div>`;
  };
  render();
  window.pull = async () => { toast("بحدّث…"); try { await refresh(true); render(); remindDeadlines(); toast("تم التحديث ✓"); } catch (e) { handleErr(e); } };
  await refresh();
  if (location.hash.slice(1) === "home" || !location.hash) { render(); remindDeadlines(); }
};

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
  $app.innerHTML = `<div class="page"><div class="top"><h1>المواد</h1></div><div class="spinner"></div></div>`;
  await refresh();
  const counts = {};
  upcoming().filter(i => i.due > now() && !isDone(i)).forEach(i => counts[i.courseid] = (counts[i.courseid] || 0) + 1);
  $app.innerHTML = `<div class="page"><div class="top"><h1>المواد</h1><span class="sub">${data.courses.length} مادة</span></div>
    ${data.courses.map(c => `<div class="card item" onclick="go('course-${c.id}')">
      <div class="ic">📘</div><div class="body"><div class="title" dir="auto">${esc(c.name)}</div>
      <div class="due">${counts[c.id] ? `${counts[c.id]} مطلوب منك` : "ما في إشي مطلوب"}</div></div>
      ${counts[c.id] ? `<span class="pill soon">${counts[c.id]}</span>` : ""}</div>`).join("") || `<div class="empty">ما في مواد</div>`}
  </div>`;
};

routes.course = async (id) => {
  await refresh();
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
    body.innerHTML = `<div class="spinner"></div>`;
    try {
      const secs = await Study.courseContents(id);
      if (!secs.length) { body.innerHTML = `<div class="empty">ما في ملفات بهاي المادة لسا</div>`; return; }
      body.innerHTML = secs.map(sec => `<h2 dir="auto">${esc(sec.name)}</h2>` + sec.files.map(f => {
        const k = Study.kindOf(f);
        const click = f.link ? `window.open('${esc(f.url)}','_blank')` : Study.studyable(k) ? `go('study-${id}.${f.cmid}.${f.idx}')` : `openMoodle('/mod/resource/view.php?id=${f.cmid}')`;
        return `<div class="card item" onclick="${click}"><div class="ic file-${k}">${Study.icon(k)}</div>
          <div class="body"><div class="title" dir="auto">${esc(f.title)}</div><div class="due" dir="auto">${esc(f.filename)} ${Study.sizeLabel(f.size) ? "· " + Study.sizeLabel(f.size) : ""}</div></div>
          ${Study.studyable(k) ? `<span class="pill ok">ادرس ✨</span>` : ""}</div>`;
      }).join("")).join("");
    } catch (e) { if (e.code === "auth") return handleErr(e); body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  document.getElementById("ctabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; sessionStorage.setItem("ctab-" + id, b.dataset.t);
    document.querySelectorAll("#ctabs button").forEach(x => x.classList.toggle("on", x === b)); b.dataset.t === "files" ? showFiles() : showWork(); };
  tab === "files" ? showFiles() : showWork();
};

routes.study = async (arg) => {
  const [courseid, cmid, idx] = arg.split(".");
  $app.innerHTML = `<div class="page"><div class="spinner"></div></div>`;
  const secs = await Study.courseContents(courseid);
  let f = null; for (const s of secs) for (const x of s.files) if (x.cmid == cmid && x.idx == idx) f = x;
  if (!f) { $app.innerHTML = `<div class="page"><div class="empty">ما لقيت الملف</div></div>`; return; }
  const k = Study.kindOf(f);
  const cname = (data && (data.courses.find(c => c.id == courseid) || {}).name) || "";
  const fileLink = Moodle.fileUrl(f.url);
  $app.innerHTML = `<div class="page">
    <div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>
    <div class="filehead"><div class="bigic file-${k}">${Study.icon(k)}</div>
      <div style="min-width:0"><div class="small muted" dir="auto">${esc(cname)}</div><h1 style="margin:0;font-size:20px" dir="auto">${esc(f.title)}</h1>
      <div class="small muted" dir="auto">${esc(f.filename)} ${Study.sizeLabel(f.size) ? "· " + Study.sizeLabel(f.size) : ""}</div></div></div>
    <div class="btns" style="margin:14px 0 4px">
      <a class="btn" href="${esc(fileLink)}" target="_blank" rel="noopener">📥 افتح الملف</a>
      <a class="btn" href="https://notebooklm.google.com/" target="_blank" rel="noopener" onclick="toast('نزّل الملف وارفعه بـ NotebookLM كمصدر 📚', 4000)">📓 NotebookLM ↗</a>
    </div>
    <div id="ferr"></div>
    ${!AI.ready() ? `<div class="card"><b>حط مفتاح الـ AI أول</b><div class="btns"><button class="btn primary" onclick="go('settings')">الإعدادات</button></div></div>` : `
    <h2>ادرس من الملف</h2>
    <div class="tools">
      <button class="tool" data-t="summary"><span>📝</span>ملخّص</button>
      <button class="tool" data-t="explain"><span>👨‍🏫</span>اشرحلي</button>
      <button class="tool" data-t="cards"><span>🃏</span>بطاقات مراجعة</button>
      <button class="tool" data-t="quiz"><span>🎯</span>كويز تدريبي</button>
    </div>
    <div id="out"></div>
    <h2>اسأل عن الملف</h2>
    <div id="fchat" class="chat"></div>
    <form class="composer" id="fcomp" style="position:static"><div class="bar">
      <textarea id="finp" rows="1" placeholder="مثلاً: شو الفرق بين الـ Stack والـ Queue بهاد الملف؟" dir="auto"></textarea>
      <button class="iconbtn send" id="fsend">↑</button></div></form>`}
  </div>`;
  if (!AI.ready()) return;
  let doc = null;
  const getDoc = async () => {
    if (doc) return doc;
    document.getElementById("ferr").innerHTML = `<div class="note">⏳ بقرأ الملف…</div>`;
    try { doc = await Study.load(f); document.getElementById("ferr").innerHTML = ""; return doc; }
    catch (e) {
      document.getElementById("ferr").innerHTML = `<div class="err">${e.code === "fetch" ? "ما قدرت أنزّل الملف من الإي ليرنينج للتطبيق. افتحه من زر «افتح الملف» فوق، وبعدين صوّره أو ارفعه للمساعد ✨." : esc(e.message)}</div>`;
      throw e;
    }
  };
  const out = document.getElementById("out");
  const tools = document.querySelectorAll(".tool");
  const busy = on => tools.forEach(t => t.disabled = on);
  document.querySelector(".tools").onclick = async e => {
    const b = e.target.closest(".tool"); if (!b || b.disabled) return;
    const t = b.dataset.t; busy(true);
    out.innerHTML = `<div class="card"><div class="spinner" style="margin:10px auto"></div><p class="small muted" style="text-align:center;margin:0">${t === "cards" ? "بجهّز البطاقات…" : t === "quiz" ? "بجهّز الأسئلة…" : "بقرأ وبكتب…"}</p></div>`;
    try {
      const d = await getDoc();
      if (t === "summary" || t === "explain") {
        const box = document.createElement("div"); box.className = "card msg ai answer"; out.innerHTML = ""; out.appendChild(box);
        await Study.ask(d, t, txt => box.innerHTML = AI.md(txt));
      } else {
        const txt = await Study.ask(d, t);
        const j = Study.parseJSON(txt);
        t === "cards" ? renderCards(out, j.cards || []) : renderQuiz(out, j.questions || []);
      }
    } catch (err) { if (err.code !== "fetch") out.innerHTML = `<div class="err">${esc(err.message === "Unexpected end of JSON input" || /JSON/.test(err.message) ? "ما طلع الجواب مرتب، جرّب مرة ثانية." : err.message)}</div>`; else out.innerHTML = ""; }
    busy(false);
  };
  const msgs = [];
  const fchat = document.getElementById("fchat"), finp = document.getElementById("finp");
  finp.addEventListener("input", () => { finp.style.height = "auto"; finp.style.height = Math.min(finp.scrollHeight, 140) + "px"; });
  document.getElementById("fcomp").onsubmit = async e => {
    e.preventDefault(); const q = finp.value.trim(); if (!q) return; finp.value = "";
    const me = document.createElement("div"); me.className = "msg me"; me.textContent = q; fchat.appendChild(me);
    const ai = document.createElement("div"); ai.className = "msg ai"; ai.textContent = "…"; fchat.appendChild(ai);
    msgs.push({ role: "user", text: q });
    try { const d = await getDoc(); const a = await Study.ask(d, null, txt => ai.innerHTML = AI.md(txt), msgs.slice(-12)); msgs.push({ role: "assistant", text: a }); }
    catch (err) { msgs.pop(); ai.innerHTML = `<span style="color:var(--red)">${esc(err.code === "fetch" ? "ما قدرت أقرأ الملف" : err.message)}</span>`; }
  };
};

function renderCards(el, cards) {
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
    document.getElementById("yes").onclick = () => { known++; i++; draw(); };
    document.getElementById("no").onclick = () => { cards.push(cards[i]); i++; draw(); };
  };
  draw();
}

function renderQuiz(el, qs) {
  if (!qs.length) { el.innerHTML = `<div class="err">ما طلعت أسئلة، جرّب مرة ثانية.</div>`; return; }
  let i = 0, score = 0;
  const draw = () => {
    if (i >= qs.length) {
      const pct = Math.round(score / qs.length * 100);
      el.innerHTML = `<div class="card" style="text-align:center"><div style="font-size:40px">${pct >= 80 ? "🏆" : pct >= 50 ? "👍" : "📚"}</div><b>علامتك ${score} من ${qs.length}</b><p class="muted">${pct >= 80 ? "ممتاز، إنت جاهز!" : pct >= 50 ? "منيح، راجع الأسئلة اللي غلطت فيها." : "بدها مراجعة، جرّب الملخص أو البطاقات."}</p><button class="btn primary" id="again">أعيد الكويز</button></div>`;
      document.getElementById("again").onclick = () => { i = 0; score = 0; draw(); }; return;
    }
    const q = qs[i];
    el.innerHTML = `<div class="card"><div class="small muted">سؤال ${i + 1} من ${qs.length}</div><div class="qtext" dir="auto">${esc(q.q)}</div>
      <div class="opts">${q.options.map((o, j) => `<button class="opt" data-j="${j}" dir="auto">${esc(o)}</button>`).join("")}</div><div id="why"></div>
      <div class="progress"><div style="width:${(i / qs.length) * 100}%"></div></div></div>`;
    el.querySelector(".opts").onclick = e => {
      const b = e.target.closest(".opt"); if (!b || el.querySelector(".opt.right")) return;
      const j = +b.dataset.j, ok = j === +q.answer; if (ok) score++;
      el.querySelectorAll(".opt").forEach((x, n) => { x.disabled = true; if (n === +q.answer) x.classList.add("right"); });
      if (!ok) b.classList.add("wrong");
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
  await refresh();
  const a = data.items.find(i => i.kind === "assign" && i.id == id);
  if (!a) { $app.innerHTML = `<div class="page"><div class="empty">ما لقيت الواجب</div></div>`; return; }
  $app.innerHTML = `<div class="page"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div><div class="spinner"></div></div>`;
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
        ${allowFiles ? `<div class="field"><label>الملفات</label><input class="input" type="file" id="sfiles" multiple>
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
  await refresh();
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
      <button class="btn primary" onclick="openMoodle('/mod/quiz/view.php?id=${q.cmid}')">${opened && !closed ? "ادخل الكويز ↗" : "افتح بالإي ليرنينج ↗"}</button>
    </div>
    <p class="small muted">الكويز بيفتح بالإي ليرنينج وإنت مسجّل دخول تلقائياً. حل الكويز من جوّا التطبيق جاي بالتحديث الجاي.</p>
  </div>`;
};

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

بتقدر: ترتّبله الأولويات وتعمل خطط دراسة، تشرح أي مفهوم بأمثلة، تقرأ الصور اللي ببعتها (أسئلة، سلايدات، كود، أخطاء)، تراجع شغله وتعطيه ملاحظات، وتساعده بالبرمجة.
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
    <div class="top"><div><h1>المساعد ✨</h1><div class="sub" id="aimodel">${s.provider === "claude" ? "Claude · " + esc(s.claudeModel) : s.geminiAuto ? "Gemini · مجاني · بيبدّل الموديل لحاله" : "Gemini · " + esc(s.geminiModel)}</div></div>
      ${chatMsgs.length ? `<button class="back" onclick="newChat()">محادثة جديدة</button>` : ""}</div>
    ${!ready ? `<div class="card"><b>لازم تحط مفتاح الـ AI أول مرة</b><p class="small muted" style="margin:6px 0 10px">المفتاح بيتخزّن على تلفونك بس، وما بيروح لأي مكان غير الشركة نفسها.</p><button class="btn primary" onclick="go('settings')">افتح الإعدادات</button></div>` : ""}
    <div class="chat" id="chat"></div>
    ${!chatMsgs.length && ready ? `<div class="sugg" id="sugg">
      <button class="chip">شو أبلّش فيه هلأ؟</button>
      <button class="chip">اعملي خطة دراسة لهالأسبوع</button>
      <button class="chip">لخّصلي شو عليّ هالشهر</button>
      <button class="chip">صوّرتلك سؤال، اشرحلي إياه</button></div>` : ""}
    <form class="composer" id="composer">
      <div class="thumbs" id="thumbs"></div>
      <div class="bar">
        <button type="button" class="iconbtn" id="attach" title="صورة">📷</button>
        <input type="file" id="imgin" accept="image/*" multiple hidden>
        <textarea id="inp" rows="1" placeholder="اسأل أي إشي…" dir="auto" ${ready ? "" : "disabled"}></textarea>
        <button class="iconbtn send" id="send" ${ready ? "" : "disabled"}>↑</button>
      </div>
    </form>
  </div>`;
  const chat = document.getElementById("chat");
  chatMsgs.forEach(m => chat.appendChild(msgEl(m)));
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
  const inp = document.getElementById("inp");
  if (aiDraft) { inp.value = aiDraft; aiDraft = ""; }
  const grow = () => { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight, 140) + "px"; };
  inp.addEventListener("input", grow); grow();
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); document.getElementById("composer").requestSubmit(); } });
  document.getElementById("attach").onclick = () => document.getElementById("imgin").click();
  document.getElementById("imgin").onchange = async e => {
    for (const f of e.target.files) { try { pendingImgs.push(await AI.imageFromFile(f)); } catch (err) { toast(err.message); } }
    e.target.value = ""; drawThumbs();
  };
  const sugg = document.getElementById("sugg");
  if (sugg) sugg.onclick = e => { const b = e.target.closest(".chip"); if (!b) return; if (b.textContent.includes("صوّرت")) document.getElementById("imgin").click(); else { inp.value = b.textContent; document.getElementById("composer").requestSubmit(); } };
  document.getElementById("composer").onsubmit = e => { e.preventDefault(); sendAI(); };
  drawThumbs();
};
function drawThumbs() {
  const el = document.getElementById("thumbs"); if (!el) return;
  el.innerHTML = pendingImgs.map((im, i) => `<div><img src="${im.preview}"><button type="button" onclick="pendingImgs.splice(${i},1);drawThumbs()">×</button></div>`).join("");
}
function msgEl(m) {
  const d = document.createElement("div");
  d.className = "msg " + (m.role === "user" ? "me" : "ai");
  if (m.role === "user") { d.innerHTML = (m.images || []).map(im => `<img src="data:${im.mime};base64,${im.data}">`).join("") + esc(m.text); }
  else d.innerHTML = AI.md(m.text || "");
  return d;
}
window.newChat = () => { chatMsgs = []; S.set("ai.chat", []); route(); };
async function sendAI() {
  const inp = document.getElementById("inp");
  const text = inp.value.trim();
  if (aiBusy) { aiAbort && aiAbort.abort(); return; }
  if (!text && !pendingImgs.length) return;
  const sugg = document.getElementById("sugg"); if (sugg) sugg.remove();
  const userMsg = { role: "user", text: text || "شو بالصورة؟", images: pendingImgs.map(({ mime, data }) => ({ mime, data })) };
  pendingImgs = []; drawThumbs(); inp.value = ""; inp.style.height = "auto";
  chatMsgs.push(userMsg);
  const chat = document.getElementById("chat");
  chat.appendChild(msgEl(userMsg));
  const bubble = msgEl({ role: "assistant", text: "…" }); chat.appendChild(bubble);
  window.scrollTo(0, document.body.scrollHeight);
  aiBusy = true; aiAbort = new AbortController();
  const sendBtn = document.getElementById("send"); sendBtn.textContent = "■";
  try {
    // keep last 20 messages; only the last 2 user turns keep their images (saves cost)
    const recent = chatMsgs.slice(-20).map((m, i, arr) => ({ ...m, images: i >= arr.length - 4 ? m.images : [] }));
    if (recent[0] && recent[0].role === "assistant") recent.shift();
    const full = await AI.chat({ system: aiContext(), messages: recent, signal: aiAbort.signal,
      onModel: m => { const el = document.getElementById("aimodel"); if (el && AI.settings().geminiAuto) el.textContent = "Gemini · مجاني · " + m; },
      onText: t => { bubble.innerHTML = AI.md(t); if (window.innerHeight + window.scrollY > document.body.scrollHeight - 200) window.scrollTo(0, document.body.scrollHeight); } });
    chatMsgs.push({ role: "assistant", text: full });
  } catch (e) {
    if (e.name === "AbortError") { chatMsgs.push({ role: "assistant", text: bubble.textContent || "(وقّفت)" }); }
    else { bubble.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; chatMsgs.pop(); }
  }
  // don't store old images forever (storage is small)
  chatMsgs = chatMsgs.slice(-40).map((m, i, arr) => i < arr.length - 6 ? { ...m, images: [] } : m);
  try { S.set("ai.chat", chatMsgs); } catch {}
  aiBusy = false; aiAbort = null; if (sendBtn) sendBtn.textContent = "↑";
}

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
      <div class="field"><label>المزوّد</label>
        <div class="seg" id="prov"><button data-p="gemini" class="${s.provider === "gemini" ? "on" : ""}">Gemini (مجاني)</button><button data-p="claude" class="${s.provider === "claude" ? "on" : ""}">Claude (مدفوع)</button></div></div>
      <div id="pclaude" ${s.provider === "claude" ? "" : "hidden"}>
        <div class="field"><label>Claude API key</label><input class="input" id="ck" type="password" dir="ltr" placeholder="sk-ant-…" value="${esc(s.claudeKey)}">
          <div class="hint">من <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> ← API Keys. بدك تشحن رصيد بسيط.</div></div>
        <div class="field"><label>الموديل</label><input class="input" id="cm" dir="ltr" value="${esc(s.claudeModel)}"><div class="hint">claude-sonnet-5-5 (سريع وذكي) أو claude-opus-5-5 (الأذكى، أغلى)</div></div>
      </div>
      <div id="pgemini" ${s.provider === "gemini" ? "" : "hidden"}>
        <div class="field"><label>Gemini API key</label><input class="input" id="gk" type="password" dir="ltr" placeholder="AIza…" value="${esc(s.geminiKey)}">
          <div class="hint">مجاني من <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></div></div>
        <label class="field" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer"><input type="checkbox" id="gauto" ${s.geminiAuto ? "checked" : ""} style="margin-top:5px;width:18px;height:18px">
          <span><b>تبديل تلقائي بين الموديلات المجانية</b><span class="hint" style="display:block">بيستخدم أذكى موديل مجاني، ولما يوصل حده بيحوّل للي بعده لحاله.<br><span id="gchain" dir="ltr"></span></span></span></label>
        <div class="field" id="gmwrap" ${s.geminiAuto ? "hidden" : ""}><label>الموديل</label><input class="input" id="gm" dir="ltr" value="${esc(s.geminiModel)}"></div>
      </div>
      <button class="btn primary block" id="saveai">حفظ</button>
      <p class="small muted" style="margin:10px 0 0">🔒 المفاتيح بتنحفظ على هاد الجهاز بس، والمحادثات بتروح مباشرة للشركة اللي اخترتها.</p>
    </div>

    <h2>عن التطبيق</h2>
    <div class="card small muted">واجباتي · نسخة 1.0 · مربوط مباشرة مع s1.ebalqa.courses<br>
      <a href="#" onclick="event.preventDefault();pull&&pull();go('home')">تحديث البيانات</a></div>
  </div>`;
  let prov = s.provider;
  document.getElementById("gauto").onchange = e => { document.getElementById("gmwrap").hidden = e.target.checked; };
  async function showChain() {
    const el = document.getElementById("gchain"), k = document.getElementById("gk").value.trim();
    if (!el || !k) return;
    const list = await AI.freeChain(k), cool = S.get("ai.cooldown", {});
    el.innerHTML = list.map(m => cool[m] > Date.now() ? `<s>${esc(m)}</s>` : esc(m)).join(" → ");
  }
  showChain();
  document.getElementById("prov").onclick = e => {
    const b = e.target.closest("button"); if (!b) return; prov = b.dataset.p;
    document.querySelectorAll("#prov button").forEach(x => x.classList.toggle("on", x === b));
    document.getElementById("pclaude").hidden = prov !== "claude"; document.getElementById("pgemini").hidden = prov !== "gemini";
  };
  document.getElementById("saveai").onclick = () => {
    AI.save({ provider: prov, claudeKey: document.getElementById("ck").value.trim(), claudeModel: document.getElementById("cm").value.trim() || "claude-sonnet-5-5",
      geminiKey: document.getElementById("gk").value.trim(), geminiModel: document.getElementById("gm").value.trim() || "gemini-3.8-flash",
      geminiAuto: document.getElementById("gauto").checked });
    S.del("ai.freechain"); showChain();
    toast("انحفظ ✓");
  };
};
window.confirmOut = () => true;
window.logout = () => { Moodle.logout(); S.del("ai.chat"); chatMsgs = []; location.hash = ""; route(); };

/* ---------------- PWA ---------------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(() => registerPeriodic()).catch(() => {});
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

route().then(syncSessionToSW);
