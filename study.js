/* Study from course files: slides (PPTX), PDFs and Word files — summary, flashcards, practice quiz and chat about the file. */
const Study = (() => {
  const contents = {}; // courseid -> sections
  const fileCache = new Map(); // url -> {kind:"pdf"|"text", data, name, pages}

  async function courseContents(courseid) {
    if (contents[courseid]) return contents[courseid];
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
    contents[courseid] = out;
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
  async function load(f) {
    if (fileCache.has(f.url)) return fileCache.get(f.url);
    const k = kindOf(f);
    let blob;
    try {
      const r = await fetch(Moodle.fileUrl(f.url));
      if (!r.ok) throw new Error("HTTP " + r.status);
      blob = await r.blob();
    } catch (e) { const err = new Error("cors"); err.code = "fetch"; throw err; }
    const out = await fromBlob(blob, f, k);
    fileCache.set(f.url, out);
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

  const SYS = `إنت مدرّس خصوصي شاطر جداً لطالب جامعي بجامعة البلقاء (نظم حاسوبية). احكي باللهجة الأردنية، والمصطلحات التقنية بالإنجليزي. اعتمد على الملف المرفق بالدرجة الأولى، وإذا ضفت إشي من برّا الملف وضّح إنه إضافة. رتّب كلامك بعناوين ونقاط قصيرة.`;

  const PROMPTS = {
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
    const a = attach(doc);
    const first = { role: "user", text: (a.prefix || "") + (PROMPTS[task] || task), images: a.images, docs: a.docs };
    const messages = extraMsgs ? [ { ...first, text: (a.prefix || "") + "هاد الملف اللي بدنا ندرس منه." }, { role: "assistant", text: "تمام، قريته. اسألني." }, ...extraMsgs ] : [first];
    const json = task === "cards" || task === "quiz";
    return AI.chat({ system: SYS, messages, onText: onText || (() => {}), onStatus, json, depth: extraMsgs ? "fast" : "deep" });
  }

  return { courseContents, kindOf, icon, studyable, sizeLabel, load, fromLocal, ask, parseJSON };
})();
