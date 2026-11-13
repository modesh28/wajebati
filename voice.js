/* واجباتي — human-like voice: live calls with Gemini's native-audio model (real voice in, real voice out,
   you can interrupt any time), plus natural AI voices for podcasts/video lessons when available. */

/* ---------- which voice models does this key have? ---------- */
async function voiceModels() {
  const key = AI.settings().geminiKey; if (!key) return { live: [], tts: [] };
  const c = S.get("ai.voicemodels");
  if (c && c.key === key.slice(-6) && Date.now() - c.t < 24 * 3600 * 1000) return c;
  let models = [];
  try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=300&key=${encodeURIComponent(key)}`); models = (await r.json()).models || []; } catch {}
  const name = m => m.name.replace(/^models\//, "");
  const live = models.filter(m => (m.supportedGenerationMethods || []).includes("bidiGenerateContent")).map(name)
    .sort((a, b) => (/native-audio/.test(b) - /native-audio/.test(a)) || (/preview|exp/.test(a) - /preview|exp/.test(b)) || b.localeCompare(a, "en", { numeric: true }));
  const tts = models.filter(m => /tts/.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent")).map(name)
    .sort((a, b) => (/pro/.test(a) - /pro/.test(b)) || b.localeCompare(a, "en", { numeric: true }));
  const out = { key: key.slice(-6), t: Date.now(), live, tts };
  S.set("ai.voicemodels", out); return out;
}
const VOICES = { m: "Orus", f: "Aoede" };
const voicePref = () => S.get("voice", "m");

/* ---------- helpers: PCM <-> base64, playback queue ---------- */
function pcm16ToB64(int16) { const u8 = new Uint8Array(int16.buffer); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToPcm16(b64) { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Int16Array(u8.buffer); }
function makePlayer(rate = 24000) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
  let next = 0; const live = new Set(); let level = 0;
  const an = ctx.createAnalyser(); an.fftSize = 256; an.connect(ctx.destination);
  return {
    ctx,
    play(int16) {
      const f = new Float32Array(int16.length); for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
      const buf = ctx.createBuffer(1, f.length, rate); buf.copyToChannel(f, 0);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(an);
      const t = Math.max(ctx.currentTime + 0.02, next); src.start(t); next = t + buf.duration;
      live.add(src); src.onended = () => live.delete(src);
    },
    stop() { live.forEach(s => { try { s.stop(); } catch {} }); live.clear(); next = 0; },
    get busy() { return live.size > 0 || next > ctx.currentTime; },
    level() { const d = new Uint8Array(128); an.getByteFrequencyData(d); return d.reduce((a, b) => a + b, 0) / d.length / 255; },
    close() { this.stop(); try { ctx.close(); } catch {} }
  };
}
async function micStream16k(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)(); try { await ctx.resume(); } catch {}
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(2048, 1, 1), ratio = ctx.sampleRate / 16000;
  let level = 0, muted = false;
  proc.onaudioprocess = e => {
    const d = e.inputBuffer.getChannelData(0); let m = 0;
    const n = Math.floor(d.length / ratio), out = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = d[Math.floor(i * ratio)]; out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff; const a = Math.abs(v); if (a > m) m = a; }
    level = m; if (!muted) onChunk(out);
  };
  src.connect(proc); proc.connect(ctx.destination);
  return { get level() { return level; }, set muted(v) { muted = v; stream.getAudioTracks().forEach(t => t.enabled = !v); }, get muted() { return muted; },
    stop() { try { proc.disconnect(); src.disconnect(); } catch {} stream.getTracks().forEach(t => t.stop()); try { ctx.close(); } catch {} } };
}

/* ---------- live call ---------- */
window.startCall = async () => {
  if (!AI.ready()) return;
  buzz();
  const vm = await voiceModels();
  if (!vm.live.length) return startCallBasic();
  const ov = document.createElement("div"); ov.className = "call";
  ov.innerHTML = `<div class="call-top"><div class="small" style="opacity:.7">مكالمة مع</div><b>المساعد ✨</b></div>
    <button class="orb" id="orb"><span></span></button>
    <div class="call-state" id="cst">بتّصل…</div>
    <div class="call-lines" id="clines"></div>
    <div class="call-btns"><button class="cbtn" id="cmute">🎤</button><button class="cbtn end" id="cend">✕</button><button class="cbtn" id="cvoice">${voicePref() === "m" ? "👨" : "👩"}</button></div>`;
  document.body.appendChild(ov);
  const cst = ov.querySelector("#cst"), lines = ov.querySelector("#clines"), orb = ov.querySelector("#orb");
  const set = (m, t) => { ov.dataset.mode = m; cst.textContent = t; };
  let ws = null, mic = null, player = null, alive = true, ready = false, modelIdx = 0, meterIv = null;
  let userLine = null, aiLine = null, userText = "", aiText = "";
  const transcript = [];
  const line = (who) => { const d = document.createElement("div"); d.className = "cl " + who; lines.appendChild(d); lines.scrollTop = lines.scrollHeight; return d; };
  const tools = aiTools().filter(t => !["open_course_file", "list_course_files"].includes(t.name));

  const sys = aiContext() + `
هاي مكالمة صوتية مباشرة مع الطالب، زي مكالمة تلفون مع صاحب شاطر ومدرّس بنفس الوقت.
- احكي باللهجة الأردنية الطبيعية (زي ما بيحكوا الشباب بعمّان): "شو"، "هسّا/هلأ"، "يعني"، "تمام"، "ولا يهمك"، "يا زلمة"، "إشي"، "بدّك". ما تحكي فصحى أبداً إلا إذا طلب.
- خليك طبيعي ودافي وفيك روح: جمل قصيرة، نَفَس كلام حقيقي، ورد فعل على كلامه ("آه فهمت عليك"، "ممتاز!").
- رد قصير (جملة لثلاث) إلا إذا طلب شرح؛ وإذا شرحت، قسّم الشرح لقطع صغيرة واسأله "ماشي لهون؟".
- المصطلحات التقنية قولها بالإنجليزي بشكل طبيعي.
- إذا قاطعك، وقّف وجاوب على اللي قاله.
- عندك أدوات بتقدر تستخدمها (واجباته، علاماته، امتحاناته، ملاحظاته، البحث بملفاته) — استخدمها لحالك لما تفيد.`;

  function connect() {
    const model = vm.live[modelIdx]; if (!model) { fallback("ما زبط الاتصال الصوتي المتطور"); return; }
    ready = false; set("connect", "بتّصل…");
    ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(AI.settings().geminiKey)}`);
    const failTimer = setTimeout(() => { if (!ready) { try { ws.close(); } catch {} modelIdx++; connect(); } }, 8000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ setup: {
        model: "models/" + model,
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[voicePref()] } } } },
        systemInstruction: { parts: [{ text: sys }] },
        tools: [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, ...(parameters ? { parameters } : {}) })) }],
        inputAudioTranscription: {}, outputAudioTranscription: {}
      } }));
    };
    ws.onmessage = async ev => {
      const txt = typeof ev.data === "string" ? ev.data : await ev.data.text();
      let m; try { m = JSON.parse(txt); } catch { return; }
      if (m.setupComplete) {
        clearTimeout(failTimer); ready = true; set("listen", "احكي، أنا سامعك 👂");
        // say hello first so it feels like a real call
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "(الطالب فتح المكالمة هلأ. سلّم عليه بالاسم بجملة قصيرة ودافية واسأله شو بده.)" }] }], turnComplete: true } }));
        return;
      }
      if (m.toolCall) {
        const responses = [];
        for (const fc of m.toolCall.functionCalls || []) {
          set("think", "لحظة، بشيك…");
          const t = tools.find(x => x.name === fc.name); let res;
          try { res = t ? await t.execute(fc.args || {}) : { error: "unknown" }; } catch (e) { res = { error: e.message }; }
          if (res && res.attach) delete res.attach;
          responses.push({ id: fc.id, name: fc.name, response: res && typeof res === "object" ? res : { result: res } });
        }
        ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        return;
      }
      const sc = m.serverContent; if (!sc) return;
      if (sc.interrupted) { player.stop(); aiLine = null; aiText = ""; set("listen", "سامعك…"); }
      if (sc.inputTranscription && sc.inputTranscription.text) { if (!userLine) { userLine = line("me"); userText = ""; } userText += sc.inputTranscription.text; userLine.textContent = userText; set("listen", "سامعك…"); }
      if (sc.modelTurn && sc.modelTurn.parts) for (const p of sc.modelTurn.parts) {
        if (p.inlineData && /audio/.test(p.inlineData.mimeType)) { player.play(b64ToPcm16(p.inlineData.data)); set("speak", "بحكي…"); }
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        if (userLine) { transcript.push({ role: "user", text: userText }); userLine = null; }
        if (!aiLine) { aiLine = line("ai"); aiText = ""; } aiText += sc.outputTranscription.text; aiLine.textContent = aiText; lines.scrollTop = lines.scrollHeight;
      }
      if (sc.turnComplete) { if (aiText) transcript.push({ role: "assistant", text: aiText }); aiLine = null; aiText = ""; if (userLine) { transcript.push({ role: "user", text: userText }); userLine = null; } }
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      clearTimeout(failTimer);
      if (!alive) return;
      if (!ready) { modelIdx++; connect(); return; }
      // the session ended (time limit or network) — reconnect quietly
      set("connect", "📶 برجع أوصل…"); setTimeout(() => alive && connect(), 800);
    };
  }
  function fallback(msg) { if (!alive) return; end(true); toast(msg + "، بستخدم المكالمة العادية", 3000); startCallBasic(); }
  function send(int16) { if (ws && ready && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm16ToB64(int16), mimeType: "audio/pcm;rate=16000" } } })); }

  try {
    player = makePlayer(24000); try { await player.ctx.resume(); } catch {}
    mic = await micStream16k(send);
  } catch { set("idle", "لازم تسمح للمايك 🎤"); return; }
  connect();
  meterIv = setInterval(() => {
    if (!alive) return clearInterval(meterIv);
    const lv = player.busy ? player.level() * 2.2 : mic.level * 3;
    orb.style.transform = `scale(${1 + Math.min(lv, 1) * 0.18})`;
    if (ready && !player.busy && ov.dataset.mode === "speak") set("listen", "احكي، أنا سامعك 👂");
  }, 80);
  orb.onclick = () => { if (player.busy) { player.stop(); set("listen", "سامعك…"); buzz(); } };
  ov.querySelector("#cmute").onclick = e => { mic.muted = !mic.muted; e.target.textContent = mic.muted ? "🔇" : "🎤"; set(mic.muted ? "idle" : "listen", mic.muted ? "المايك مسكّر" : "سامعك…"); buzz(); };
  ov.querySelector("#cvoice").onclick = e => { S.set("voice", voicePref() === "m" ? "f" : "m"); e.target.textContent = voicePref() === "m" ? "👨" : "👩"; buzz(); try { ws && ws.close(); } catch {} };
  function end(silent) {
    alive = false; clearInterval(meterIv);
    try { ws && ws.close(); } catch {} try { mic && mic.stop(); } catch {} try { player && player.close(); } catch {}
    ov.classList.add("out"); setTimeout(() => ov.remove(), 200);
    if (!silent && transcript.length) { transcript.forEach(t => chatMsgs.push({ role: t.role, text: t.role === "user" ? "🎤 " + t.text : t.text })); try { S.set("ai.chat", chatMsgs.map(m => ({ ...m, docs: [], hidden: "", audio: [] }))); } catch {} if (location.hash === "#ai") route(); }
  }
  ov.querySelector("#cend").onclick = () => end();
  window.addEventListener("hashchange", () => alive && end(), { once: true });
};

/* ---------- natural AI voice for podcasts / video lessons (falls back to the phone's voice) ---------- */
const ttsCache = new Map();
window.aiSpeech = async (text, voice) => {
  const vm = await voiceModels(); if (!vm.tts.length) return null;
  const k = voice + "|" + text; if (ttsCache.has(k)) return ttsCache.get(k);
  const p = (async () => {
    for (const model of vm.tts) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(AI.settings().geminiKey)}`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "احكي باللهجة الأردنية بشكل طبيعي ودافي: " + text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }) });
        if (!r.ok) continue;
        const j = await r.json(); const part = j.candidates && j.candidates[0].content.parts.find(x => x.inlineData);
        if (part) return b64ToPcm16(part.inlineData.data);
      } catch {}
    }
    return null;
  })();
  ttsCache.set(k, p); return p;
};
// play text with the AI voice; resolves when finished; returns false if no AI voice is available
let ttsPlayer = null;
window.playAiSpeech = async (text, voice, isStopped) => {
  const pcm = await aiSpeech(text, voice); if (!pcm || (isStopped && isStopped())) return false;
  if (!ttsPlayer) ttsPlayer = makePlayer(24000);
  try { await ttsPlayer.ctx.resume(); } catch {}
  ttsPlayer.play(pcm);
  await new Promise(res => { const iv = setInterval(() => { if (!ttsPlayer.busy || (isStopped && isStopped())) { clearInterval(iv); res(); } }, 120); });
  return true;
};
window.stopAiSpeech = () => { if (ttsPlayer) ttsPlayer.stop(); };
// warm up the model list in the background
setTimeout(() => { if (AI.ready()) voiceModels().catch(() => {}); }, 3000);
