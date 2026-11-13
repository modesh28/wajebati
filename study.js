/* Study from course files: slides (PPTX), PDFs and Word files — summary, flashcards, practice quiz and chat about the file. */
const KV = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("wajebati", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("kv", mode); const q = fn(t.objectStore("kv")); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return {
    get: k => tx("readonly", s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx("readwrite", s => s.put(v, k)).catch(() => {}),
    del: k => tx("readwrite", s => s.delete(k)).catch(() => {})
  };
})();

const Study = (() => {
  const contents = {}; // courseid -> sections
  const fileCache = new Map(); // url -> {kind:"pdf"|"text", data, name, pages}
  const rawCache = new Map(); // url -> original Blob (for sharing to NotebookLM)

  // instant: returns cached list right away (if any) and refreshes in the background
  async function courseContents(courseid, onFresh) {
    if (contents[courseid]) { if (onFresh) fetchContents(courseid).then(f => { if (JSON.stringify(f) !== JSON.stringify(contents[courseid])) { contents[courseid] = f; onFresh(f); } }).catch(() => {}); return contents[courseid]; }
    const cached = Moodle.store.get("cc." + courseid);
    if (cached) { contents[courseid] = cached; fetchContents(courseid).then(f => { const changed = JSON.stringify(f) !== JSON.stringify(cached); contents[courseid] = f; if (changed && onFresh) onFresh(f); }).catch(() => {}); return cached; }
    contents[courseid] = await fetchContents(courseid);
    return contents[courseid];
  }
  async function fetchContents(courseid) {
    const secs = await Moodle.call("core_course_get_contents", { courseid });
    const out = [];
    for (const s of secs) {
      const files = [];
      for (const m of s.modules || []) {
        if (m.visible === 0 || m.uservisible === false) continue;
        if (m.modname === "resource" || m.modname === "folder") {
          (m.contents || []).filter(c => c.type === "file").forEach((c, i) => files.push({
            cmid: m.id, idx: i, title: m.modname === "folder" ? `${m.name} / ${c.filename}` : m.name,
            filename: c.filename, url: c.fileurl, mime: c.mimetype || guessMime(c.filename), size: c.filesize || 0, time: c.timemodified || 0 }));
        } else if (m.modname === "url" && m.contents && m.contents[0]) {
          files.push({ cmid: m.id, idx: 0, title: m.name, filename: "", url: m.contents[0].fileurl, mime: "link", size: 0, link: true });
        }
      }
      if (files.length) out.push({ name: s.name, files });
    }
    Moodle.store.set("cc." + courseid, out);
    return out;
  }
  function guessMime(n) {
    const e = (n || "").split(".").pop().toLowerCase();
    return { pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" }[e] || "";
  }
  function kindOf(f) {
    const n = (f.filename || "").toLowerCase();
    if (f.link) return "link";
    if (f.mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
    if (n.endsWith(".pptx")) return "pptx";
    if (n.endsWith(".docx")) return "docx";
    if (/^image\//.test(f.mime)) return "image";
    if (/^text\//.test(f.mime) || /\.(txt|md|py|java|c|cpp|js|sql|html|css)$/.test(n)) return "text";
    if (n.endsWith(".ppt") || n.endsWith(".doc")) return "old";
    return "other";
  }
  const icon = k => ({ pdf: "📕", pptx: "📊", docx: "📘", image: "🖼️", text: "📄", link: "🔗", old: "📁", other: "📎" }[k]);
  const studyable = k => ["pdf", "pptx", "docx", "text", "image"].includes(k);
  function sizeLabel(b) { return !b ? "" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.ceil(b / 1024) + " KB"; }

  let jszip = null;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jszip) return jszip;
    jszip = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; s.onload = () => res(window.JSZip); s.onerror = () => rej(new Error("ما قدرت أحمّل قارئ الملفات")); document.head.appendChild(s); });
    return jszip;
  }
  const xmlText = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g"))].map(m => m[1]);
  const unxml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  async function toBase64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  }

  // Download the file from the e-learning and turn it into something the AI can read
  const fkey = f => "doc:" + f.url.split("?")[0] + ":" + (f.time || 0);
  async function load(f) {
    if (fileCache.has(f.url)) return fileCache.get(f.url);
    const saved = await KV.get(fkey(f));
    if (saved) { fileCache.set(f.url, saved); KV.get("raw:" + fkey(f)).then(b => b && rawCache.set(f.url, b)); return saved; }
    const k = kindOf(f);
    let blob;
    const direct = Moodle.fileUrl(f.url);
    const proxy = (Moodle.store.get("proxyUrl", "") || "").trim().replace(/\/$/, "");
    const tries = proxy ? [`${proxy}/?url=${encodeURIComponent(direct)}`, direct] : [direct];
    for (const u of tries) {
      try { const r = await fetch(u); if (r.ok) { blob = await r.blob(); break; } } catch {}
    }
    if (!blob) { const err = new Error("cors"); err.code = "fetch"; err.noProxy = !proxy; throw err; }
    rawCache.set(f.url, blob); KV.set("raw:" + fkey(f), blob);
    const out = await fromBlob(blob, f, k);
    fileCache.set(f.url, out); KV.set(fkey(f), out);
    return out;
  }

  // Turn a downloaded or picked file into something the AI can read
  async function fromBlob(blob, f, k) {
    k = k || kindOf(f);
    let out;
    if (k === "pdf") {
      if (blob.size > 18 * 1048576) throw new Error("الملف كبير كثير (أكثر من 18MB) عشان المساعد يقرأه مرة وحدة.");
      out = { kind: "pdf", data: await toBase64(blob) };
    } else if (k === "image") {
      out = { kind: "image", data: await toBase64(blob), mime: blob.type || f.mime };
    } else if (k === "pptx") {
      const JSZip = await loadJSZip(); const zip = await JSZip.loadAsync(blob);
      const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
      const parts = [];
      for (let i = 0; i < slides.length; i++) {
        const xml = await zip.file(slides[i]).async("string");
        const txt = xml.split(/<\/a:p>/).map(p => xmlText(p, "a:t").join("")).filter(Boolean).map(unxml).join("\n");
        const notesFile = zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`);
        let notes = ""; if (notesFile) notes = unxml(xmlText(await notesFile.async("string"), "a:t").join(" ")).trim();
        parts.push(`--- Slide ${i + 1} ---\n${txt}${notes && !/^\d+$/.test(notes) ? `\n(Notes: ${notes})` : ""}`);
      }
      out = { kind: "text", data: parts.join("\n\n"), pages: slides.length };
    } else if (k === "docx") {
      const JSZip = await loadJSZip(); const zip = await JSZip.loadAsync(blob);
      const xml = await zip.file("word/document.xml").async("string");
      out = { kind: "text", data: xml.split(/<\/w:p>/).map(p => unxml(xmlText(p, "w:t").join(""))).filter(Boolean).join("\n") };
    } else {
      out = { kind: "text", data: await blob.text() };
    }
    if (out.kind === "text" && out.data.length > 400000) out.data = out.data.slice(0, 400000);
    out.name = f.filename;
    return out;
  }
  function fromLocal(file) {
    const f = { filename: file.name, mime: file.type || guessMime(file.name) };
    const k = kindOf(f);
    if (!studyable(k)) throw new Error("هاد نوع ملف ما بقدر أقرأه. جرّب PDF أو PowerPoint (pptx) أو Word (docx) أو صورة.");
    return fromBlob(file, f, k);
  }

  function attach(doc) {
    if (doc.kind === "pdf") return { docs: [{ mime: "application/pdf", data: doc.data }] };
    if (doc.kind === "image") return { images: [{ mime: doc.mime, data: doc.data }] };
    return { prefix: `محتوى الملف "${doc.name}":\n<<<\n${doc.data}\n>>>\n\n` };
  }

  const SYS0 = `إنت مدرّس خصوصي شاطر جداً لطالب جامعي بجامعة البلقاء (نظم حاسوبية). اعتمد على الملف المرفق بالدرجة الأولى، وإذا ضفت إشي من برّا الملف وضّح إنه إضافة. رتّب كلامك بعناوين ونقاط قصيرة. لما الرسم بيوضّح أكثر من الكلام (خطوات، علاقات، هياكل بيانات) ارسم بـ \`\`\`mermaid (كود صحيح وبسيط).`;
  const sys = () => SYS0 + "\n" + AI.langRule();

  const PROMPTS = {
    zero: `درّسني هاد الملف من الصفر كأني أول مرة بسمع فيه، كدرس كامل مرتب:
## 1. قبل ما نبلّش
شو لازم أعرف قبل (المتطلبات) بشرح سريع.
## 2. الدرس خطوة خطوة
قسّم الملف لخطوات صغيرة بالترتيب. لكل خطوة: الفكرة بكلام بسيط، تشبيه من الحياة، مثال (محلول إذا في حسابات أو كود)، وبالآخر "✋ سؤال تأكد:" مع الجواب تحته.
## 3. قاموس المصطلحات
جدول: | المصطلح (English) | المعنى بالعربي | مثال قصير |
## 4. لخّص الدرس بـ 5 نقاط
## 5. جاهز للامتحان؟ 3 أسئلة امتحان مع إجاباتها`,
    podcast: `اعمل حلقة بودكاست تعليمية (زي Audio Overview تبع NotebookLM) عن الملف، بين مذيعين: "سارة" (بتشرح وفاهمة المادة) و"أحمد" (طالب ذكي بيسأل أسئلة الطلاب وبيلخّص). باللهجة الأردنية، طبيعي وممتع وفيه حماس وأمثلة من الحياة، والمصطلحات التقنية بالإنجليزي. 16-24 جملة، كل جملة قصيرة (سطر-سطرين). ابدأوا بترحيب، وغطّوا كل أفكار الملف المهمة بالترتيب، واختموا بأهم 3 نقاط للامتحان. رجّع JSON بس:
{"title":"عنوان الحلقة","lines":[{"who":"سارة","text":"..."},{"who":"أحمد","text":"..."}]}`,
    mindmap: `اعمل خريطة ذهنية (mind map) شجرية لمحتوى الملف، مرتبة بالترتيب اللي لازم ينْدرس فيه: من الأساسيات للمتقدم. كل فرع عنوان قصير (2-5 كلمات) وملاحظة شرح بسطر، و3 مستويات كحد أقصى. رجّع JSON بس:
{"title":"عنوان الموضوع","children":[{"title":"فرع","note":"شرح بسطر","emoji":"📦","children":[{"title":"فرع فرعي","note":"شرح"}]}]}`,
    video: `اعمل درس فيديو قصير (7-10 مشاهد) بيشرح الملف لطالب لأول مرة، كأنه فيديو يوتيوب تعليمي ممتع. كل مشهد: إيموجي، عنوان، نص الراوي (جملتين-٣ باللهجة الأردنية، طبيعي وممتع)، ونقاط تظهر على الشاشة (2-4 نقاط قصيرة). إذا المشهد بيستفيد من رسم، ضيف diagram بصيغة Mermaid (flowchart أو graph، بسيط وصحيح). رجّع JSON بس:
{"title":"عنوان الدرس","scenes":[{"emoji":"🎯","title":"عنوان","say":"نص الراوي","points":["نقطة","نقطة"],"diagram":"graph TD; A-->B"}]}`,
    sim: `اعمل محاكاة تفاعلية بتشرح أهم مفهوم بالملف عن طريق التجربة (مثلاً: لو Stack أزرار push/pop مع أنيميشن، لو خوارزمية خطوات بتتحرك، لو معادلة سلايدرز بتغيّر القيم وبتشوف النتيجة).
الشروط: صفحة HTML وحدة كاملة (HTML+CSS+JS) بدون أي مكتبات أو روابط خارجية، dir="rtl" والشرح بالعربي والمصطلحات بالإنجليزي، تصميم حلو وألوان هادية، أزرار كبيرة بتشتغل على الموبايل، وشرح قصير فوق شو تعمل. رجّع الكود بس داخل \`\`\`html`,
    diagram: `اعمل رسم توضيحي واحد (Mermaid) بيلخّص الملف كله بصرياً: العلاقات بين المفاهيم أو خطوات العملية. استخدم flowchart TD، عناوين قصيرة بالإنجليزي أو العربي، وتأكد إنه الكود صحيح 100%. بعده اكتب 3 أسطر شرح للرسم. حط الرسم داخل \`\`\`mermaid`,
    summary: "لخّصلي هاد الملف ملخص دراسي مرتّب: الفكرة العامة، وبعدين أهم المفاهيم كل واحد بسطرين مع مثال، وبالآخر «أهم ٥ نقاط للامتحان».",
    explain: "اشرحلي الملف جزء جزء (أو سلايد سلايد) بطريقة بسيطة كأنك بتدرّسني لأول مرة، مع أمثلة من الحياة.",
    cards: `اعمل 12 بطاقة مراجعة (flashcards) من أهم المعلومات بالملف. رجّع JSON بس بهاد الشكل بدون أي كلام ثاني:
{"cards":[{"q":"سؤال قصير","a":"جواب مختصر وواضح"}]}`,
    quiz: `اعمل كويز تدريبي من 8 أسئلة اختيار من متعدد من الملف، بمستوى أسئلة الامتحان الجامعي (مش بس حفظ، كمان فهم وتطبيق). رجّع JSON بس بهاد الشكل بدون أي كلام ثاني:
{"questions":[{"q":"السؤال","options":["أ","ب","ج","د"],"answer":0,"why":"ليش هاد الجواب الصح بسطر"}]}`
  };

  function parseJSON(t) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); const raw = (m ? m[1] : t).trim();
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    return JSON.parse(raw.slice(start, end + 1));
  }

  async function ask(doc, task, onText, extraMsgs, onStatus) {
    if (!doc) return AI.chat({ system: sys(), messages: [{ role: "user", text: PROMPTS[task] || task }], onText: onText || (() => {}), onStatus, json: /رجّع JSON/.test(PROMPTS[task] || task || ""), depth: "deep" });
    const a = attach(doc);
    const first = { role: "user", text: (a.prefix || "") + (PROMPTS[task] || task), images: a.images, docs: a.docs };
    const messages = extraMsgs ? [ { ...first, text: (a.prefix || "") + "هاد الملف اللي بدنا ندرس منه." }, { role: "assistant", text: "تمام، قريته. اسألني." }, ...extraMsgs ] : [first];
    const json = ["cards", "quiz", "mindmap", "video"].includes(task);
    return AI.chat({ system: sys(), messages, onText: onText || (() => {}), onStatus, json, depth: extraMsgs ? "fast" : "deep" });
  }

  function remember(f, doc, raw) { fileCache.set(f.url, doc); KV.set(fkey(f), doc); if (raw) { rawCache.set(f.url, raw); KV.set("raw:" + fkey(f), raw); } }
  function rawNow(f) { return rawCache.get(f.url) || null; }
  async function raw(f) {
    if (rawCache.has(f.url)) return rawCache.get(f.url);
    const b = await KV.get("raw:" + fkey(f)); if (b) { rawCache.set(f.url, b); return b; }
    try { await load(f); } catch {}
    return rawCache.get(f.url) || null;
  }
  return { PROMPTS, raw, rawNow, remember, fkey, courseContents, kindOf, icon, studyable, sizeLabel, load, fromLocal, ask, parseJSON };
})();
