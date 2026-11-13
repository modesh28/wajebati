/* واجباتي — study rooms: voice, chat, shared study timer and screen sharing, peer to peer (PeerJS). */
let peerjsP = null;
function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return peerjsP || (peerjsP = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"; sc.onload = () => res(window.Peer); sc.onerror = () => rej(new Error("ما قدرت أحمّل الغرف")); document.head.appendChild(sc); }));
}
const ICE = { iceServers: [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
] };
const roomCode = () => Array.from({ length: 6 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]).join("");
const myName = () => S.get("roomName", "") || ((Moodle.session && Moodle.session.fullname) || "").split(" ")[0] || "";

routes.rooms = async () => {
  const recent = S.get("rooms", []);
  $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>
    <h1 style="margin:0 0 4px;font-size:22px">🎧 غرف الدراسة</h1><p class="muted small" style="margin:0 0 14px">ادرس مع صحابك: صوت، شات، مؤقت دراسة مشترك، ومشاركة شاشة.</p>
    <div class="card"><div class="field"><label>اسم الغرفة</label><input class="input" id="rname" placeholder="مثلاً: مراجعة الاسترجاع" dir="auto"></div>
      <button class="btn primary block" id="rnew">+ اعمل غرفة جديدة</button></div>
    <div class="card"><div class="field"><label>عندك كود غرفة؟</label><input class="input" id="rcode" placeholder="مثلاً k3x9pa" dir="ltr"></div>
      <button class="btn block" id="rjoin">ادخل الغرفة</button></div>
    ${recent.length ? `<h2>غرف دخلتها</h2>${recent.slice(-5).reverse().map(r => `<div class="card item" onclick="go('room-${r.code}')"><div class="ic">🎧</div><div class="body"><div class="title" dir="auto">${esc(r.name || r.code)}</div><div class="due" dir="ltr">${r.code}</div></div></div>`).join("")}` : ""}</div>`;
  document.getElementById("rnew").onclick = () => { const code = roomCode(); S.set("roomTitle." + code, document.getElementById("rname").value.trim()); go("room-" + code); };
  document.getElementById("rjoin").onclick = () => { const c = (document.getElementById("rcode").value.trim().match(/[a-z0-9]{6}/i) || [""])[0].toLowerCase(); if (c) go("room-" + c); else toast("الكود ٦ حروف"); };
};

let ROOM = null; // the live room (one at a time)
routes.room = async (code) => {
  if (ROOM && ROOM.code !== code) ROOM.leave(true);
  if (!myName()) {
    $app.innerHTML = `<div class="page enter" style="max-width:420px"><div class="card" style="text-align:center"><div style="font-size:40px">🎧</div><b>شو اسمك؟</b>
      <input class="input" id="nm" style="margin:12px 0" dir="auto"><button class="btn primary block" id="nmgo">ادخل الغرفة</button></div></div>`;
    document.getElementById("nmgo").onclick = () => { const v = document.getElementById("nm").value.trim(); if (!v) return; S.set("roomName", v); route(); };
    return;
  }
  if (!Moodle.session) { $tabbar.hidden = true; document.body.classList.add("no-tabs"); }
  $app.innerHTML = `<div class="page enter room">
    <div class="top"><button class="back" id="rback">→</button><div style="flex:1;min-width:0"><div class="small muted">غرفة دراسة</div><b dir="auto" id="rtitle">${esc(S.get("roomTitle." + code, "") || code)}</b></div>
      <button class="back" id="rinv">🔗 دعوة</button></div>
    <div id="rstatus" class="note" style="text-align:center">⏳ بتّصل بالغرفة…</div>
    <div class="screenview" id="sv" hidden><video id="svid" autoplay playsinline></video><div class="small" id="svwho"></div><button class="link" id="svfs">⛶</button></div>
    <div class="members" id="mem"></div>
    <div class="card rtimer" id="rt"></div>
    <div class="card"><div class="rchat" id="rchat"></div>
      <form id="rform" class="bar" style="margin-top:8px"><input class="input" id="rmsg" placeholder="اكتب للغرفة…" dir="auto" style="border:0;background:transparent"><button class="iconbtn send">↑</button></form></div>
    <div class="rbar"><button class="cbtn" id="rmic" title="المايك">🎤</button>${navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? `<button class="cbtn" id="rscr" title="مشاركة الشاشة">🖥️</button>` : ""}<button class="cbtn end" id="rleave" title="اطلع">✕</button></div>
  </div>`;
  const recent = S.get("rooms", []).filter(r => r.code !== code); recent.push({ code, name: S.get("roomTitle." + code, "") }); S.set("rooms", recent.slice(-10));
  const url = location.origin + location.pathname + "#room-" + code;
  document.getElementById("rinv").onclick = () => shareOrCopy({ title: "تعال ادرس معي 📚", text: `ادخل غرفة الدراسة «${S.get("roomTitle." + code, "") || code}» على واجباتي:`, url });
  document.getElementById("rback").onclick = () => history.back();

  let Peer; try { Peer = await loadPeer(); } catch (e) { document.getElementById("rstatus").textContent = e.message; return; }
  const R = ROOM = { code, peer: null, isHost: false, members: {}, conns: {}, calls: {}, local: null, screen: null, muted: true, timer: S.get("roomTimer." + code, { mode: "focus", focus: 25, brk: 5, endAt: 0 }), title: S.get("roomTitle." + code, ""), alive: true };
  const hostId = "wajebati-room-" + code;
  let tIv = null;
  const statusEl = () => document.getElementById("rstatus");
  const setStatus = (t, hide) => { const s = statusEl(); if (!s) return; s.textContent = t; s.hidden = !!hide; };

  /* ---- messaging ---- */
  const sendAll = (msg) => { for (const c of Object.values(R.conns)) if (c.open) c.send(msg); };
  const toHost = (msg) => { if (R.isHost) handle(msg, R.peer.id); else { const c = R.conns[hostId]; c && c.open && c.send(msg); } };
  const memberList = () => Object.entries(R.members).map(([id, m]) => ({ id, name: m.name, muted: m.muted, screen: m.screen }));
  function handle(msg, from) {
    if (!R.alive) return;
    if (R.isHost) {
      if (msg.t === "hello") { R.members[from] = { name: msg.name, muted: true }; sendAll({ t: "members", list: memberList(), title: R.title, timer: R.timer }); drawMembers(); addChat({ sys: `${msg.name} دخل الغرفة 👋` }, true); return; }
      if (msg.t === "chat") { const m = { ...msg, from }; sendAll({ t: "chat", m }); addChat(m); return; }
      if (msg.t === "state") { if (R.members[from]) Object.assign(R.members[from], msg.state); sendAll({ t: "members", list: memberList(), title: R.title, timer: R.timer }); drawMembers(); return; }
      if (msg.t === "timer") { R.timer = msg.timer; S.set("roomTimer." + code, R.timer); sendAll({ t: "timer", timer: R.timer }); drawTimer(); return; }
    }
    if (msg.t === "members") { R.members = Object.fromEntries(msg.list.map(m => [m.id, m])); if (msg.title) { R.title = msg.title; const tt = document.getElementById("rtitle"); if (tt) tt.textContent = msg.title; } if (msg.timer) { R.timer = msg.timer; drawTimer(); } drawMembers(); connectAudio(); }
    if (msg.t === "chat") addChat(msg.m);
    if (msg.t === "timer") { R.timer = msg.timer; drawTimer(); }
  }
  const myState = (st) => { if (R.members[R.peer.id]) Object.assign(R.members[R.peer.id], st); if (R.isHost) { sendAll({ t: "members", list: memberList(), title: R.title, timer: R.timer }); drawMembers(); } else toHost({ t: "state", state: st }); };

  /* ---- audio mesh: everyone calls those with a smaller id, so each pair connects once ---- */
  function connectAudio() {
    if (!R.local) return;
    for (const id of Object.keys(R.members)) {
      if (id === R.peer.id || R.calls[id] || !(R.peer.id > id)) continue;
      const call = R.peer.call(id, R.local, { metadata: { kind: "voice" } }); wireCall(call, id);
    }
  }
  function wireCall(call, id) {
    R.calls[id] = call;
    call.on("stream", s => playAudio(id, s));
    call.on("close", () => { delete R.calls[id]; const a = document.getElementById("au-" + id); a && a.remove(); });
    call.on("error", () => { delete R.calls[id]; });
  }
  const meters = {};
  function playAudio(id, stream) {
    let a = document.getElementById("au-" + id);
    if (!a) { a = document.createElement("audio"); a.id = "au-" + id; a.autoplay = true; a.playsInline = true; document.body.appendChild(a); }
    a.srcObject = stream; a.play().catch(() => setStatus("اكبس أي مكان عشان تسمع الصوت 🔊"));
    try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const an = ctx.createAnalyser(); an.fftSize = 256; ctx.createMediaStreamSource(stream).connect(an); meters[id] = an; } catch {}
  }
  setInterval(() => { if (!R.alive) return; const buf = new Uint8Array(128); for (const [id, an] of Object.entries(meters)) { an.getByteFrequencyData(buf); const v = buf.reduce((a, b) => a + b, 0) / buf.length; const el = document.querySelector(`.mem[data-id="${id}"]`); el && el.classList.toggle("talking", v > 18); } }, 200);

  /* ---- screen share ---- */
  async function shareScreen() {
    if (R.screen) { stopScreen(); return; }
    try { R.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); } catch { return; }
    R.screen.getVideoTracks()[0].onended = stopScreen;
    R.screenCalls = Object.keys(R.members).filter(id => id !== R.peer.id).map(id => R.peer.call(id, R.screen, { metadata: { kind: "screen", name: myName() } }));
    myState({ screen: true }); document.getElementById("rscr").classList.add("on");
    showScreen(R.screen, "إنت بتشارك شاشتك");
  }
  function stopScreen() { if (!R.screen) return; R.screen.getTracks().forEach(t => t.stop()); (R.screenCalls || []).forEach(c => c.close()); R.screen = null; myState({ screen: false }); const b = document.getElementById("rscr"); b && b.classList.remove("on"); hideScreen(); }
  function showScreen(stream, who) { const sv = document.getElementById("sv"); if (!sv) return; sv.hidden = false; const v = document.getElementById("svid"); v.srcObject = stream; v.muted = true; v.play().catch(() => {}); document.getElementById("svwho").textContent = who; }
  function hideScreen() { const sv = document.getElementById("sv"); if (sv) sv.hidden = true; }

  /* ---- peer setup ---- */
  function onCall(call) {
    if (call.metadata && call.metadata.kind === "screen") { call.answer(); call.on("stream", s => showScreen(s, `${call.metadata.name || "حدا"} بشارك شاشته`)); call.on("close", hideScreen); return; }
    call.answer(R.local || undefined); wireCall(call, call.peer);
  }
  function wireConn(conn) {
    conn.on("open", () => { R.conns[conn.peer] = conn; if (!R.isHost) conn.send({ t: "hello", name: myName() }); });
    conn.on("data", d => handle(d, conn.peer));
    conn.on("close", () => {
      delete R.conns[conn.peer];
      if (R.isHost) { const m = R.members[conn.peer]; delete R.members[conn.peer]; sendAll({ t: "members", list: memberList(), title: R.title, timer: R.timer }); drawMembers(); m && addChat({ sys: `${m.name} طلع` }, true); }
      else if (conn.peer === hostId && R.alive) { setStatus("⏳ صاحب الغرفة طلع، بحاول أكمّل الغرفة…"); setTimeout(() => R.alive && restart(), 800 + Math.random() * 2500); }
    });
  }
  function start() {
    return new Promise((resolve) => {
      const p = new Peer(hostId, { config: ICE, debug: 0 });
      p.on("open", id => { R.peer = p; R.isHost = true; R.members = { [id]: { name: myName(), muted: R.muted } }; setStatus("", true); drawMembers(); drawTimer(); resolve(); });
      p.on("error", err => {
        if (err.type === "unavailable-id") {
          p.destroy();
          const g = new Peer(undefined, { config: ICE, debug: 0 });
          g.on("open", () => { R.peer = g; R.isHost = false; const c = g.connect(hostId, { reliable: true }); wireConn(c); setStatus("", true); resolve(); });
          g.on("connection", wireConn); g.on("call", onCall);
          g.on("error", e => { if (e.type === "peer-unavailable") { setStatus("⏳ بستنى صاحب الغرفة…"); } else setStatus("مشكلة بالاتصال: " + e.type); });
        } else setStatus(err.type === "network" || err.type === "server-error" ? "النت ضعيف، بحاول كمان مرة…" : "مشكلة بالاتصال: " + err.type);
      });
      p.on("connection", wireConn); p.on("call", onCall);
      p.on("disconnected", () => { try { p.reconnect(); } catch {} });
    });
  }
  async function restart() { try { R.peer && R.peer.destroy(); } catch {} R.conns = {}; R.calls = {}; await start(); if (R.local) connectAudio(); }
  R.leave = (silent) => {
    R.alive = false; stopScreen && R.screen && stopScreen();
    try { R.local && R.local.getTracks().forEach(t => t.stop()); } catch {}
    Object.values(R.calls).forEach(c => { try { c.close(); } catch {} }); document.querySelectorAll('audio[id^="au-"]').forEach(a => a.remove());
    try { R.peer && R.peer.destroy(); } catch {} if (ROOM === R) ROOM = null;
    if (!silent) go(Moodle.session ? "rooms" : "home");
  };
  await start();

  /* ---- UI ---- */
  function drawMembers() {
    const el = document.getElementById("mem"); if (!el) return;
    el.innerHTML = Object.entries(R.members).map(([id, m]) => `<div class="mem${id === R.peer.id ? " me" : ""}" data-id="${id}"><div class="mav">${esc((m.name || "?")[0])}</div><div class="mnm" dir="auto">${esc(m.name || "")}${id === R.peer.id ? " (إنت)" : ""}</div><div class="mst">${m.muted ? "🔇" : "🎤"}${m.screen ? " 🖥️" : ""}${id === hostId ? " 👑" : ""}</div></div>`).join("");
  }
  function addChat(m, local) {
    const el = document.getElementById("rchat"); if (!el) return;
    const d = document.createElement("div"); d.className = m.sys ? "rsys" : "rmsg" + (m.from === (R.peer && R.peer.id) ? " mine" : "");
    d.innerHTML = m.sys ? esc(m.sys) : `<b>${esc(m.name)}</b><span dir="auto">${esc(m.text)}</span>`;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
    if (local && R.isHost && m.sys) sendAll({ t: "chat", m });
  }
  function drawTimer() {
    const el = document.getElementById("rt"); if (!el) return;
    const t = R.timer, running = t.endAt > Date.now(), total = (t.mode === "focus" ? t.focus : t.brk) * 60000;
    const left = running ? t.endAt - Date.now() : total;
    el.innerHTML = `<div class="bhead"><span>${t.mode === "focus" ? "📚 وقت دراسة للكل" : "☕ استراحة"}</span><span class="small muted">مؤقت مشترك</span></div>
      <div class="rtnum">${String(Math.floor(left / 60000)).padStart(2, "0")}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}</div>
      <div class="progress"><div style="width:${(1 - left / total) * 100}%"></div></div>
      <div class="btns" style="justify-content:center"><button class="btn primary" id="rtgo">${running ? "⏹ وقّف" : "▶ ابدأ للكل"}</button><button class="btn" id="rtm">${t.mode === "focus" ? "☕ استراحة" : "📚 دراسة"}</button></div>`;
    document.getElementById("rtgo").onclick = () => { const n = { ...R.timer, endAt: running ? 0 : Date.now() + total }; toHost({ t: "timer", timer: n }); if (!R.isHost) { R.timer = n; drawTimer(); } buzz(); };
    document.getElementById("rtm").onclick = () => { const n = { ...R.timer, mode: t.mode === "focus" ? "break" : "focus", endAt: 0 }; toHost({ t: "timer", timer: n }); if (!R.isHost) { R.timer = n; drawTimer(); } };
    clearInterval(tIv);
    if (running) tIv = setInterval(() => { if (!R.alive || !document.getElementById("rt")) return clearInterval(tIv);
      if (R.timer.endAt <= Date.now()) { clearInterval(tIv); try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {} toast(R.timer.mode === "focus" ? "🎉 خلصت الجلسة! استراحة" : "☕ خلصت الاستراحة"); if (R.timer.mode === "focus") logMinutes(R.timer.focus, R.title || "غرفة دراسة");
        if (R.isHost) { R.timer = { ...R.timer, mode: R.timer.mode === "focus" ? "break" : "focus", endAt: 0 }; sendAll({ t: "timer", timer: R.timer }); } drawTimer(); return; }
      drawTimer(); }, 1000);
  }
  document.getElementById("rform").onsubmit = e => { e.preventDefault(); const i = document.getElementById("rmsg"); const t = i.value.trim(); if (!t) return; i.value = ""; toHost({ t: "chat", name: myName(), text: t }); buzz(); };
  document.getElementById("rmic").onclick = async e => {
    buzz();
    if (!R.local) {
      try { R.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch { toast("لازم تسمح للمايك 🎤"); return; }
      R.muted = false; myState({ muted: false }); e.target.textContent = "🎤"; e.target.classList.add("on");
      // replace silent calls: re-answer everyone with the mic
      Object.values(R.calls).forEach(c => { try { c.close(); } catch {} }); R.calls = {};
      for (const id of Object.keys(R.members)) { if (id === R.peer.id) continue; const call = R.peer.call(id, R.local, { metadata: { kind: "voice" } }); wireCall(call, id); }
      return;
    }
    R.muted = !R.muted; R.local.getAudioTracks().forEach(t => t.enabled = !R.muted);
    e.target.textContent = R.muted ? "🔇" : "🎤"; e.target.classList.toggle("on", !R.muted); myState({ muted: R.muted });
  };
  const scr = document.getElementById("rscr"); if (scr) scr.onclick = shareScreen;
  document.getElementById("svfs").onclick = () => { const v = document.getElementById("svid"); try { v.requestFullscreen ? v.requestFullscreen() : v.webkitEnterFullscreen && v.webkitEnterFullscreen(); } catch {} };
  document.getElementById("rleave").onclick = () => R.leave();
  document.getElementById("rmic").textContent = "🔇";
  window.addEventListener("hashchange", function onH() { if (!location.hash.startsWith("#room-" + code)) { window.removeEventListener("hashchange", onH); R.leave(true); } });
  document.addEventListener("click", () => document.querySelectorAll('audio[id^="au-"]').forEach(a => a.play().catch(() => {})), { once: true });
  drawMembers(); drawTimer();
  addChat({ sys: R.isHost ? `عملت الغرفة ✓ ابعت الدعوة لصحابك 🔗` : `دخلت الغرفة ✓ شغّل المايك 🎤 عشان تحكي` });
};
if (/^#room/.test(location.hash)) route();
