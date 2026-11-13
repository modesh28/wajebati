/* واجباتي — extra features: exam mode, full-course quiz, snap & solve, notes, GPA, study timer,
   challenge a friend, voice review, share summaries. Uses helpers from app.js. */

/* ======================= shared helpers ======================= */
async function courseFiles(courseid) { const secs = await Study.courseContents(courseid); return secs.flatMap(s => s.files.map(f => ({ ...f, section: s.name }))); }
function courseName(id) { return (data && (data.courses.find(c => c.id == id) || {}).name) || ""; }
function daysLeft(ts) { return Math.ceil((ts - Date.now()) / 86400000); }
const dayFmt = new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", weekday: "long", day: "numeric", month: "long" });
const ymd = d => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Amman" });
function b64url(bytes) { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64url(str) { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function pack(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (!window.CompressionStream) return "j" + b64url(raw);
  const cs = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return "z" + b64url(new Uint8Array(await new Response(cs).arrayBuffer()));
}
async function unpack(str) {
  const bytes = unb64url(str.slice(1));
  if (str[0] === "j") return JSON.parse(new TextDecoder().decode(bytes));
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(ds).text());
}
async function shareOrCopy({ title, text, url, files }) {
  try {
    if (files && navigator.canShare && navigator.canShare({ files })) { await navigator.share({ title, text, files }); return; }
    if (navigator.share) { await navigator.share({ title, text, url }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText([text, url].filter(Boolean).join("\n")); toast("✓ انسخ الرابط"); } catch { sheet(`<p>انسخ الرابط:</p><textarea class="input" rows="4" dir="ltr">${esc(url || text)}</textarea>`); }
}

/* ======================= 1) exam mode ======================= */
function exams() { return S.get("exams", {}); }
routes.exam = async (id) => {
  await ensureData();
  const ex = exams()[id] || {};
  const name = courseName(id);
  const render = () => {
    const e = exams()[id] || {};
    const dl = e.date ? daysLeft(e.date) : null;
    $app.innerHTML = `<div class="page enter">
      <div class="top"><button class="back" onclick="history.back()">→ رجوع</button>${dl !== null ? `<span class="pill ${dl <= 2 ? "urgent" : dl <= 6 ? "soon" : "ok"}">${dl > 0 ? `باقي ${dl} يوم` : dl === 0 ? "اليوم!" : "خلص"}</span>` : ""}</div>
      <div class="small muted" dir="auto">${esc(name)}</div><h1 style="margin:0 0 12px;font-size:22px">📅 وضع الامتحان</h1>
      <div class="card">
        <div class="field"><label>موعد الامتحان</label><input class="input" type="datetime-local" id="exdate" value="${e.date ? new Date(e.date - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}"></div>
        <div class="field"><label>شو جاي بالامتحان؟ (اختياري)</label><input class="input" id="exscope" placeholder="مثلاً: من أول المادة لحد الفصل ٦" value="${esc(e.scope || "")}"></div>
        <button class="btn primary block" id="exgo">${e.plan ? "↻ اعمل خطة جديدة" : "✨ اعملي خطة دراسة لحد الامتحان"}</button>
      </div>
      <div id="explan"></div></div>`;
    document.getElementById("exgo").onclick = makePlan;
    if (e.plan) drawPlan();
  };
  const drawPlan = () => {
    const e = exams()[id]; const el = document.getElementById("explan"); if (!el || !e || !e.plan) return;
    const today = ymd(Date.now()); const total = e.plan.days.reduce((a, d) => a + d.tasks.length, 0), doneN = Object.keys(e.done || {}).length;
    el.innerHTML = `<div class="card"><div class="bhead"><span>تقدّمك</span><span>${Math.round(doneN / Math.max(total, 1) * 100)}%</span></div><div class="progress"><div style="width:${doneN / Math.max(total, 1) * 100}%"></div></div></div>
      ${e.plan.days.map((d, di) => `<div class="card day ${d.date === today ? "today" : d.date < today ? "pastday" : ""}">
        <div class="bhead"><span>${d.date === today ? "📍 اليوم · " : ""}${esc(dayFmt.format(new Date(d.date + "T12:00:00")))}</span><span class="small muted">${esc(d.title || "")}</span></div>
        ${d.tasks.map((t, ti) => { const k = di + "." + ti; return `<label class="task"><input type="checkbox" data-k="${k}" ${(e.done || {})[k] ? "checked" : ""}><span dir="auto">${esc(t.text)}</span>${t.file_number ? `<button class="link" data-open="${t.file_number}">افتح ↗</button>` : ""}</label>`; }).join("")}
        ${d.tip ? `<div class="small muted" dir="auto">💡 ${esc(d.tip)}</div>` : ""}</div>`).join("")}`;
    el.onclick = async ev => {
      const o = ev.target.closest("[data-open]"); if (o) { ev.preventDefault(); const files = await courseFiles(id); const f = files[+o.dataset.open - 1]; if (f) go(`study-${id}.${f.cmid}.${f.idx}`); return; }
    };
    el.onchange = ev => { const cb = ev.target.closest("[data-k]"); if (!cb) return; const all = exams(); all[id].done = all[id].done || {}; cb.checked ? all[id].done[cb.dataset.k] = 1 : delete all[id].done[cb.dataset.k]; S.set("exams", all); buzz(); drawPlan(); };
  };
  const makePlan = async () => {
    const v = document.getElementById("exdate").value; if (!v) { toast("حط موعد الامتحان"); return; }
    const date = new Date(v).getTime(), scope = document.getElementById("exscope").value.trim();
    if (date < Date.now()) { toast("الموعد لازم يكون بالمستقبل"); return; }
    const all = exams(); all[id] = { ...(all[id] || {}), date, scope }; S.set("exams", all);
    if (!AI.ready()) { toast("حط مفتاح الذكاء الاصطناعي من الإعدادات"); return; }
    const el = document.getElementById("explan"); el.innerHTML = `<div class="card answer"></div>`; const w = waiter(el.firstChild); w.status("thinking");
    try {
      const files = await courseFiles(id);
      const outline = files.map((f, i) => `${i + 1}. [${f.section}] ${f.title}`).join("\n");
      const weak = S.get("weak", []).filter(x => (x.src || "").length).slice(-10).map(x => "- " + x.topic).join("\n");
      const days = Math.max(1, daysLeft(date));
      const txt = await AI.chat({ system: "إنت مخطط دراسة ذكي. لهجة أردنية، مختصر وعملي.", depth: "smart", json: true,
        messages: [{ role: "user", text: `اليوم ${ymd(Date.now())}. امتحان مادة "${courseName(id)}" بتاريخ ${ymd(date)} (بعد ${days} يوم).${scope ? " المطلوب: " + scope : ""}
ملفات المادة بالترتيب:
${outline}
${weak ? "نقاط ضعفي:\n" + weak : ""}
اعملي خطة يوم بيوم من اليوم لحد يوم قبل الامتحان (آخر يوم مراجعة شاملة وكويز). وزّع الملفات بشكل منطقي، 2-4 مهام باليوم، مهام واضحة وقصيرة، واربط المهمة برقم الملف إذا في. رجّع JSON بس:
{"days":[{"date":"YYYY-MM-DD","title":"عنوان قصير","tasks":[{"text":"المهمة","file_number":1}],"tip":"نصيحة قصيرة"}]}` }],
        onStatus: (k, m) => w.status(k, m) });
      w.stop();
      const plan = Study.parseJSON(txt);
      const all2 = exams(); all2[id] = { ...all2[id], plan, done: {} }; S.set("exams", all2);
      buzz(); render();
    } catch (er) { w.stop(); el.innerHTML = `<div class="err">${esc(er.message)}</div>`; }
  };
  render();
};
// daily reminder for exams (shown once a day when you open the app)
function examReminder() {
  const all = exams(), today = ymd(Date.now()), sent = S.get("exremind", "");
  if (sent === today || !("Notification" in window) || Notification.permission !== "granted") return;
  const soon = Object.entries(all).filter(([, e]) => e.date && daysLeft(e.date) >= 0 && daysLeft(e.date) <= 14);
  if (!soon.length) return;
  navigator.serviceWorker?.getRegistration().then(reg => {
    for (const [id, e] of soon) {
      const d = e.plan && e.plan.days.find(x => x.date === today);
      const body = `${d ? "مهمة اليوم: " + d.tasks.map(t => t.text).join("، ") : "افتح خطتك وابدأ"}`;
      reg && reg.showNotification(`📅 امتحان ${courseName(id) || ""} بعد ${daysLeft(e.date)} يوم`, { body, icon: "icons/icon-192.png", tag: "exam-" + id, data: { url: `./#exam-${id}` } });
    }
  });
  S.set("exremind", today);
}

/* ======================= 2) full-course quiz ======================= */
routes.cquiz = async (id) => {
  await ensureData();
  $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>
    <div class="small muted" dir="auto">${esc(courseName(id))}</div><h1 style="margin:0 0 6px;font-size:22px">🎯 امتحان تجريبي للمادة</h1>
    <p class="muted small" style="margin:0 0 12px">أسئلة من كل ملفات المادة، زي الامتحان النهائي.</p>
    <div class="seg" id="qn" style="margin-bottom:12px"><button data-n="10">١٠ أسئلة</button><button data-n="20" class="on">٢٠ سؤال</button><button data-n="30">٣٠ سؤال</button></div>
    <button class="btn primary block" id="qgo">ابدأ الامتحان</button><div id="qout" style="margin-top:14px"></div></div>`;
  let n = 20;
  document.getElementById("qn").onclick = e => { const b = e.target.closest("button"); if (!b) return; n = +b.dataset.n; document.querySelectorAll("#qn button").forEach(x => x.classList.toggle("on", x === b)); };
  document.getElementById("qgo").onclick = async () => {
    if (!AI.ready()) { go("settings"); return; }
    const out = document.getElementById("qout"); out.innerHTML = `<div class="card answer"></div>`; const w = waiter(out.firstChild);
    try {
      const files = (await courseFiles(id)).filter(f => Study.studyable(Study.kindOf(f)));
      const docs = [], texts = []; let budget = 14e6, read = 0;
      for (const f of files) {
        w.status("tool", `بقرأ الملفات… ${++read}/${files.length}`);
        try {
          const d = await Study.load(f);
          if (d.kind === "pdf") { if (d.data.length < budget) { docs.push({ mime: "application/pdf", data: d.data }); budget -= d.data.length; texts.push(`(PDF مرفق) ${f.title}`); } }
          else if (d.kind === "text") texts.push(`=== ${f.title} ===\n${d.data.slice(0, 25000)}`);
        } catch {}
      }
      if (!docs.length && !texts.length) throw new Error("ما قدرت أقرأ ملفات المادة. افتح الملفات من صفحة المادة أول.");
      w.status("thinking");
      const txt = await AI.chat({ system: "إنت أستاذ جامعي بيكتب امتحان نهائي. " + AI.langRule(), depth: "deep", json: true,
        messages: [{ role: "user", docs, text: `هاي ملفات مادة "${courseName(id)}":\n${texts.join("\n\n")}\n\nاكتب امتحان تجريبي من ${n} سؤال اختيار من متعدد، موزعة على كل الملفات، بمستوى الامتحان الجامعي (فهم وتطبيق مش بس حفظ)، ومع كل سؤال اسم الملف اللي جاي منه. رجّع JSON بس:
{"questions":[{"q":"السؤال","options":["أ","ب","ج","د"],"answer":0,"why":"ليش","src":"اسم الملف"}]}` }],
        onStatus: (k, m) => w.status(k, m) });
      w.stop();
      const j = Study.parseJSON(txt);
      KV.set("cquiz:" + id, j);
      renderQuiz(out, j.questions || [], courseName(id), { title: "امتحان " + courseName(id) });
      buzz();
    } catch (er) { w.stop(); out.innerHTML = `<div class="err">${esc(er.message)}</div>`; }
  };
};

/* ======================= 3) snap a question & solve ======================= */
window.snapSolve = () => {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*"; inp.capture = "environment";
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const im = await AI.imageFromFile(f, 2000);
      pendingImgs.push(im);
      aiDraft = "حلّلي هاد السؤال خطوة بخطوة: افهم المطلوب، الحل بالتفصيل، والجواب النهائي واضح، وبالآخر سؤال مشابه أتدرّب عليه.";
      go("ai");
      setTimeout(() => { const b = document.getElementById("composer"); if (b) b.requestSubmit(); }, 350);
    } catch (e) { toast(e.message); }
  };
  inp.click();
};

/* ======================= 4) course notes ======================= */
routes.notes = async (id) => {
  await ensureData();
  const key = "notes:" + id;
  const st = (await KV.get(key)) || { items: [], organized: "" };
  const save = () => KV.set(key, st);
  const draw = () => {
    $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button>${st.items.length ? `<button class="back" id="nshare">↗ شارك</button>` : ""}</div>
      <div class="small muted" dir="auto">${esc(courseName(id))}</div><h1 style="margin:0 0 12px;font-size:22px">📒 ملاحظاتي</h1>
      <div class="card"><textarea class="input" id="ntext" rows="3" dir="auto" placeholder="اكتب ملاحظة… (الدكتور قال، فكرة مهمة، سؤال…)"></textarea>
        <div class="btns"><button class="btn primary" id="nadd">إضافة</button>${SR ? `<button class="btn" id="ndict">🎤 احكي</button>` : ""}</div></div>
      ${st.items.length ? `<button class="card planbtn" id="norg"><span>✨</span><div><b>رتّبلي ملاحظاتي</b><div class="small muted">بيرتّبها حسب محاضرات المادة وبيكمّل الناقص</div></div></button>` : ""}
      ${st.organized ? `<h2>الملاحظات مرتبة</h2><div class="card msg ai answer" id="norgout">${AI.md(st.organized)}</div>` : ""}
      <h2>كل الملاحظات (${st.items.length})</h2>
      ${st.items.slice().reverse().map((n, k) => `<div class="card note-item"><div dir="auto">${esc(n.text)}</div><div class="small muted">${fmtShort.format(new Date(n.t))} <button class="link" data-del="${st.items.length - 1 - k}">حذف</button></div></div>`).join("") || `<div class="empty">ما في ملاحظات لسا</div>`}
    </div>`;
    const ta = document.getElementById("ntext");
    document.getElementById("nadd").onclick = () => { const t = ta.value.trim(); if (!t) return; st.items.push({ text: t, t: Date.now() }); save(); buzz(); draw(); };
    const dbtn = document.getElementById("ndict");
    if (dbtn) dbtn.onclick = () => {
      const r = new SR(); r.lang = srLang(); r.interimResults = true; r.continuous = true; const base = ta.value;
      r.onresult = e => { ta.value = (base ? base + " " : "") + [...e.results].map(x => x[0].transcript).join(" "); };
      r.onend = () => { dbtn.textContent = "🎤 احكي"; dbtn.onclick = null; draw.rebind && 0; };
      r.start(); dbtn.textContent = "⏹ وقّف"; dbtn.onclick = () => r.stop(); buzz();
    };
    $app.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { st.items.splice(+b.dataset.del, 1); save(); draw(); });
    const org = document.getElementById("norg");
    if (org) org.onclick = async () => {
      if (!AI.ready()) { go("settings"); return; }
      buzz(); const box = document.createElement("div"); box.className = "card answer"; org.after(box); const w = waiter(box);
      try {
        const files = await courseFiles(id);
        const txt = await AI.chat({ system: "إنت مساعد دراسي ذكي. " + AI.langRule(), depth: "smart",
          messages: [{ role: "user", text: `هاي ملاحظاتي بمادة "${courseName(id)}" (بالترتيب اللي كتبتها فيه):\n${st.items.map(n => "- " + n.text).join("\n")}\n\nومحاضرات المادة:\n${files.map((f, i) => `${i + 1}. ${f.title}`).join("\n")}\n\nرتّب ملاحظاتي كملاحظات دراسة نظيفة: قسّمها بعناوين حسب المحاضرة/الموضوع، صحّح أي غلط علمي ووضّح التصحيح، كمّل النواقص المهمة بسطر، وبالآخر "⚠️ أشياء لازم أتأكد منها".` }],
          onText: t => w.text(t), onStatus: (k, m) => w.status(k, m) });
        st.organized = txt; save(); draw();
      } catch (er) { w.stop(); box.innerHTML = `<div class="err">${esc(er.message)}</div>`; }
    };
    const sh = document.getElementById("nshare");
    if (sh) sh.onclick = () => shareOrCopy({ title: "ملاحظاتي – " + courseName(id), text: (st.organized || st.items.map(n => "• " + n.text).join("\n")).replace(/[#*]/g, "") });
  };
  draw();
};
async function allNotes() { if (!data) return []; const out = []; for (const c of data.courses) { const st = await KV.get("notes:" + c.id); if (st && st.items.length) out.push({ course: c.name, notes: st.items.map(n => n.text) }); } return out; }

/* ======================= 5) GPA calculator ======================= */
const GRADES = [["A", 4], ["A-", 3.75], ["B+", 3.5], ["B", 3], ["B-", 2.75], ["C+", 2.5], ["C", 2], ["C-", 1.75], ["D+", 1.5], ["D", 1.25], ["D-", 1], ["F", 0.5]];
routes.gpa = async () => {
  await ensureData().catch(() => {});
  const st = S.get("gpa", null) || { prevGpa: "", prevHours: "", rows: (data ? data.courses : []).map(c => ({ name: c.name, hours: 3, grade: "" })), target: "" };
  const draw = () => {
    const pts = Object.fromEntries(GRADES);
    const rows = st.rows.filter(r => r.grade && +r.hours > 0);
    const semH = rows.reduce((a, r) => a + +r.hours, 0), semP = rows.reduce((a, r) => a + pts[r.grade] * +r.hours, 0);
    const sem = semH ? semP / semH : 0;
    const pg = parseFloat(st.prevGpa) || 0, ph = parseFloat(st.prevHours) || 0;
    const cum = (ph + semH) ? (pg * ph + semP) / (ph + semH) : 0;
    const allH = st.rows.reduce((a, r) => a + (+r.hours || 0), 0), tgt = parseFloat(st.target);
    const need = tgt && allH ? (tgt * (ph + allH) - pg * ph) / allH : null;
    $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>
      <h1 style="margin:0 0 12px;font-size:22px">🎓 حاسبة المعدل</h1>
      <div class="stats"><div class="stat"><b>${sem ? sem.toFixed(2) : "–"}</b><span>المعدل الفصلي</span></div><div class="stat"><b>${cum ? cum.toFixed(2) : "–"}</b><span>التراكمي الجديد</span></div><div class="stat"><b>${semH}</b><span>ساعات الفصل</span></div></div>
      <div class="card"><div class="gp-row head"><span>المادة</span><span>ساعات</span><span>العلامة</span><span></span></div>
        ${st.rows.map((r, k) => `<div class="gp-row"><input class="input" data-k="${k}" data-f="name" value="${esc(r.name)}" dir="auto"><input class="input" data-k="${k}" data-f="hours" type="number" min="0" max="6" value="${esc(r.hours)}">
          <select class="input" data-k="${k}" data-f="grade"><option value="">—</option>${GRADES.map(([g]) => `<option ${r.grade === g ? "selected" : ""}>${g}</option>`).join("")}</select><button class="link" data-rm="${k}">✕</button></div>`).join("")}
        <button class="btn block" id="gadd">+ مادة</button></div>
      <h2>المعدل السابق</h2><div class="card gp-two"><div class="field"><label>التراكمي قبل هالفصل</label><input class="input" id="pg" type="number" step="0.01" min="0" max="4" value="${esc(st.prevGpa)}"></div>
        <div class="field"><label>الساعات المقطوعة</label><input class="input" id="ph" type="number" min="0" value="${esc(st.prevHours)}"></div></div>
      <h2>بدي أوصل لمعدل</h2><div class="card"><input class="input" id="tg" type="number" step="0.01" min="0" max="4" placeholder="مثلاً 3.0" value="${esc(st.target)}">
        ${need !== null ? `<p style="margin:10px 0 0" dir="auto">${need > 4 ? "😬 صعب توصل لهاد المعدل هالفصل، حتى لو جبت A بكل المواد." : need <= 0.5 ? "✓ أصلاً واصل، حافظ عليه." : `لازم تجيب معدل فصلي <b>${need.toFixed(2)}</b> تقريباً (يعني حوالي <b>${(GRADES.find(([, p]) => p <= need + 0.001) || GRADES[0])[0]}</b> وفوق بالمعدل).`}</p>` : ""}</div>
      <p class="small muted">النقاط حسب نظام ٤: A=4 … F=0.5. إذا نظام جامعتك مختلف شوي، النتيجة تقريبية.</p></div>`;
    $app.querySelectorAll("[data-f]").forEach(i => i.onchange = () => { st.rows[+i.dataset.k][i.dataset.f] = i.value; S.set("gpa", st); draw(); });
    $app.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { st.rows.splice(+b.dataset.rm, 1); S.set("gpa", st); draw(); });
    document.getElementById("gadd").onclick = () => { st.rows.push({ name: "", hours: 3, grade: "" }); S.set("gpa", st); draw(); };
    [["pg", "prevGpa"], ["ph", "prevHours"], ["tg", "target"]].forEach(([el, k]) => document.getElementById(el).onchange = e => { st[k] = e.target.value; S.set("gpa", st); draw(); });
  };
  draw();
};

/* ======================= 6) study timer (pomodoro) ======================= */
function timerState() { return S.get("timer", { mode: "focus", focus: 25, brk: 5, endAt: 0, pausedLeft: 0, course: "" }); }
function studyLog() { return S.get("studylog", {}); } // {"YYYY-MM-DD": {total: minutes, byCourse: {name: minutes}}}
function logMinutes(min, course) { const l = studyLog(), d = ymd(Date.now()); l[d] = l[d] || { total: 0, byCourse: {} }; l[d].total += min; if (course) l[d].byCourse[course] = (l[d].byCourse[course] || 0) + min; S.set("studylog", l); }
function streak() { const l = studyLog(), ok = d => l[ymd(d)] && l[ymd(d)].total >= 10; let n = 0; const d = new Date(); if (!ok(d)) d.setDate(d.getDate() - 1); while (ok(d) && n < 999) { n++; d.setDate(d.getDate() - 1); } return n; }
let timerIv = null;
routes.timer = async () => {
  const draw = () => {
    const t = timerState(), running = t.endAt > Date.now();
    const total = (t.mode === "focus" ? t.focus : t.brk) * 60000;
    const leftMs = running ? t.endAt - Date.now() : (t.pausedLeft || total);
    const pct = 1 - leftMs / total, mm = Math.floor(leftMs / 60000), ss = Math.floor(leftMs / 1000) % 60;
    const l = studyLog(), today = (l[ymd(Date.now())] || { total: 0 }).total;
    const week = Array.from({ length: 7 }, (_, k) => { const d = new Date(); d.setDate(d.getDate() - 6 + k); return { d, m: (l[ymd(d)] || { total: 0 }).total }; });
    const maxM = Math.max(30, ...week.map(x => x.m));
    $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button><span class="pill ok">🔥 ${streak()} يوم</span></div>
      <h1 style="margin:0 0 4px;font-size:22px">⏱️ مؤقت الدراسة</h1>
      <div class="seg" id="tmode" style="margin:10px 0"><button data-m="focus" class="${t.mode === "focus" ? "on" : ""}">📚 دراسة ${t.focus}د</button><button data-m="break" class="${t.mode === "break" ? "on" : ""}">☕ استراحة ${t.brk}د</button></div>
      <div class="tring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="tr-bg"/><circle cx="60" cy="60" r="52" class="tr-fg" style="stroke-dasharray:${2 * Math.PI * 52};stroke-dashoffset:${2 * Math.PI * 52 * (1 - pct)}"/></svg>
        <div class="tnum">${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}</div></div>
      <select class="input" id="tcourse" style="margin:10px 0"><option value="">بدون مادة</option>${(data ? data.courses : []).map(c => `<option ${t.course === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <div class="btns" style="justify-content:center"><button class="btn primary" id="tgo" style="min-width:130px">${running ? "⏸ وقّف" : "▶ ابدأ"}</button><button class="btn" id="treset">↺</button></div>
      <h2>اليوم: ${today} دقيقة</h2>
      <div class="card"><div class="wbars">${week.map(x => `<div><i style="height:${Math.round(x.m / maxM * 100)}%"></i><span>${x.d.toLocaleDateString("ar-JO", { weekday: "narrow" })}</span><b>${x.m || ""}</b></div>`).join("")}</div></div>
      <div class="card gp-two"><div class="field"><label>دقايق الدراسة</label><input class="input" type="number" id="tf" value="${t.focus}" min="5" max="120"></div><div class="field"><label>دقايق الاستراحة</label><input class="input" type="number" id="tb" value="${t.brk}" min="1" max="30"></div></div></div>`;
    document.getElementById("tgo").onclick = () => {
      const s = timerState();
      if (s.endAt > Date.now()) { s.pausedLeft = s.endAt - Date.now(); s.endAt = 0; }
      else { s.endAt = Date.now() + (s.pausedLeft || (s.mode === "focus" ? s.focus : s.brk) * 60000); s.pausedLeft = 0; if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); }
      S.set("timer", s); buzz(); draw();
    };
    document.getElementById("treset").onclick = () => { const s = timerState(); s.endAt = 0; s.pausedLeft = 0; S.set("timer", s); draw(); };
    document.getElementById("tmode").onclick = e => { const b = e.target.closest("button"); if (!b) return; const s = timerState(); s.mode = b.dataset.m; s.endAt = 0; s.pausedLeft = 0; S.set("timer", s); draw(); };
    document.getElementById("tcourse").onchange = e => { const s = timerState(); s.course = e.target.value; S.set("timer", s); };
    document.getElementById("tf").onchange = e => { const s = timerState(); s.focus = Math.max(5, +e.target.value || 25); S.set("timer", s); draw(); };
    document.getElementById("tb").onchange = e => { const s = timerState(); s.brk = Math.max(1, +e.target.value || 5); S.set("timer", s); draw(); };
  };
  draw();
  clearInterval(timerIv);
  timerIv = setInterval(() => { if (location.hash !== "#timer") { clearInterval(timerIv); return; } const n = document.querySelector(".tnum"); if (n && timerState().endAt > Date.now()) draw(); }, 1000);
};
// finishes even if you left the page
setInterval(() => {
  const t = timerState(); if (!t.endAt || t.endAt > Date.now()) return;
  const wasFocus = t.mode === "focus";
  if (wasFocus) logMinutes(t.focus, t.course);
  t.mode = wasFocus ? "break" : "focus"; t.endAt = 0; t.pausedLeft = 0; S.set("timer", t);
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
  const title = wasFocus ? "🎉 خلصت جلسة دراسة!" : "☕ خلصت الاستراحة";
  const body = wasFocus ? `+${t.focus} دقيقة. خذ استراحة ${t.brk} دقايق.` : "يلا نرجع للدراسة 💪";
  if ("Notification" in window && Notification.permission === "granted") navigator.serviceWorker?.getRegistration().then(reg => reg ? reg.showNotification(title, { body, icon: "icons/icon-192.png", tag: "timer", data: { url: "./#timer" } }).catch(() => toast(title)) : toast(title));
  else toast(title, 4000);
  if (location.hash === "#timer") routes.timer();
}, 1000);

/* ======================= 7) challenge a friend ======================= */
window.makeChallenge = async (qs, score, title) => {
  const name = ((Moodle.session && Moodle.session.fullname) || "صاحبك").split(" ")[0];
  const code = await pack({ n: name, s: score, t: title || "كويز", q: qs.map(q => ({ q: q.q, o: q.options, a: +q.answer, w: q.why || "" })) });
  const url = location.origin + location.pathname + "#ch-" + code;
  shareOrCopy({ title: "⚔️ تحدّي", text: `${name} جاب ${score}/${qs.length} بـ "${title || "كويز"}" 🔥 فكّرك بتغلبه؟`, url });
};
routes.ch = async (code) => {
  $tabbar.hidden = true; document.body.classList.add("no-tabs");
  let c; try { c = await unpack(code); } catch { $app.innerHTML = `<div class="page"><div class="err">رابط التحدي خربان.</div></div>`; return; }
  const qs = c.q.map(x => ({ q: x.q, options: x.o, answer: x.a, why: x.w }));
  $app.innerHTML = `<div class="page enter" style="max-width:560px">
    <div class="card" style="text-align:center"><div style="font-size:46px">⚔️</div><h2 style="color:var(--ink);font-size:20px;margin:6px 0">${esc(c.n)} بتحدّاك!</h2>
      <p class="muted" style="margin:0">جاب <b>${c.s}/${qs.length}</b> بـ «${esc(c.t)}». فكّرك بتغلبه؟</p></div><div id="chq"></div>
    <p class="small muted" style="text-align:center;margin-top:16px">من تطبيق <b>واجباتي</b> 📚</p></div>`;
  renderQuiz(document.getElementById("chq"), qs, "تحدّي", { title: c.t, onDone: (score) => {
    const win = score > c.s, tie = score === c.s;
    const el = document.getElementById("chq");
    el.insertAdjacentHTML("afterbegin", `<div class="card" style="text-align:center"><div style="font-size:40px">${win ? "🏆" : tie ? "🤝" : "😅"}</div><b>${win ? "غلبته!" : tie ? "تعادل!" : "غلبك هالمرة"}</b><p class="muted">إنت ${score} · ${esc(c.n)} ${c.s}</p>
      <button class="btn primary" id="chback">↩ ردّ التحدي</button></div>`);
    document.getElementById("chback").onclick = () => makeChallenge(qs, score, c.t);
  } });
};

/* ======================= 8) voice review ======================= */
routes.vreview = async () => {
  const cards = (srsDue().length ? srsDue() : srsAll().slice(-20)).sort(() => Math.random() - .5).slice(0, 15);
  if (!cards.length) { $app.innerHTML = `<div class="page"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div><div class="card" style="text-align:center"><div style="font-size:40px">🎧</div><b>ما في بطاقات لسا</b><p class="muted">اعمل بطاقات من أي ملف وبعدين ارجع هون.</p></div></div>`; return; }
  let i = 0, alive = true, score = 0, rec = null;
  const synth = window.speechSynthesis; synth && synth.getVoices();
  $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" id="vrx">→ رجوع</button><span class="pill ok" id="vrs">0/${cards.length}</span></div>
    <h1 style="margin:0 0 12px;font-size:22px">🎧 مراجعة صوتية</h1>
    <div class="call vr"><button class="orb" id="vorb"><span></span></button><div class="call-state" id="vst">اكبس الدائرة عشان نبلّش</div><div class="call-text" id="vq" dir="auto"></div><div class="call-text small" id="va" dir="auto"></div></div>
    <div class="btns" style="justify-content:center" id="vself" hidden><button class="btn" data-g="0">🔁 ما عرفت</button><button class="btn primary" data-g="1">✓ عرفت</button></div></div>`;
  const box = $app.querySelector(".vr"), st = document.getElementById("vst"), qEl = document.getElementById("vq"), aEl = document.getElementById("va");
  const set = (m, t) => { box.dataset.mode = m; st.textContent = t; };
  const say = (text) => new Promise(res => { if (!synth) return setTimeout(res, 1500); try { synth.cancel(); } catch {} const u = new SpeechSynthesisUtterance(text.replace(/[*#`]/g, "")); const vs = synth.getVoices(); const latin = (text.match(/[a-z]/gi) || []).length > text.length * .5; const v = (latin ? vs.find(x => /^en/i.test(x.lang)) : vs.find(x => /^ar/i.test(x.lang))) || vs.find(x => /^ar/i.test(x.lang)); if (v) { u.voice = v; u.lang = v.lang; } u.rate = 1.05; u.onend = res; u.onerror = res; synth.speak(u); });
  const listen = () => new Promise(res => { if (!SR) return res(null); const r = new SR(); rec = r; r.lang = srLang(); r.interimResults = true; let fin = ""; r.onresult = e => { const t = [...e.results].map(x => x[0].transcript).join(" "); aEl.textContent = "🗣️ " + t; if (e.results[e.results.length - 1].isFinal) fin = t; }; r.onend = () => res(fin); r.onerror = () => res(""); r.start(); });
  const grade = async (c, ans) => {
    if (!AI.ready()) return { correct: false, feedback: "" };
    try { const t = await AI.chat({ system: "قيّم جواب طالب بسرعة. لهجة أردنية.", depth: "fast", json: true, messages: [{ role: "user", text: `السؤال: ${c.q}\nالجواب الصح: ${c.a}\nجواب الطالب: ${ans}\nرجّع JSON: {"correct":true/false,"feedback":"جملة قصيرة بتوضّح"}` }], onText: () => {} }); return Study.parseJSON(t); } catch { return { correct: false, feedback: "" }; }
  };
  const next = async () => {
    if (!alive) return;
    if (i >= cards.length) { set("idle", `خلصنا! عرفت ${score} من ${cards.length} 🎉`); qEl.textContent = ""; aEl.textContent = ""; await say(`خلصنا! عرفت ${score} من ${cards.length}`); if (score / cards.length >= .8) confetti(); return; }
    const c = cards[i]; document.getElementById("vrs").textContent = `${i}/${cards.length}`;
    qEl.textContent = c.q; aEl.textContent = ""; set("speak", "بسألك…"); await say(c.q); if (!alive) return;
    if (!SR) { set("idle", "فكّر بالجواب، وبعدين اكبس الدائرة عشان تشوفه"); box.dataset.wait = "reveal"; return; }
    set("listen", "بسمعك… جاوب"); const ans = await listen(); if (!alive) return;
    if (!ans) { aEl.textContent = "الجواب: " + c.a; set("speak", "الجواب…"); await say("الجواب هو " + c.a); srsGrade(c.q, c.a, false, c.src); i++; return next(); }
    set("think", "بشيك جوابك…"); const g = await grade(c, ans); if (!alive) return;
    if (g.correct) score++; srsGrade(c.q, c.a, !!g.correct, c.src);
    aEl.innerHTML = `${g.correct ? "✅" : "❌"} ${esc(g.feedback || "")}<br><span class="small">الجواب: ${esc(c.a)}</span>`;
    set("speak", g.correct ? "صح!" : "مش زابط"); try { navigator.vibrate && navigator.vibrate(g.correct ? 20 : [40, 40, 40]); } catch {}
    await say((g.correct ? "صح! " : "لأ. ") + (g.feedback || "") + (g.correct ? "" : " الجواب: " + c.a));
    i++; next();
  };
  document.getElementById("vorb").onclick = () => {
    buzz();
    if (box.dataset.wait === "reveal") { box.dataset.wait = ""; aEl.textContent = "الجواب: " + cards[i].a; document.getElementById("vself").hidden = false; return; }
    if (box.dataset.mode === "listen") { try { rec && rec.stop(); } catch {} return; }
    if (!box.dataset.mode || box.dataset.mode === "idle") next();
  };
  document.getElementById("vself").onclick = e => { const b = e.target.closest("[data-g]"); if (!b) return; const ok = b.dataset.g === "1"; if (ok) score++; srsGrade(cards[i].q, cards[i].a, ok, cards[i].src); e.currentTarget.hidden = true; i++; next(); };
  const stop = () => { alive = false; try { synth && synth.cancel(); } catch {} try { rec && rec.abort(); } catch {} };
  document.getElementById("vrx").onclick = () => { stop(); history.back(); };
  window.addEventListener("hashchange", stop, { once: true });
};

/* ======================= 9) share summaries as an image ======================= */
let h2cP = null;
function loadH2C() { if (window.html2canvas) return Promise.resolve(window.html2canvas); return h2cP || (h2cP = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"; sc.onload = () => res(window.html2canvas); sc.onerror = rej; document.head.appendChild(sc); })); }
window.shareCard = async (el, title) => {
  buzz(); toast("بجهّز الصورة…");
  try {
    const h2c = await loadH2C();
    const wrap = document.createElement("div"); wrap.className = "sharewrap"; wrap.dir = "rtl";
    wrap.innerHTML = `<div class="sharehead">📚 ${esc(title || "واجباتي")}</div>`; const clone = el.cloneNode(true); clone.querySelectorAll("button.link,.redo").forEach(b => b.remove()); wrap.appendChild(clone);
    wrap.insertAdjacentHTML("beforeend", `<div class="sharefoot">واجباتي · مساعدك الدراسي الذكي</div>`);
    document.body.appendChild(wrap);
    const canvas = await h2c(wrap, { backgroundColor: getComputedStyle(document.body).backgroundColor, scale: 2, useCORS: true });
    wrap.remove();
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const file = new File([blob], (title || "ملخص").replace(/[\\/:*?"<>|]/g, "") + ".png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { if (e && e.name === "AbortError") return; toast("ما زبطت الصورة، جرّب كمان مرة"); }
};

/* ======================= hook into the rest of the app ======================= */
// home shortcuts row
function homeExtras() {
  const ex = Object.entries(exams()).filter(([, e]) => e.date && daysLeft(e.date) >= 0).sort((a, b) => a[1].date - b[1].date);
  return `${ex.length ? ex.map(([id, e]) => `<button class="card planbtn" onclick="go('exam-${id}')"><span>📅</span><div><b>امتحان ${esc(courseName(id))}</b><div class="small muted">باقي ${daysLeft(e.date)} يوم${e.plan ? " · افتح خطة اليوم" : ""}</div></div></button>`).join("") : ""}
    <div class="quick">
      <button onclick="snapSolve()"><span>📸</span>صوّر سؤال</button>
      <button onclick="go('timer')"><span>⏱️</span>مؤقت</button>
      <button onclick="go('vreview')"><span>🎧</span>مراجعة صوتية</button>
      <button onclick="go('gpa')"><span>🎓</span>المعدل</button>
    </div>`;
}
window.homeExtras = homeExtras;
window.featureTools = () => [
  { name: "get_my_notes", description: "Read the student's own saved notes for each course.", label: () => "بقرأ ملاحظاتك…", execute: async () => ({ notes: await allNotes() }) },
  { name: "get_exams", description: "The student's upcoming exams (dates) and their study-plan progress.", label: () => "بشوف امتحاناتك…",
    execute: async () => ({ exams: Object.entries(exams()).filter(([, e]) => e.date).map(([id, e]) => ({ course: courseName(id), date: new Date(e.date).toISOString(), days_left: daysLeft(e.date), scope: e.scope || "", today_tasks: e.plan ? (e.plan.days.find(d => d.date === ymd(Date.now())) || { tasks: [] }).tasks.map(t => t.text) : [] })) }) },
  { name: "get_study_time", description: "How many minutes the student studied per day this week (from the study timer) and their streak.", label: () => "بشوف وقت دراستك…",
    execute: async () => ({ streak_days: streak(), log: studyLog() }) }
];
examReminder();
// direct links to feature pages (e.g. a challenge link) need the routes above, so route again now
if (/^#(exam|cquiz|notes|gpa|timer|ch|vreview)/.test(location.hash)) route();
