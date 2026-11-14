/* Moodle Web Services client — talks directly to the university's e-learning from the phone. */
const Moodle = (() => {
  // BAU has a separate e-learning server for some colleges. Known ones are tried automatically;
  // a student from another college can paste their e-learning link.
  const DEFAULT_SITE = "https://s1.ebalqa.courses";
  const SITES = [
    { url: "https://s1.ebalqa.courses", name: "جامعة البلقاء (الإي ليرنينج الرئيسي)" },
    { url: "https://s2.ebalqa.courses/nfetmoodle", name: "كلية الهندسة التكنولوجية" },
    { url: "https://s1.ebalqa.courses/ncentermoodle", name: "منصة المركز (ncentermoodle)" }
  ];
  // turn whatever the student pasted (…/login/index.php, …/my/, no https) into the site's base address
  function normSite(u) {
    u = String(u || "").trim(); if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { const x = new URL(u); let path = x.pathname.replace(/\/(login|my|course|mod|user|admin|calendar|grade|webservice|pluginfile\.php|index\.php)(\/.*)?$/i, "").replace(/\/+$/, ""); return (x.origin + path).replace(/^http:/, "https:"); } catch { return ""; }
  }
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  let session = store.get("mdl.session");
  const site = () => (session && session.site) || store.get("mdl.site") || DEFAULT_SITE;
  // Moodle sends names with HTML entities (V&amp;V) — turn them into plain text
  const decode = (t) => { if (!t || !/[&]/.test(t)) return t; const el = document.createElement("textarea"); el.innerHTML = t; return el.value; }; // {token, privatetoken, userid, fullname, picture}

  // Moodle expects PHP-style nested params: a[0][b]=c
  function flatten(obj, prefix, out) {
    out = out || new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === "object") flatten(v, key, out);
      else out.append(key, typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    return out;
  }

  // ask one e-learning server for a login token
  async function tokenFrom(base, username, password) {
    const body = new URLSearchParams({ username, password, service: "moodle_mobile_app" });
    let r;
    try { r = await fetch(`${base}/login/token.php`, { method: "POST", body, signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined }); }
    catch { return { net: true }; }           // blocked by the site (no app access) or no internet
    const j = await r.json().catch(() => null);
    if (!j) return { notmoodle: true, status: r.status }; // the address answered, but it isn't an e-learning login
    return j;
  }
  function loginError(j) {
    const code = (j && j.errorcode) || "";
    return code === "invalidlogin" ? "الرقم الجامعي أو كلمة السر غلط" : code === "usernotfullysetup" ? "لازم تكمّل إعداد حسابك على موقع الإي ليرنينج أول"
      : /enablews|servicenotavailable|webservicesnotenabled/i.test(code + (j && j.error)) ? "الإي ليرنينج تبع كليتك مسكّر خدمة تطبيقات الموبايل، فما بنقدر نتصل فيه من التطبيق."
      : /locked|suspended/i.test(code + (j && j.error)) ? "الحساب مقفول مؤقتاً، جرّب بعد شوي" : ((j && j.error) || "ما زبط تسجيل الدخول");
  }
  // siteChoice: "" = find the student's college automatically, or a site address
  async function login(username, password, siteChoice = "") {
    username = String(username).trim();
    let base = normSite(siteChoice), j;
    if (base) {
      j = await tokenFrom(base, username, password);
      if (j.notmoodle) throw new Error("هاد الرابط مش صفحة إي ليرنينج. افتح الإي ليرنينج تبعك من المتصفح، وانسخ الرابط من صفحة تسجيل الدخول كامل، واختار «كلية ثانية…» والصقه.");
      if (j.net) throw new Error(navigator.onLine === false ? "إنت مش متصل بالنت 📶" : "موقع الإي ليرنينج تبع كليتك رافض يتصل بالتطبيق، أو النت ضعيف. جرّب كمان مرة.");
      if (!j.token) throw new Error(loginError(j));
    } else {
      // try the last used server first, then all known ones at the same time; keep the one that accepts the account
      const order = [...new Set([store.get("mdl.site"), ...SITES.map(x => x.url)].filter(Boolean))];
      const results = await new Promise(resolve => {
        const out = new Array(order.length); let left = order.length, done = false;
        // keep the order's preference (main site first) but don't wait for slower servers after an answer
        const check = () => { if (done) return; for (let i = 0; i < order.length; i++) { if (out[i] === undefined) return; if (out[i].token) { done = true; return resolve({ win: i, out }); } } if (!left) { done = true; resolve({ win: -1, out }); } };
        order.forEach((b, i) => tokenFrom(b, username, password).then(r => { out[i] = r; left--; check(); }));
        setTimeout(() => { if (done) return; const i = out.findIndex(r => r && r.token); if (i >= 0) { done = true; resolve({ win: i, out }); } }, 6000);
      });
      if (results.win < 0) {
        const rs = results.out;
        if (rs.every(r => r.net || r.notmoodle)) throw new Error(navigator.onLine === false ? "إنت مش متصل بالنت 📶" : "ما قدرت أوصل لموقع الجامعة، جرّب كمان شوي");
        const real = rs.find(r => !r.net && r.errorcode && r.errorcode !== "invalidlogin");
        if (real) throw new Error(loginError(real));
        throw new Error("الرقم الجامعي أو كلمة السر غلط. إذا كليتك إلها إي ليرنينج خاص، اختارها من «كليتك» تحت أو الصق رابطه.");
      }
      base = order[results.win]; j = results.out[results.win];
    }
    session = { token: j.token, privatetoken: j.privatetoken || null, username, site: base };
    const info = await call("core_webservice_get_site_info");
    session.userid = info.userid;
    session.fullname = info.fullname;
    session.picture = info.userpictureurl;
    session.sitename = info.sitename || "";
    if (info.username) session.username = info.username;
    store.set("mdl.session", session); store.set("mdl.site", base);
    return session;
  }

  function logout() { session = null; store.del("mdl.session"); store.del("mdl.cache"); }

  async function call(fn, params = {}) {
    if (!session) throw Object.assign(new Error("not logged in"), { code: "auth" });
    const body = flatten(params);
    body.append("wstoken", session.token);
    body.append("wsfunction", fn);
    const r = await fetch(`${site()}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=${fn}`, { method: "POST", body });
    const j = await r.json();
    if (j && j.exception) {
      const e = new Error(j.message || j.errorcode);
      e.code = j.errorcode;
      if (["invalidtoken", "accessexception"].includes(j.errorcode) && fn === "core_webservice_get_site_info") e.code = "auth";
      if (j.errorcode === "invalidtoken") { e.code = "auth"; }
      throw e;
    }
    return j;
  }

  // Add the token to Moodle file URLs so images/attachments load
  function fileUrl(url) {
    if (!url || !session) return url;
    if (!url.startsWith(new URL(site()).origin)) return url;
    let u = url.includes("/webservice/pluginfile.php") ? url : url.replace("/pluginfile.php", "/webservice/pluginfile.php");
    if (/[?&]token=/.test(u)) return u;
    if (u.includes("/webservice/pluginfile.php") || u.includes("/draftfile.php")) {
      u += (u.includes("?") ? "&" : "?") + "token=" + session.token;
    }
    return u;
  }
  // keep course content safe: drop scripts, iframes, inline event handlers and javascript: links
  function sanitize(html) {
    const t = document.createElement("template"); t.innerHTML = html;
    t.content.querySelectorAll("script,style,iframe,object,embed,form,link,meta,base").forEach(n => n.remove());
    t.content.querySelectorAll("*").forEach(n => { for (const a of [...n.attributes]) { const v = a.value.trim().toLowerCase(); if (/^on/i.test(a.name) || ((a.name === "href" || a.name === "src") && /^(javascript|data:text)/.test(v))) n.removeAttribute(a.name); }
      if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); } });
    return t.innerHTML;
  }
  function rewriteHtml(html) {
    if (!html) return "";
    html = sanitize(html);
    const host = new URL(site()).origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.replace(new RegExp(`(src|href)="(${host}\\/[^"]*pluginfile\\.php[^"]*)"`, "g"), (m, a, u) => `${a}="${fileUrl(u.replace(/&amp;/g, "&"))}"`);
  }

  async function courses() {
    const list = await call("core_enrol_get_users_courses", { userid: session.userid });
    return list.filter(c => c.visible !== 0).map(c => ({ id: c.id, name: decode(c.fullname), short: c.shortname, progress: c.progress }));
  }

  async function assignments(courseIds) {
    if (!courseIds.length) return [];
    const r = await call("mod_assign_get_assignments", { courseids: courseIds });
    const out = [];
    for (const c of r.courses || []) for (const a of c.assignments || []) {
      out.push({ kind: "assign", id: a.id, cmid: a.cmid, courseid: c.id, coursename: c.fullname, name: decode(a.name),
        due: a.duedate || 0, cutoff: a.cutoffdate || 0, allowfrom: a.allowsubmissionsfromdate || 0,
        intro: a.intro, attachments: (a.introattachments || []).map(f => ({ name: f.filename, url: f.fileurl })),
        drafts: !!a.submissiondrafts, statement: !!a.requiresubmissionstatement,
        configs: a.configs || [] });
    }
    return out;
  }

  async function quizzes(courseIds) {
    if (!courseIds.length) return [];
    const r = await call("mod_quiz_get_quizzes_by_courses", { courseids: courseIds });
    return (r.quizzes || []).map(q => ({ kind: "quiz", id: q.id, cmid: q.coursemodule, courseid: q.course, name: decode(q.name),
      open: q.timeopen || 0, due: q.timeclose || 0, timelimit: q.timelimit || 0, attempts: q.attempts || 0, intro: q.intro }));
  }

  async function submissionStatus(assignid) {
    const r = await call("mod_assign_get_submission_status", { assignid });
    const sub = r.lastattempt && (r.lastattempt.submission || r.lastattempt.teamsubmission);
    const plugins = (sub && sub.plugins) || [];
    const files = [];
    let text = "";
    for (const p of plugins) {
      for (const fa of p.fileareas || []) for (const f of fa.files || []) files.push({ name: f.filename, url: f.fileurl });
      for (const ef of p.editorfields || []) if (ef.text) text = ef.text;
    }
    const grade = r.feedback && r.feedback.gradefordisplay;
    return {
      status: sub ? sub.status : "new", // new | draft | submitted
      graded: r.lastattempt && r.lastattempt.gradingstatus === "graded",
      canedit: r.lastattempt ? r.lastattempt.canedit : false,
      cansubmit: r.lastattempt ? r.lastattempt.cansubmit : false,
      files, text, grade, feedbackPlugins: (r.feedback && r.feedback.plugins) || []
    };
  }

  async function uploadDraft(files) {
    let itemid = 0;
    for (const f of files) {
      const fd = new FormData();
      fd.append("token", session.token);
      fd.append("filearea", "draft");
      fd.append("itemid", itemid);
      fd.append("file", f, f.name);
      const r = await fetch(`${site()}/webservice/upload.php`, { method: "POST", body: fd });
      const j = await r.json();
      if (!Array.isArray(j) || !j[0] || !j[0].itemid) throw new Error((j && (j.error || j.message)) || "فشل رفع الملف");
      itemid = j[0].itemid;
    }
    return itemid;
  }

  async function saveSubmission(assignid, { text, files }) {
    const plugindata = {};
    if (text !== undefined && text !== null) plugindata.onlinetext_editor = { text, format: 1, itemid: 0 };
    if (files && files.length) plugindata.files_filemanager = await uploadDraft(files);
    const r = await call("mod_assign_save_submission", { assignmentid: assignid, plugindata });
    const warn = (r || []).find ? r.find(w => w.warningcode || w.message) : null;
    if (warn) throw new Error(warn.message || warn.item);
    return true;
  }

  async function submitForGrading(assignid) {
    const r = await call("mod_assign_submit_for_grading", { assignmentid: assignid, acceptsubmissionstatement: 1 });
    if (Array.isArray(r) && r.length) throw new Error(r[0].message || "ما زبط التسليم");
    return true;
  }

  async function upcomingEvents() {
    const now = Math.floor(Date.now() / 1000);
    const r = await call("core_calendar_get_action_events_by_timesort", { timesortfrom: now - 86400 * 3, limitnum: 50 });
    return (r.events || []).map(e => ({ id: e.id, name: decode(e.activityname || e.name), module: e.modulename, instance: e.instance,
      courseid: e.course && e.course.id, coursename: e.course && e.course.fullname, due: e.timesort, url: e.url,
      actionable: e.action ? e.action.actionable : false, actionName: e.action && e.action.name }));
  }

  // Open a Moodle page in the browser already logged in (used for quizzes for now)
  async function autologinUrl(url) {
    if (!session.privatetoken) return url;
    try {
      const r = await call("tool_mobile_get_autologin_key", { privatetoken: session.privatetoken });
      if (r && r.key) return `${r.autologinurl}?userid=${session.userid}&key=${r.key}&urltogo=${encodeURIComponent(url)}`;
    } catch {}
    return url;
  }

  return { get SITE() { return site(); }, SITES, normSite, store, get session() { return session; }, login, logout, call, courses, assignments, quizzes,
    submissionStatus, saveSubmission, submitForGrading, upcomingEvents, autologinUrl, fileUrl, rewriteHtml };
})();
