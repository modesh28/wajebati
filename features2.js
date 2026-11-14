/* واجباتي — grades + alerts, search across all files, coding trainer. Uses helpers from app.js / features.js. */

/* ======================= grades & alerts ======================= */
async function fetchGrades() {
  if (!Moodle.session || !data) return null;
  const out = {};
  await Promise.all(data.courses.map(async c => {
    try {
      const r = await Moodle.call("gradereport_user_get_grade_items", { courseid: c.id, userid: Moodle.session.userid });
      const items = ((r.usergrades && r.usergrades[0] && r.usergrades[0].gradeitems) || []).filter(g => g.itemtype !== "course" || true);
      out[c.id] = items.map(g => ({
        id: g.id, name: g.itemname || (g.itemtype === "course" ? "المجموع" : "—"), type: g.itemtype, module: g.itemmodule, instance: g.iteminstance,
        grade: g.gradeformatted, raw: g.graderaw, min: g.grademin, max: g.grademax, pct: g.percentageformatted,
        feedback: (g.feedback || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      }));
    } catch { /* grades hidden for this course */ }
  }));
  return out;
}
async function checkGrades(force) {
  const last = S.get("grades.t", 0);
  if (!force && Date.now() - last < 30 * 60000) return S.get("grades", null);
  const g = await fetchGrades(); if (!g) return null;
  const prev = S.get("grades", null);
  S.set("grades", g); S.set("grades.t", Date.now());
  if (prev && "Notification" in window && Notification.permission === "granted") {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const [cid, items] of Object.entries(g)) for (const it of items) {
      if (it.type === "course" || it.raw === null || it.raw === undefined) continue;
      const old = (prev[cid] || []).find(x => x.id === it.id);
      const fbNew = it.feedback && (!old || old.feedback !== it.feedback);
      if (!old || old.raw === null || old.raw === undefined || old.raw !== it.raw || fbNew) {
        const t = old && old.raw !== null && old.raw !== undefined && old.raw !== it.raw ? "تعدّلت علامة" : fbNew && old && old.raw === it.raw ? "ملاحظة جديدة من الدكتور" : "نزلت علامة";
        reg && reg.showNotification(`🎯 ${t}: ${it.name}`, { body: `${courseName(cid)} — ${it.grade}${it.max ? " من " + Math.round(it.max) : ""}${it.feedback ? "\n" + it.feedback.slice(0, 120) : ""}`, icon: "icons/icon-192.png", tag: "grade-" + it.id, data: { url: "./#grades" } });
      }
    }
  }
  return g;
}
routes.grades = async () => {
  await ensureData();
  const draw = (g, loading) => {
    $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button><button class="back" id="grf">↻ تحديث</button></div>
      <h1 style="margin:0 0 12px;font-size:22px">🎯 علاماتي</h1>
      ${!g ? (loading ? skel(4) : `<div class="empty">ما قدرت أجيب العلامات</div>`) : data.courses.map(c => {
        const items = (g[c.id] || []).filter(x => x.type !== "category");
        const total = items.find(x => x.type === "course");
        const rest = items.filter(x => x.type !== "course" && x.raw !== null && x.raw !== undefined);
        return `<div class="card"><div class="bhead"><span dir="auto">${esc(c.name)}</span>${total && total.raw != null ? `<span class="pill ok">${esc(total.grade)}${total.pct && total.pct !== "-" ? " · " + esc(total.pct) : ""}</span>` : ""}</div>
          ${rest.length ? rest.map(x => `<div class="grow"><div><div dir="auto">${esc(x.name)}</div>${x.feedback ? `<div class="small muted" dir="auto">💬 ${esc(x.feedback)}</div>` : ""}</div><b dir="ltr">${esc(x.grade)}${x.max ? `<span class="small muted"> / ${Math.round(x.max)}</span>` : ""}</b></div>`).join("") : `<div class="small muted">ما نزل علامات لسا</div>`}</div>`;
      }).join("")}
      <p class="small muted">بنبّهك أول ما تنزل علامة أو ملاحظة جديدة (إذا الإشعارات شغّالة).</p></div>`;
    document.getElementById("grf").onclick = async () => { draw(null, true); draw(await checkGrades(true)); buzz(); };
  };
  const cached = S.get("grades", null);
  draw(cached, true);
  const g = await checkGrades(!cached); if (location.hash === "#grades") draw(g);
};

/* ======================= search across all my files ======================= */
let pdfjsP = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return pdfjsP || (pdfjsP = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    sc.onload = () => { if (!window.pdfjsLib) { pdfjsP = null; return rej(new Error("pdf.js")); } window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; res(window.pdfjsLib); };
    sc.onerror = () => { pdfjsP = null; rej(new Error("pdf.js")); }; document.head.appendChild(sc); }));
}
async function pdfText(b64) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)) }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 300); i++) { const p = await doc.getPage(i); const tc = await p.getTextContent(); pages.push(tc.items.map(x => x.str).join(" ")); }
  return pages;
}
// searchable text for a file: list of {page, text}
async function fileTextIndex(f) {
  const key = "txt:" + Study.fkey(f);
  const have = await KV.get(key); if (have) return have;
  const d = await Study.load(f);
  let pages;
  if (d.kind === "pdf") pages = await pdfText(d.data);
  else if (d.kind === "text") pages = d.data.split(/--- Slide \d+ ---/).filter(x => x.trim()).length > 1 ? d.data.split(/--- Slide \d+ ---/).slice(1) : [d.data];
  else pages = [];
  const idx = pages.map((t, i) => ({ page: i + 1, text: t.replace(/\s+/g, " ").trim() })).filter(x => x.text);
  KV.set(key, idx); return idx;
}
const normAr = t => String(t || "").toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ْ]/g, "");
routes.search = async () => {
  await ensureData();
  $app.innerHTML = `<div class="page enter"><div class="top"><h1>🔎 بحث</h1></div>
    <form id="sf" class="composer" style="position:static;padding:0 0 10px"><div class="bar"><input class="input" id="sq" placeholder="ابحث بكل ملفاتك وملاحظاتك… مثلاً Deadlock" dir="auto" style="border:0;background:transparent"><button class="iconbtn send">↑</button></div></form>
    <div id="sidx" class="small muted"></div><div id="sres"></div></div>`;
  const status = document.getElementById("sidx");
  const allFiles = async () => { const out = []; for (const c of data.courses) { try { (await courseFiles(c.id)).forEach((f, i) => out.push({ ...f, courseid: c.id, course: c.name, num: i + 1 })); } catch {} } return out; };
  const indexedCount = async (files) => { let n = 0; for (const f of files) if (await KV.get("txt:" + Study.fkey(f))) n++; return n; };
  let files = await allFiles();
  const showIdx = async () => { const n = await indexedCount(files); status.innerHTML = `${n} من ${files.length} ملف جاهز للبحث جوّاه ${n < files.length ? `· <button class="link" id="doidx">جهّز الكل</button>` : "✓"}`;
    const b = document.getElementById("doidx"); if (b) b.onclick = async () => { b.remove(); let k = 0; for (const f of files) { status.textContent = `بجهّز الملفات… ${++k}/${files.length}`; if (Study.studyable(Study.kindOf(f))) { try { await fileTextIndex(f); } catch {} } } showIdx(); }; };
  showIdx();
  document.getElementById("sf").onsubmit = async e => {
    e.preventDefault(); const q = document.getElementById("sq").value.trim(); if (!q) return; buzz();
    const nq = normAr(q), words = nq.split(/\s+/).filter(w => w.length > 1);
    const res = document.getElementById("sres"); res.innerHTML = skel(3);
    const hits = [];
    const score = t => { const n = normAr(t); let s = 0; for (const w of words) { const c = n.split(w).length - 1; s += c; } return s; };
    const snippet = t => { const n = normAr(t); const p = Math.max(0, n.indexOf(words[0] || nq) - 60); return (p ? "…" : "") + t.slice(p, p + 180) + "…"; };
    for (const f of files) {
      const ts = score(f.title + " " + f.filename); if (ts) hits.push({ kind: "file", f, s: ts * 3, text: f.title });
      const idx = await KV.get("txt:" + Study.fkey(f));
      if (idx) for (const pg of idx) { const s = score(pg.text); if (s) hits.push({ kind: "page", f, page: pg.page, s, text: snippet(pg.text) }); }
    }
    for (const it of data.items) { const s = score(it.name + " " + (it.intro || "").replace(/<[^>]+>/g, " ")); if (s) hits.push({ kind: "work", it, s: s * 2 }); }
    for (const n of await allNotes()) n.notes.forEach(t => { const s = score(t); if (s) hits.push({ kind: "note", course: n.course, s, text: t }); });
    hits.sort((a, b) => b.s - a.s);
    res.innerHTML = (hits.length ? hits.slice(0, 40).map(h => h.kind === "work" ? `<div class="card item" onclick="go('${h.it.kind}-${h.it.id}')"><div class="ic">${h.it.kind === "quiz" ? "📝" : "📄"}</div><div class="body"><div class="course">${esc(h.it.coursename)}</div><div class="title" dir="auto">${esc(h.it.name)}</div></div></div>`
      : h.kind === "note" ? `<div class="card"><div class="small muted">📒 ملاحظة · ${esc(h.course)}</div><div dir="auto">${esc(h.text)}</div></div>`
      : `<div class="card item" onclick="go('study-${h.f.courseid}.${h.f.cmid}.${h.f.idx}')"><div class="ic file-${Study.kindOf(h.f)}">${Study.icon(Study.kindOf(h.f))}<span class="num">${h.f.num}</span></div>
          <div class="body"><div class="course">${esc(h.f.course)}${h.page ? ` · ${Study.kindOf(h.f) === "pptx" ? "سلايد" : "صفحة"} ${h.page}` : ""}</div><div class="title" dir="auto">${esc(h.f.title)}</div>${h.kind === "page" ? `<div class="due" dir="auto" style="white-space:normal">${esc(h.text)}</div>` : ""}</div></div>`).join("")
      : `<div class="empty">ما لقيت «${esc(q)}» بالملفات الجاهزة.</div>`) +
      (AI.ready() ? `<button class="card planbtn" id="askai"><span>✨</span><div><b>خلّي المساعد يدوّر ويشرحلك «${esc(q)}»</b><div class="small muted">بيفتح الملفات المناسبة وبيشرح منها</div></div></button>` : "");
    const ab = document.getElementById("askai"); if (ab) ab.onclick = () => { aiDraft = `دوّرلي على «${q}» بملفات موادي، وقلّي وين انشرح (المادة ورقم الملف)، واشرحلي إياه من الصفر.`; go("ai"); setTimeout(() => { const c = document.getElementById("composer"); c && c.requestSubmit(); }, 350); };
  };
  document.getElementById("sq").focus();
};

/* ======================= coding trainer ======================= */
let pyodideP = null;
function loadPyodide2() {
  if (window.__py) return Promise.resolve(window.__py);
  return pyodideP || (pyodideP = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
    sc.onload = async () => { try { window.__py = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" }); res(window.__py); } catch (e) { rej(e); } }; sc.onerror = rej; document.head.appendChild(sc); }));
}
// real SQL (SQLite in the browser) with a ready sample database
let sqlP = null, sqlDb = null;
function loadSql() {
  if (sqlDb) return Promise.resolve(sqlDb);
  return sqlP || (sqlP = new Promise((res, rej) => {
    const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js";
    sc.onload = async () => { try { const SQL = await window.initSqlJs({ locateFile: f => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/" + f }); sqlDb = new SQL.Database(); sqlDb.run(SAMPLE_DB); res(sqlDb); } catch (e) { sqlP = null; rej(e); } };
    sc.onerror = () => { sqlP = null; rej(new Error("sql")); }; document.head.appendChild(sc);
  }));
}
const SAMPLE_DB = `
CREATE TABLE students(id INTEGER PRIMARY KEY, name TEXT, major TEXT, year INTEGER, gpa REAL);
INSERT INTO students VALUES (1,'Ahmad','CS',5,3.4),(2,'Sara','IS',4,3.8),(3,'Omar','CS',3,2.9),(4,'Lina','SE',5,3.1),(5,'Yazan','IS',2,2.5),(6,'Rama','CS',4,3.9);
CREATE TABLE courses(id INTEGER PRIMARY KEY, title TEXT, credits INTEGER);
INSERT INTO courses VALUES (101,'Databases',3),(102,'Networks',3),(103,'Software Engineering',3),(104,'Information Retrieval',3);
CREATE TABLE enrollments(student_id INTEGER, course_id INTEGER, grade INTEGER);
INSERT INTO enrollments VALUES (1,101,85),(1,103,78),(2,101,95),(2,104,88),(3,102,64),(4,103,90),(5,101,55),(6,104,97),(6,102,91);`;
const CODE_LANGS = { python: "Python", javascript: "JavaScript", java: "Java", cpp: "C++", c: "C", sql: "SQL" };
const SAMPLES = {
  python: 'stack = []\nfor x in [1, 2, 3]:\n    stack.append(x)\nprint("pop:", stack.pop())\nprint("stack:", stack)\n',
  javascript: 'const q = [];\nq.push(1); q.push(2);\nconsole.log("dequeue:", q.shift());\nconsole.log(q);\n',
  java: 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello BAU!");\n  }\n}\n',
  cpp: '#include <iostream>\nusing namespace std;\nint main() {\n  cout << "Hello BAU!" << endl;\n  return 0;\n}\n',
  c: '#include <stdio.h>\nint main() {\n  printf("Hello BAU!\\n");\n  return 0;\n}\n',
  sql: '-- جداول جاهزة: students, courses, enrollments\nSELECT s.name, c.title, e.grade\nFROM enrollments e\nJOIN students s ON s.id = e.student_id\nJOIN courses c ON c.id = e.course_id\nWHERE e.grade > 80\nORDER BY e.grade DESC;\n'
};
routes.code = async () => {
  const st = S.get("code", { lang: "python", src: {} });
  const src = () => st.src[st.lang] ?? SAMPLES[st.lang];
  $app.innerHTML = `<div class="page enter"><div class="top"><h1>💻 مدرّب البرمجة</h1></div>
    <div class="seg" id="clang" style="margin-bottom:10px;overflow:auto">${Object.entries(CODE_LANGS).map(([k, v]) => `<button data-l="${k}" class="${st.lang === k ? "on" : ""}">${v}</button>`).join("")}</div>
    <div class="editor"><pre class="gutter" id="gut"></pre><textarea id="ced" spellcheck="false" autocapitalize="off" autocomplete="off" dir="ltr"></textarea></div>
    <div class="code-btns">
      <button class="btn primary" id="crun">▶ شغّل</button><button class="btn" id="cfix">🐞 صلّحلي</button><button class="btn" id="cexp">💡 اشرحلي</button><button class="btn" id="cch">🎯 تحدّي</button></div>
    <div class="console" id="cout" dir="ltr"><span class="muted">// النتيجة بتطلع هون</span></div>
    ${st.lang === "sql" ? `<p class="small muted">قاعدة بيانات تجريبية جاهزة: <code>students</code>، <code>courses</code>، <code>enrollments</code>. اكتب أي استعلام وجرّب.</p>` : ""}
    <div id="cai"></div></div>`;
  const ed = document.getElementById("ced"), gut = document.getElementById("gut"), out = document.getElementById("cout");
  const lines = () => { gut.textContent = Array.from({ length: ed.value.split("\n").length }, (_, i) => i + 1).join("\n"); };
  ed.value = src(); lines();
  ed.addEventListener("input", () => { st.src[st.lang] = ed.value; S.set("code", st); lines(); });
  ed.addEventListener("scroll", () => { gut.scrollTop = ed.scrollTop; });
  ed.addEventListener("keydown", e => { if (e.key === "Tab") { e.preventDefault(); const s = ed.selectionStart; ed.setRangeText("    ", s, ed.selectionEnd, "end"); ed.dispatchEvent(new Event("input")); } });
  document.getElementById("clang").onclick = e => { const b = e.target.closest("button"); if (!b) return; st.lang = b.dataset.l; S.set("code", st); routes.code(); };
  const print = (t, cls) => { const sp = document.createElement("div"); if (cls) sp.className = cls; sp.textContent = t; out.appendChild(sp); };
  const askAI = async (task) => {
    if (!AI.ready()) { go("settings"); return null; }
    const box = document.getElementById("cai"); box.innerHTML = `<div class="card answer"></div>`; const w = waiter(box.firstChild);
    try {
      const txt = await AI.chat({ system: "إنت مدرّب برمجة شاطر وصبور لطالب جامعي. " + AI.langRule() + " حط الكود دايماً داخل ```" + st.lang + ".", depth: "smart",
        messages: [{ role: "user", text: `${task}\n\nاللغة: ${CODE_LANGS[st.lang]}\nالكود:\n\`\`\`${st.lang}\n${ed.value}\n\`\`\`\n${out.innerText && !out.innerText.startsWith("//") ? "النتيجة/الخطأ لما شغّلته:\n" + out.innerText.slice(0, 3000) : ""}` }],
        onText: t => w.text(t), onStatus: (k, m) => w.status(k, m) });
      box.firstChild.classList.add("msg", "ai"); enhance(box.firstChild);
      // "use this code" buttons on code blocks
      box.querySelectorAll("pre code").forEach(c => { const b = document.createElement("button"); b.className = "link usecode"; b.textContent = "⬆ حط هاد الكود بالمحرّر"; b.onclick = () => { ed.value = c.textContent; ed.dispatchEvent(new Event("input")); ed.scrollIntoView({ behavior: "smooth" }); buzz(); }; c.parentElement.after(b); });
      return txt;
    } catch (e) { w.stop(); box.innerHTML = `<div class="err">${esc(e.message)}</div>`; return null; }
  };
  document.getElementById("crun").onclick = async () => {
    buzz(); out.innerHTML = "";
    if (st.lang === "python") {
      print("⏳ بشغّل Python…", "muted");
      try {
        const py = await loadPyodide2(); out.innerHTML = "";
        py.setStdout({ batched: t => print(t) }); py.setStderr({ batched: t => print(t, "cerr") });
        const inputs = []; py.globals.set("input", (p) => { const v = window.prompt ? (p || "") : ""; inputs.push(v); return v; });
        await py.runPythonAsync(ed.value);
        if (!out.childNodes.length) print("(ما في output)", "muted");
      } catch (e) { print(String(e.message || e).split("\n").slice(-6).join("\n"), "cerr"); }
    } else if (st.lang === "javascript") {
      const fr = document.createElement("iframe"); fr.sandbox = "allow-scripts"; fr.style.display = "none";
      const id = "r" + Math.random().toString(36).slice(2);
      const onMsg = e => { if (!e.data || e.data.id !== id) return; if (e.data.t === "log") print(e.data.v); else if (e.data.t === "err") print(e.data.v, "cerr"); else if (e.data.t === "done") { window.removeEventListener("message", onMsg); fr.remove(); if (!out.childNodes.length) print("(ما في output)", "muted"); } };
      window.addEventListener("message", onMsg);
      fr.srcdoc = `<script>const P=(t,v)=>parent.postMessage({id:${JSON.stringify(id)},t,v},"*");const f=a=>a.map(x=>typeof x==="object"?JSON.stringify(x):String(x)).join(" ");console.log=(...a)=>P("log",f(a));console.error=(...a)=>P("err",f(a));window.onerror=(m,s,l)=>{P("err",m+" (line "+l+")");P("done")};try{${ed.value.replace(/<\/script>/gi, "<\\/script>")}\n}catch(e){P("err",e.name+": "+e.message)}P("done");<\/script>`;
      document.body.appendChild(fr);
      setTimeout(() => { if (document.body.contains(fr)) { print("⏱️ وقّفته (أخذ وقت كثير، يمكن في loop ما بيخلص)", "cerr"); window.removeEventListener("message", onMsg); fr.remove(); } }, 6000);
    } else if (st.lang === "sql") {
      print("⏳ بشغّل SQL…", "muted");
      try {
        const db = await loadSql(); out.innerHTML = "";
        const res = db.exec(ed.value);
        if (!res.length) print("✓ تم (ما في نتائج للعرض)", "muted");
        for (const r of res) {
          const tbl = document.createElement("div"); tbl.className = "tbl";
          tbl.innerHTML = `<table><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr>${r.values.slice(0, 200).map(v => `<tr>${v.map(x => `<td>${esc(x === null ? "NULL" : x)}</td>`).join("")}</tr>`).join("")}</table>`;
          out.appendChild(tbl); print(`(${r.values.length} صف)`, "muted");
        }
      } catch (e) { out.innerHTML = ""; print(String(e.message || e), "cerr"); }
    } else {
      // Java / C / C++ can't run inside the phone browser — the AI traces it like a compiler would
      print("⏳ بتتبّع الكود…", "muted");
      const txt = await askAI(`تصرّف كأنك الـ compiler/الـ runtime: شغّل هاد الكود بعقلك. إذا في خطأ compile اكتبه زي ما بيطلع بالزبط مع رقم السطر. إذا اشتغل، اكتب الـ output الحرفي. رجّع بهاد الشكل بالزبط:
OUTPUT:
\`\`\`
(الناتج أو رسالة الخطأ)
\`\`\`
وبعدين سطرين شرح شو صار.`);
      out.innerHTML = ""; if (txt) { const m = txt.match(/```[\w]*\n?([\s\S]*?)```/); print(m ? m[1].trim() : txt.slice(0, 500), /error|exception|خطأ/i.test(m ? m[1] : "") ? "cerr" : ""); }
    }
  };
  document.getElementById("cfix").onclick = () => { buzz(); askAI("لاقيلي الأخطاء بهاد الكود وصلّحها. لكل خطأ: السطر، شو المشكلة، وليش. وبعدين الكود كامل مصلّح."); };
  document.getElementById("cexp").onclick = () => { buzz(); askAI("اشرحلي هاد الكود سطر سطر من الصفر، وشو الـ output المتوقع وليش، والـ time complexity إذا في."); };
  document.getElementById("cch").onclick = () => { buzz(); askAI(`اعطيني تمرين برمجة واحد بمستوى طالب سنة خامسة نظم حاسوبية${data ? " ومرتبط بموادي: " + data.courses.map(c => c.name).join("، ") : ""}: المطلوب، مثال input/output، وتلميح. لا تعطيني الحل. وحط كود بداية (starter code) فاضي أكمّله.`); };
};

/* ======================= take a quiz inside the app ======================= */
/* ======================= demo quiz (try the quiz screen without a real one) ======================= */
const demoQuiz = (() => {
  const Q = [
    { page: 0, type: "radio", text: "شو هو الـ Stack؟", opts: ["LIFO: آخر عنصر بيدخل أول عنصر بيطلع", "FIFO: أول عنصر بيدخل أول عنصر بيطلع", "شجرة ثنائية", "جدول Hash"], ok: "0" },
    { page: 0, type: "radio", text: "Verification بتجاوب على سؤال: هل بنينا المنتج صح؟", opts: ["صح", "غلط"], ok: "0" },
    { page: 0, type: "check", text: "أي من هدول هياكل بيانات خطّية؟ (اختار كل الإجابات الصحيحة)", opts: ["Array", "Linked List", "Tree", "Queue"], ok: ["0", "1", "3"] },
    { page: 1, type: "text", text: "شو اسم العملية اللي بتشيل آخر عنصر من الـ Stack؟ (كلمة وحدة بالإنجليزي)", ok: "pop" },
    { page: 1, type: "select", text: "وصّل كل مصطلح بمعناه:", rows: [["Inverted Index", 0], ["Stemming", 1], ["Stop words", 2]], choices: ["فهرس من الكلمة للملفات", "رجّع الكلمة لأصلها", "كلمات شائعة بنتجاهلها"] },
    { page: 1, type: "text", text: "إذا عملنا push(5), push(8), pop() — شو العنصر اللي فوق هلأ؟ (رقم)", ok: "5" }
  ];
  let answers = {}, attempt = null, finished = false;
  const nm = (i, k = "answer") => `q99:${i + 1}_${k}`;
  const val = n => answers[n];
  function html(i) {
    const q = Q[i]; let inner = "";
    if (q.type === "radio") inner = `<div class="answer">${q.opts.map((o, k) => `<div class="r${k}"><input type="radio" name="${nm(i)}" value="${k}" id="d${i}_${k}" ${val(nm(i)) === String(k) ? "checked" : ""}><label for="d${i}_${k}">${esc(o)}</label></div>`).join("")}</div>`;
    if (q.type === "check") inner = `<div class="answer">${q.opts.map((o, k) => `<div class="r${k}"><input type="hidden" name="${nm(i, "choice" + k)}" value="0"><input type="checkbox" name="${nm(i, "choice" + k)}" value="1" id="d${i}_${k}" ${val(nm(i, "choice" + k)) === "1" ? "checked" : ""}><label for="d${i}_${k}">${esc(o)}</label></div>`).join("")}</div>`;
    if (q.type === "text") inner = `<div class="ablock"><label>الجواب: <input type="text" name="${nm(i)}" value="${esc(val(nm(i)) || "")}" size="20"></label></div>`;
    if (q.type === "select") inner = `<table class="answer">${q.rows.map(([t], r) => `<tr><td>${esc(t)}</td><td><select name="${nm(i, "sub" + r)}"><option value="">اختار…</option>${q.choices.map((c, k) => `<option value="${k}" ${val(nm(i, "sub" + r)) === String(k) ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></td></tr>`).join("")}</table>`;
    return `<div class="que"><div class="content"><div class="formulation"><input type="hidden" name="q99:${i + 1}_:sequencecheck" value="1"><div class="qtext"><p>${esc(q.text)}</p></div>${inner}</div></div></div>`;
  }
  function right(i) {
    const q = Q[i];
    if (q.type === "radio") return val(nm(i)) === q.ok;
    if (q.type === "check") return q.opts.every((_, k) => (val(nm(i, "choice" + k)) === "1") === q.ok.includes(String(k)));
    if (q.type === "text") return String(val(nm(i)) || "").trim().toLowerCase() === q.ok;
    if (q.type === "select") return q.rows.every(([, okk], r) => val(nm(i, "sub" + r)) === String(okk));
  }
  const merge = d => (d || []).forEach(x => { answers[x.name] = x.value; });
  return {
    reset() { answers = {}; attempt = null; finished = false; },
    async call(fn, p) {
      await new Promise(r => setTimeout(r, 250)); // feels like the real site
      if (fn === "mod_quiz_get_user_attempts") return { attempts: attempt && !finished ? [attempt] : [] };
      if (fn === "mod_quiz_start_attempt") { attempt = { id: "demo", timestart: Math.floor(Date.now() / 1000), currentpage: 0, state: "inprogress" }; return { attempt }; }
      if (fn === "mod_quiz_get_attempt_data") { const pg = p.page || 0; return { questions: Q.map((q, i) => ({ q, i })).filter(x => x.q.page === pg).map(x => ({ number: x.i + 1, maxmark: "1.00", html: html(x.i) })), nextpage: pg < 1 ? pg + 1 : -1 }; }
      if (fn === "mod_quiz_save_attempt") { merge(p.data); return { status: true }; }
      if (fn === "mod_quiz_process_attempt") { merge(p.data); finished = true; return { state: "finished" }; }
      if (fn === "mod_quiz_get_attempt_review") return { grade: `${Q.filter((_, i) => right(i)).length} من ${Q.length}` };
      throw new Error("demo: " + fn);
    },
    reviewHtml() {
      return `<div style="text-align:start;margin:14px 0">${Q.map((q, i) => `<div class="grow"><div dir="auto">${i + 1}. ${esc(q.text)}</div><b>${right(i) ? "✅" : "❌"}</b></div>`).join("")}</div>`;
    }
  };
})();

routes.qattempt = async (quizid) => {
  // already open? just show it again — nothing reloads, the timer never stopped
  if (window.activeQuiz && activeQuiz.id === quizid && document.getElementById("quizlayer")) { showQuizLayer(true); return; }
  closeQuizLayer();
  const QL = document.createElement("div"); QL.id = "quizlayer"; document.getElementById("app").after(QL); showQuizLayer(true);
  const demo = quizid === "demo";
  if (!demo) await ensureData();
  const call = demo ? demoQuiz.call : (fn, params) => Moodle.call(fn, params);
  if (demo && !(window.activeQuiz && activeQuiz.id === "demo")) demoQuiz.reset();
  const q = demo ? { name: "كويز تجريبي 🧪", coursename: "تجربة قبل الإطلاق", timelimit: 300, cmid: null } : data.items.find(i => i.kind === "quiz" && i.id == quizid);
  QL.innerHTML = `<div class="page enter">${skel(3)}</div>`;
  const fail = (msg) => { QL.innerHTML = `<div class="page"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div><div class="err">${esc(msg)}</div>
    ${q && q.cmid ? `<button class="btn primary" onclick="openMoodle('/mod/quiz/view.php?id=${q.cmid}')">افتح الكويز بالإي ليرنينج ↗</button>` : ""}</div>`; };
  let attempt;
  try {
    const un = await call("mod_quiz_get_user_attempts", { quizid, status: "unfinished" });
    attempt = (un.attempts || [])[0];
    if (!attempt) attempt = (await call("mod_quiz_start_attempt", { quizid })).attempt;
  } catch (e) { return fail(/password|preflight/i.test(e.message) ? "هاد الكويز بده كلمة سر، افتحه بالإي ليرنينج." : "ما قدرت أبلّش الكويز: " + e.message); }
  const limit = q && q.timelimit ? q.timelimit : 0, endAt = limit ? (attempt.timestart + limit) * 1000 : (q && q.due ? q.due * 1000 : 0);
  let page = (window.activeQuiz && activeQuiz.id === quizid ? activeQuiz.page : attempt.currentpage) || 0, total = null, timerIv = null, busy = false;
  window.activeQuiz = { id: quizid, name: q ? q.name : "كويز", endAt, page, attemptid: attempt.id, call };
  const collect = () => {
    const out = []; const seen = new Set();
    QL.querySelectorAll(".qform input, .qform select, .qform textarea").forEach(el => {
      if (!el.name) return;
      if ((el.type === "radio" || el.type === "checkbox") && !el.checked) { if (el.type === "checkbox" && !seen.has(el.name)) { /* unchecked box: moodle expects 0 via hidden input */ } return; }
      out.push({ name: el.name, value: el.value }); seen.add(el.name);
    });
    return out;
  };
  const answeredCount = () => { const names = new Set(); QL.querySelectorAll(".qform .que").forEach(qq => { const a = [...qq.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked, input[type=text], select, textarea")].some(el => (el.type === "radio" || el.type === "checkbox") ? true : el.value.trim() && el.value !== "0" && el.value !== ""); if (a) names.add(qq); }); return names.size; };
  async function show(p) {
    busy = true;
    let d; try { d = await call("mod_quiz_get_attempt_data", { attemptid: attempt.id, page: p }); } catch (e) { busy = false; return fail("ما قدرت أجيب الأسئلة: " + e.message); }
    page = p; busy = false; if (window.activeQuiz) activeQuiz.page = p;
    const qs = d.questions || [];
    QL.innerHTML = `<div class="page enter">
      <div class="top"><button class="back" id="qx">→ رجوع</button>${endAt ? `<span class="pill soon" id="qtime"></span>` : ""}</div>
      <div class="small muted" dir="auto">${esc(q ? q.coursename : "")}</div><h1 style="margin:0 0 12px;font-size:20px" dir="auto">${esc(q ? q.name : "كويز")}</h1>
      <form class="qform" onsubmit="return false">${qs.map(x => `<div class="card qcard"><div class="small muted">سؤال ${x.number || ""}${x.maxmark ? ` · ${x.maxmark} علامة` : ""}</div><div class="qhtml">${Moodle.rewriteHtml(x.html)}</div>${demo && AI.ready() ? `<button type="button" class="link hintbtn" data-hint="${x.number}">💡 تلميح</button><div class="hb"></div>` : ""}</div>`).join("")}</form>
      <div class="btns" style="justify-content:space-between">
        ${p > 0 ? `<button class="btn" id="qprev">→ السابق</button>` : "<span></span>"}
        ${d.nextpage !== -1 ? `<button class="btn primary" id="qnext">التالي ←</button>` : `<button class="btn primary" id="qfin">✓ سلّم الكويز</button>`}
      </div>
      <p class="small muted">إجاباتك بتنحفظ كل ما تنقل لصفحة ثانية.</p></div>`;
    // tidy Moodle's question markup
    QL.querySelectorAll(".qhtml .info, .qhtml .questionflag, .qhtml script, .qhtml .accesshide.question_number").forEach(n => n.remove());
    // no "Check" button: answers are only judged when the whole quiz is handed in
    QL.querySelectorAll(".qhtml .im-controls, .qhtml input[type=submit], .qhtml button[type=submit]").forEach(n => n.remove());
    QL.querySelectorAll(".qhtml p, .qhtml label, .qhtml .qtext, .qhtml li, .qhtml td").forEach(n => n.dir = "auto");
    QL.querySelectorAll("[data-hint]").forEach(b => b.onclick = () => { const card = b.closest(".qcard"); const qt = card.querySelector(".qtext"); const opts = [...card.querySelectorAll(".answer label, .answer option")].map(o => o.textContent.trim()).filter(x => x && x !== "اختار…"); aiHint(qt ? qt.textContent : "", opts, b.nextElementSibling, b); });
    QL.querySelectorAll(".qhtml input[type=radio], .qhtml input[type=checkbox]").forEach(i => { const lab = i.closest("div,label"); lab && lab.classList.add("qopt"); });
    const unsupported = QL.querySelectorAll(".qhtml .ddarea, .qhtml .drags, .qhtml .ddmarker, .qhtml .ddwtos").length;
    if (unsupported) QL.querySelector(".qform").insertAdjacentHTML("afterbegin", `<div class="note">في سؤال سحب وإفلات ما بيشتغل هون. حلّه من الإي ليرنينج.</div>`);
    // keep a live copy of your answers, so they're saved even after you've switched to another screen
    let lastData = collect();
    const form = QL.querySelector(".qform"); ["input", "change"].forEach(ev => form.addEventListener(ev, () => { lastData = collect(); }));
    const save = async (finish) => { const dataArr = document.body.contains(form) ? collect() : lastData; return finish ? call("mod_quiz_process_attempt", { attemptid: attempt.id, data: dataArr, finishattempt: 1, timeup: 0 }) : call("mod_quiz_save_attempt", { attemptid: attempt.id, data: dataArr }); };
    const nav = async (np) => { if (busy) return; busy = true; try { await save(false); } catch {} busy = false; show(np); };
    const prev = QL.querySelector("#qprev"); if (prev) prev.onclick = () => nav(p - 1);
    const next = QL.querySelector("#qnext"); if (next) next.onclick = () => nav(d.nextpage);
    const fin = QL.querySelector("#qfin");
    if (fin) fin.onclick = () => {
      sheet(`<h3 style="margin:0 0 8px">تسليم الكويز؟</h3><p class="muted">بعد التسليم ما بتقدر تغيّر إجاباتك.</p><button class="btn primary block" id="qyes">✓ سلّم</button>`);
      document.getElementById("qyes").onclick = async () => { document.querySelector(".sheet-wrap").remove(); finish(false); };
    };
    QL.querySelector("#qx").onclick = () => history.back();
    let saveT = null; ["input", "change"].forEach(ev => form.addEventListener(ev, () => { clearTimeout(saveT); saveT = setTimeout(() => save(false).catch(() => {}), 2500); }));
    // countdown; submits by itself when time runs out
    clearInterval(timerIv);
    if (endAt) { const tick = () => { const el = QL.querySelector("#qtime"); if (!el) return clearInterval(timerIv); const l = Math.floor((endAt - Date.now()) / 1000);
      if (l <= 0) { clearInterval(timerIv); finish(true); return; } el.textContent = `⏱️ ${Math.floor(l / 60)}:${String(l % 60).padStart(2, "0")}`; el.className = "pill " + (l < 120 ? "urgent" : "soon"); quizTab(l); }; tick(); timerIv = setInterval(tick, 1000); }
    else quizTab(null);
    async function finish(timeup) {
      const away = !QL.offsetParent; window.activeQuiz = null; quizTab();
      if (away && timeup) toast("⏱️ خلص وقت الكويز وتسلّم بإجاباتك", 4000);
      clearInterval(timerIv); QL.querySelector(".page").insertAdjacentHTML("beforeend", `<div class="card answer"></div>`); const w = waiter(QL.querySelector(".card.answer")); w.status("tool", "بسلّم الكويز…");
      try {
        await call("mod_quiz_process_attempt", { attemptid: attempt.id, data: collect(), finishattempt: 1, timeup: timeup ? 1 : 0 });
        w.stop(); let grade = "";
        try { const r = await call("mod_quiz_get_attempt_review", { attemptid: attempt.id }); if (r.grade !== undefined && r.grade !== null) grade = `${r.grade}`; } catch {}
        QL.innerHTML = `<div class="page enter"><div class="card" style="text-align:center"><div style="font-size:46px">✅</div><h2 style="color:var(--ink);font-size:20px;margin:6px 0">تم تسليم الكويز</h2>
          ${grade ? `<p style="font-size:18px">علامتك: <b>${esc(grade)}</b>${q && q.grade ? "" : ""}</p>` : `<p class="muted">العلامة بتطلع لما الدكتور يفتحها.</p>`}
          ${demo ? demoQuiz.reviewHtml() + `<div class="btns" style="justify-content:center"><button class="btn primary" onclick="routes.qattempt('demo')">↻ جرّب كمان مرة</button><button class="btn" onclick="go('home')">الرئيسية</button></div>` : `<button class="btn primary" onclick="go('quiz-${quizid}')">رجوع للكويز</button>`}</div></div>`;
        buzz(); if (grade) confetti(); if (!demo) refresh(true).catch(() => {});
      } catch (e) { w.stop(); QL.querySelector(".card.answer").innerHTML = `<div class="err">ما زبط التسليم: ${esc(e.message)}</div>`; }
    }
  }
  show(page);
};

function showQuizLayer(on) {
  const QL = document.getElementById("quizlayer"); if (!QL) return;
  QL.hidden = !on; document.getElementById("app").hidden = on;
  if (on) window.scrollTo(0, 0);
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", on ? t.id === "quiztab" : false));
}
function closeQuizLayer() { const QL = document.getElementById("quizlayer"); if (QL) QL.remove(); document.getElementById("app").hidden = false; }
// while a quiz is open it gets its own tab with a live timer — one tap and you're back, exactly where you were
function quizTab(left) {
  let t = document.getElementById("quiztab"); const a = window.activeQuiz;
  if (!a) { if (t) t.remove(); return; }
  if (!t) { t = document.createElement("button"); t.id = "quiztab"; t.className = "tab quiztab"; document.getElementById("tabbar").prepend(t); t.onclick = () => go("qattempt-" + a.id); }
  t.innerHTML = `<span class="ic">📝</span>${left !== undefined && left !== null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "الكويز"}`;
  t.classList.toggle("hurry", left !== null && left !== undefined && left < 120);
}
window.addEventListener("hashchange", () => {
  const onQuiz = /^#qattempt-/.test(location.hash);
  if (!onQuiz) { showQuizLayer(false); if (!window.activeQuiz) closeQuizLayer(); }
});
window.quizPill = () => {};

/* ======================= hooks ======================= */
window.featureTools2 = () => [
  { name: "get_grades", description: "The student's grades (marks and teacher feedback) per course from the e-learning.", label: () => "بشوف علاماتك…",
    execute: async () => { const g = await checkGrades(); if (!g) return { error: "grades unavailable" }; return { courses: data.courses.map(c => ({ course: c.name, items: (g[c.id] || []).filter(x => x.raw != null).map(x => ({ name: x.name, grade: x.grade, max: x.max, feedback: x.feedback })) })) }; } },
  { name: "search_my_files", description: "Search inside the student's indexed lecture files, notes and assignments for a word or topic; returns course, file number and page.", label: () => "بدوّر بملفاتك…",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async ({ query }) => {
      await ensureData(); const words = normAr(query).split(/\s+/).filter(w => w.length > 1); const hits = [];
      for (const c of data.courses) { let files = []; try { files = await courseFiles(c.id); } catch {} for (let i = 0; i < files.length; i++) { const f = files[i]; const idx = await KV.get("txt:" + Study.fkey(f)); const inTitle = words.some(w => normAr(f.title).includes(w)); if (inTitle) hits.push({ course: c.name, file_number: i + 1, title: f.title }); if (idx) for (const p of idx) if (words.every(w => normAr(p.text).includes(w))) hits.push({ course: c.name, file_number: i + 1, title: f.title, page: p.page, text: p.text.slice(0, 200) }); } }
      return { results: hits.slice(0, 15), note: hits.length ? "" : "nothing in indexed files; try list_course_files + open_course_file" };
    } }
];
// background: check grades when the app opens (every 30 min at most)
setTimeout(() => { if (Moodle.session) ensureData().then(() => checkGrades()).catch(() => {}); }, 4000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Moodle.session) checkGrades().catch(() => {}); });
