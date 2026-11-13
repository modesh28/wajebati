/* Moodle Web Services client — talks directly to the university's e-learning from the phone. */
const Moodle = (() => {
  const SITE = "https://s1.ebalqa.courses";
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  let session = store.get("mdl.session");
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

  async function login(username, password) {
    const body = new URLSearchParams({ username, password, service: "moodle_mobile_app" });
    const r = await fetch(`${SITE}/login/token.php`, { method: "POST", body });
    const j = await r.json();
    if (!j.token) throw new Error(j.error || "اسم المستخدم أو كلمة السر غلط");
    session = { token: j.token, privatetoken: j.privatetoken || null };
    const info = await call("core_webservice_get_site_info");
    session.userid = info.userid;
    session.fullname = info.fullname;
    session.picture = info.userpictureurl;
    store.set("mdl.session", session);
    return session;
  }

  function logout() { session = null; store.del("mdl.session"); store.del("mdl.cache"); }

  async function call(fn, params = {}) {
    if (!session) throw Object.assign(new Error("not logged in"), { code: "auth" });
    const body = flatten(params);
    body.append("wstoken", session.token);
    body.append("wsfunction", fn);
    const r = await fetch(`${SITE}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=${fn}`, { method: "POST", body });
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
    if (!url.startsWith(SITE)) return url;
    let u = url.includes("/webservice/pluginfile.php") ? url : url.replace("/pluginfile.php", "/webservice/pluginfile.php");
    if (/[?&]token=/.test(u)) return u;
    if (u.includes("/webservice/pluginfile.php") || u.includes("/draftfile.php")) {
      u += (u.includes("?") ? "&" : "?") + "token=" + session.token;
    }
    return u;
  }
  function rewriteHtml(html) {
    if (!html) return "";
    return html.replace(/(src|href)="(https:\/\/s1\.ebalqa\.courses\/[^"]*pluginfile\.php[^"]*)"/g, (m, a, u) => `${a}="${fileUrl(u.replace(/&amp;/g, "&"))}"`);
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
      const r = await fetch(`${SITE}/webservice/upload.php`, { method: "POST", body: fd });
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

  return { SITE, store, get session() { return session; }, login, logout, call, courses, assignments, quizzes,
    submissionStatus, saveSubmission, submitForGrading, upcomingEvents, autologinUrl, fileUrl, rewriteHtml };
})();
