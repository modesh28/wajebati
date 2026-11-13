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
const CODE_LANGS = { python: "Python", javascript: "JavaScript", java: "Java", cpp: "C++", c: "C", sql: "SQL" };
const SAMPLES = {
  python: 'stack = []\nfor x in [1, 2, 3]:\n    stack.append(x)\nprint("pop:", stack.pop())\nprint("stack:", stack)\n',
  javascript: 'const q = [];\nq.push(1); q.push(2);\nconsole.log("dequeue:", q.shift());\nconsole.log(q);\n',
  java: 'public class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello BAU!");\n  }\n}\n',
  cpp: '#include <iostream>\nusing namespace std;\nint main() {\n  cout << "Hello BAU!" << endl;\n  return 0;\n}\n',
  c: '#include <stdio.h>\nint main() {\n  printf("Hello BAU!\\n");\n  return 0;\n}\n',
  sql: 'SELECT name, grade\nFROM students\nWHERE grade > 80\nORDER BY grade DESC;\n'
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
    } else {
      // Java / C / C++ / SQL can't run inside the phone browser — the AI traces it like a compiler would
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
if (/^#(grades|search|code)/.test(location.hash)) route();
