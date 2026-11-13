/* واجباتي — human-like voice.
   One voice engine used by calls and voice review:
   • Live mode: Gemini native-audio (real voice in/out, interrupt any time)
   • Smart mode (fallback): records you until you stop talking, Gemini listens to the audio itself (understands
     Jordanian far better than the phone's speech recognition), answers, and speaks with a natural AI voice. */

/* ---------- which voice models does this key have? ---------- */
async function voiceModels() {
  const key = AI.settings().geminiKey; if (!key) return { live: [], tts: [] };
  const c = S.get("ai.voicemodels");
  if (c && c.key === key.slice(-6) && Date.now() - c.t < 12 * 3600 * 1000) return c;
  let models = [];
  try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=300&key=${encodeURIComponent(key)}`); models = (await r.json()).models || []; } catch {}
  const name = m => m.name.replace(/^models\//, "");
  const live = models.filter(m => (m.supportedGenerationMethods || []).includes("bidiGenerateContent")).map(name)
    .sort((a, b) => (/native-audio/.test(b) - /native-audio/.test(a)) || (/preview|exp/.test(a) - /preview|exp/.test(b)) || b.localeCompare(a, "en", { numeric: true }));
  const tts = models.filter(m => /tts/.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent")).map(name)
    .sort((a, b) => (/pro/.test(a) - /pro/.test(b)) || b.localeCompare(a, "en", { numeric: true }));
  const out = { key: key.slice(-6), t: Date.now(), live: live.filter(m => !(S.get("ai.livebad", {})[m] > Date.now())), tts };
  S.set("ai.voicemodels", out); return out;
}
const VOICES = { m: "Orus", f: "Aoede" };
const voicePref = () => S.get("voice", "m");

/* ---------- audio helpers ---------- */
function pcm16ToB64(int16) { const u8 = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToPcm16(b64) { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Int16Array(u8.buffer); }
function wavB64(chunks, rate = 16000) {
  const len = chunks.reduce((a, c) => a + c.length, 0), pcm = new Int16Array(len); let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf); const w = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return pcm16ToB64(new Int16Array(buf));
}
function makePlayer(rate = 24000) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
  let next = 0; const live = new Set();
  const an = ctx.createAnalyser(); an.fftSize = 256; an.connect(ctx.destination);
  return {
    ctx,
    play(int16) {
      const f = new Float32Array(int16.length); for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
      const buf = ctx.createBuffer(1, f.length, rate); buf.copyToChannel(f, 0);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(an);
      const t = Math.max(ctx.currentTime + 0.03, next); src.start(t); next = t + buf.duration;
      live.add(src); src.onended = () => live.delete(src);
    },
    stop() { live.forEach(s => { try { s.stop(); } catch {} }); live.clear(); next = 0; },
    get busy() { return live.size > 0 || next > ctx.currentTime + 0.01; },
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
    const d = e.inputBuffer.getChannelData(0); let sum = 0;
    const n = Math.floor(d.length / ratio), out = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = d[Math.floor(i * ratio)]; out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff; sum += v * v; }
    level = Math.sqrt(sum / Math.max(n, 1)); if (!muted) onChunk(out, level);
  };
  src.connect(proc); proc.connect(ctx.destination);
  return { get level() { return level; }, set muted(v) { muted = v; stream.getAudioTracks().forEach(t => t.enabled = !v); }, get muted() { return muted; },
    stop() { try { proc.disconnect(); src.disconnect(); } catch {} stream.getTracks().forEach(t => t.stop()); try { ctx.close(); } catch {} } };
}

/* ---------- natural AI voice (TTS) with phone-voice fallback ---------- */
const ttsCache = new Map();
window.aiSpeech = async (text, voice) => {
  const vm = await voiceModels(); if (!vm.tts.length || !text) return null;
  const k = voice + "|" + text; if (ttsCache.has(k)) return ttsCache.get(k);
  const p = (async () => {
    for (const model of vm.tts) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(AI.settings().geminiKey)}`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "اقرأ هاد الكلام باللهجة الأردنية، بصوت طبيعي ودافي وسرعة عادية:\n" + text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }) });
        if (!r.ok) continue;
        const j = await r.json(); const part = j.candidates && j.candidates[0].content.parts.find(x => x.inlineData);
        if (part) return b64ToPcm16(part.inlineData.data);
      } catch {}
    }
    return null;
  })();
  ttsCache.set(k, p); if (ttsCache.size > 80) ttsCache.delete(ttsCache.keys().next().value); return p;
};
let ttsPlayer = null;
window.playAiSpeech = async (text, voice, isStopped) => {
  const pcm = await aiSpeech(text, voice); if (!pcm || (isStopped && isStopped())) return false;
  if (!ttsPlayer) ttsPlayer = makePlayer(24000);
  try { await ttsPlayer.ctx.resume(); } catch {}
  ttsPlayer.play(pcm);
  await new Promise(res => { const iv = setInterval(() => { if (!ttsPlayer.busy || (isStopped && isStopped())) { clearInterval(iv); res(); } }, 100); });
  return true;
};
window.stopAiSpeech = () => { if (ttsPlayer) ttsPlayer.stop(); };
function phoneSpeak(text, isStopped) {
  return new Promise(res => {
    const synth = window.speechSynthesis; if (!synth || (isStopped && isStopped())) return res();
    try { synth.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(text); const vs = synth.getVoices(); const latin = (text.match(/[a-z]/gi) || []).length > text.length * .5;
    const v = (latin ? vs.find(x => /^en/i.test(x.lang)) : vs.find(x => /^ar/i.test(x.lang))) || vs.find(x => /^ar/i.test(x.lang)); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "ar";
    u.rate = 1.05; u.onend = res; u.onerror = res; synth.speak(u);
  });
}

/* ---------- the voice session (UI + Live / Smart engines) ---------- */
const DIALECT = `
- احكي باللهجة الأردنية الطبيعية (زي ما بيحكوا الشباب بعمّان): "شو"، "هلأ"، "يعني"، "تمام"، "ولا يهمك"، "يا زلمة"، "إشي"، "بدّك"، "منيح". ما تحكي فصحى أبداً إلا إذا طلب.
- خليك طبيعي ودافي وفيك روح، زي صاحب شاطر: جمل قصيرة، ورد فعل على كلامه ("آه فهمت عليك"، "ممتاز!"، "قربت كثير").
- المصطلحات التقنية قولها بالإنجليزي بشكل طبيعي.
- ما تستخدم رموز أو قوائم أو جداول أو كود — هاد كلام مسموع.`;

async function voiceSession(opts) {
  if (!AI.ready()) { go("settings"); return; }
  buzz();
  const vm = await voiceModels();
  const ov = document.createElement("div"); ov.className = "call";
  ov.innerHTML = `<div class="call-top"><div class="small" style="opacity:.7">${esc(opts.subtitle || "مكالمة مع")}</div><b>${esc(opts.title || "المساعد ✨")}</b><div class="call-mode" id="cmode"></div></div>
    <button class="orb" id="orb"><span></span></button>
    <div class="call-state" id="cst">بتّصل…</div>
    ${opts.score ? `<div class="call-score" id="cscore">✅ 0 · ❌ 0</div>` : ""}
    <div class="call-lines" id="clines"></div>
    <div class="call-btns"><button class="cbtn" id="cmute">🎤</button><button class="cbtn end" id="cend">✕</button><button class="cbtn" id="cvoice">${voicePref() === "m" ? "👨" : "👩"}</button></div>`;
  document.body.appendChild(ov);
  const cst = ov.querySelector("#cst"), lines = ov.querySelector("#clines"), orb = ov.querySelector("#orb"), modeEl = ov.querySelector("#cmode");
  const set = (m, t) => { ov.dataset.mode = m; cst.textContent = t; };
  const addLine = (who, text) => { const d = document.createElement("div"); d.className = "cl " + who; d.textContent = text || ""; lines.appendChild(d); lines.scrollTop = lines.scrollHeight; return d; };
  const transcript = [];
  let alive = true, engine = null, player = null, mic = null, meterIv = null;
  const tools = (opts.tools || []).slice();
  const score = { ok: 0, bad: 0 };
  if (opts.score) tools.push({ name: "record_answer", description: "Record whether the student's spoken answer was correct (call after judging every answer).", label: () => "",
    parameters: { type: "object", properties: { question: { type: "string" }, correct: { type: "boolean" }, correct_answer: { type: "string" } }, required: ["question", "correct"] },
    execute: async ({ question, correct, correct_answer }) => { correct ? score.ok++ : score.bad++; const sc = ov.querySelector("#cscore"); if (sc) sc.textContent = `✅ ${score.ok} · ❌ ${score.bad}`;
      try { navigator.vibrate && navigator.vibrate(correct ? 25 : [40, 40, 40]); } catch {}
      if (!correct) { addWeak(question, opts.src || "مراجعة صوتية"); if (correct_answer) srsAdd([{ q: question, a: correct_answer }], opts.src || "مراجعة صوتية"); }
      return { ok: true, score }; } });

  const end = (silent) => {
    if (!alive) return; alive = false; clearInterval(meterIv);
    try { engine && engine.stop(); } catch {} try { mic && mic.stop(); } catch {} try { player && player.close(); } catch {} try { speechSynthesis.cancel(); } catch {}
    ov.classList.add("out"); setTimeout(() => ov.remove(), 200);
    if (!silent && opts.saveToChat !== false && transcript.length) { transcript.forEach(t => chatMsgs.push({ role: t.role, text: t.role === "user" ? "🎤 " + t.text : t.text })); try { S.set("ai.chat", chatMsgs.map(m => ({ ...m, docs: [], hidden: "", audio: [] }))); } catch {} if (location.hash === "#ai") route(); }
    if (opts.onEnd) opts.onEnd(score);
  };
  ov.querySelector("#cend").onclick = () => end();
  window.addEventListener("hashchange", () => end(), { once: true });

  /* ===== Live engine ===== */
  function liveEngine(model) {
    return new Promise((resolve) => {
      let ws, ready = false, userLine = null, aiLine = null, userText = "", aiText = "";
      const failT = setTimeout(() => { if (!ready) { try { ws.close(); } catch {} resolve(false); } }, 9000);
      ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(AI.settings().geminiKey)}`);
      ws.onopen = () => ws.send(JSON.stringify({ setup: {
        model: "models/" + model,
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[voicePref()] } } } },
        systemInstruction: { parts: [{ text: opts.sys }] },
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, ...(parameters ? { parameters } : {}) })) }] } : {}),
        inputAudioTranscription: {}, outputAudioTranscription: {}
      } }));
      ws.onmessage = async ev => {
        const txt = typeof ev.data === "string" ? ev.data : await ev.data.text(); let m; try { m = JSON.parse(txt); } catch { return; }
        if (m.setupComplete) {
          clearTimeout(failT); ready = true; resolve(true);
          modeEl.textContent = "🎙️ صوت طبيعي مباشر";
          engine = { stop: () => { try { ws.close(); } catch {} }, send: (int16) => { if (ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm16ToB64(int16), mimeType: "audio/pcm;rate=16000" } } })); }, live: true };
          set("listen", "احكي، أنا سامعك 👂");
          if (opts.kickoff) ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: opts.kickoff }] }], turnComplete: true } }));
          return;
        }
        if (m.toolCall) {
          const out = [];
          for (const fc of m.toolCall.functionCalls || []) { const t = tools.find(x => x.name === fc.name); if (t && t.label && t.label(fc.args || {})) set("think", t.label(fc.args || {}));
            let r; try { r = t ? await t.execute(fc.args || {}) : { error: "unknown" }; } catch (e) { r = { error: e.message }; } if (r && r.attach) delete r.attach;
            out.push({ id: fc.id, name: fc.name, response: r && typeof r === "object" ? r : { result: r } }); }
          ws.send(JSON.stringify({ toolResponse: { functionResponses: out } })); return;
        }
        const sc = m.serverContent; if (!sc) return;
        if (sc.interrupted) { player.stop(); if (aiText) transcript.push({ role: "assistant", text: aiText }); aiLine = null; aiText = ""; set("listen", "سامعك…"); }
        if (sc.inputTranscription && sc.inputTranscription.text) { if (!userLine) { userLine = addLine("me"); userText = ""; } userText += sc.inputTranscription.text; userLine.textContent = userText; set("listen", "سامعك…"); }
        if (sc.modelTurn && sc.modelTurn.parts) for (const p of sc.modelTurn.parts) if (p.inlineData && /audio/.test(p.inlineData.mimeType)) { player.play(b64ToPcm16(p.inlineData.data)); set("speak", "بحكي…"); }
        if (sc.outputTranscription && sc.outputTranscription.text) {
          if (userLine) { transcript.push({ role: "user", text: userText }); userLine = null; }
          if (!aiLine) { aiLine = addLine("ai"); aiText = ""; } aiText += sc.outputTranscription.text; aiLine.textContent = aiText; lines.scrollTop = lines.scrollHeight;
        }
        if (sc.turnComplete) { if (aiText) transcript.push({ role: "assistant", text: aiText }); aiLine = null; aiText = ""; if (userLine) { transcript.push({ role: "user", text: userText }); userLine = null; } }
      };
      ws.onclose = () => {
        clearTimeout(failT);
        if (!ready) { const bad = S.get("ai.livebad", {}); bad[model] = Date.now() + 6 * 3600 * 1000; S.set("ai.livebad", bad); S.del("ai.voicemodels"); resolve(false); return; }
        if (alive && engine && engine.live) { set("connect", "📶 برجع أوصل…"); engine = null; setTimeout(() => alive && startLive(), 700); }
      };
      ws.onerror = () => {};
    });
  }
  async function startLive() { for (const m of vm.live) { if (!alive) return false; if (await liveEngine(m)) return true; } return false; }

  /* ===== Smart engine: you talk → it waits till you stop → Gemini hears the audio → natural voice reply ===== */
  function smartEngine() {
    modeEl.textContent = vm.tts.length ? "🎙️ صوت طبيعي" : "🎙️ وضع ذكي";
    const history = [];
    let state = "listen", chunks = [], speechMs = 0, silenceMs = 0, abort = null, speakingUntilStopped = false, bargeMs = 0;
    const smartSys = opts.sys + `
\nكل رسالة من الطالب هي ملف صوت. اسمعه منيح (لهجة أردنية) وجاوب على محتواه.
ابدأ ردك دايماً بسطر واحد بالشكل: «سمعت: <اللي حكاه الطالب بالزبط بكلماته>» وبعده سطر جديد فيه ردك.`;
    const speak = async (text) => {
      state = "speak"; set("speak", "بحكي…"); speakingUntilStopped = true;
      const parts = text.split(/(?<=[.!؟?،\n])\s+/).filter(x => x.trim()).reduce((a, s) => { if (a.length && (a[a.length - 1] + " " + s).length < 160) a[a.length - 1] += " " + s; else a.push(s); return a; }, []);
      for (let k = 0; k < parts.length; k++) {
        if (!alive || state !== "speak") return;
        if (parts[k + 1]) aiSpeech(parts[k + 1], VOICES[voicePref()]);
        const ok = await playAiSpeech(parts[k], VOICES[voicePref()], () => !alive || state !== "speak");
        if (!ok && alive && state === "speak") await phoneSpeak(parts[k], () => !alive || state !== "speak");
      }
      if (alive && state === "speak") { state = "listen"; set("listen", "احكي، أنا سامعك 👂"); }
    };
    const think = async (wav, textIn) => {
      state = "think"; set("think", "بفكّر…"); abort = new AbortController();
      history.push(wav ? { role: "user", text: "(رسالة صوتية مرفقة)", audio: [{ mime: "audio/wav", data: wav }] } : { role: "user", text: textIn });
      const line = addLine("ai", "…");
      try {
        let shown = "";
        const full = await AI.chat({ system: smartSys, messages: history.slice(-14).map((m, i, a) => ({ ...m, audio: i === a.length - 1 ? m.audio : [] })), tools, depth: "smart", signal: abort.signal,
          onStatus: (k, mm) => { if (k === "tool" && mm) set("think", mm); },
          onText: t => { const m2 = t.match(/^\s*«?سمعت:\s*([^\n»]*)»?\s*\n?([\s\S]*)$/); shown = m2 ? m2[2] : t; line.textContent = shown.replace(/[*#`]/g, "") || "…"; } });
        const m2 = full.match(/^\s*«?سمعت:\s*([^\n»]*)»?\s*\n?([\s\S]*)$/);
        const heard = m2 ? m2[1].trim() : "", reply = (m2 ? m2[2] : full).replace(/[*#`>|_]/g, "").trim();
        if (wav) { history[history.length - 1] = { role: "user", text: heard || "(صوت)" }; const ul = addLine("me", heard || "🎤"); lines.insertBefore(ul, line); transcript.push({ role: "user", text: heard || "(صوت)" }); }
        history.push({ role: "assistant", text: reply }); transcript.push({ role: "assistant", text: reply }); line.textContent = reply;
        await speak(reply);
      } catch (e) { history.pop(); line.remove(); if (!alive) return; state = "listen"; set("listen", e.name === "AbortError" ? "سامعك…" : "صار خطأ، احكي كمان مرة"); }
    };
    let noise = 0.01, recMs = 0;
    const onChunk = (int16, lv) => {
      if (!alive) return;
      const ms = int16.length / 16;
      const thr = Math.max(0.03, noise * 2.6);           // adapts to the room (café noise, fan…)
      if (state === "speak") { // barge-in: start talking while it speaks → it stops and listens
        bargeMs = lv > Math.max(0.09, noise * 4) ? bargeMs + ms : 0;
        if (bargeMs > 350) { state = "listen"; window.stopAiSpeech && stopAiSpeech(); try { speechSynthesis.cancel(); } catch {} chunks = []; speechMs = 0; silenceMs = 0; recMs = 0; bargeMs = 0; set("listen", "سامعك…"); }
        return;
      }
      if (state !== "listen" && state !== "rec") return;
      const voiced = lv > thr;
      if (state === "listen") {
        if (!voiced) { noise = noise * 0.97 + lv * 0.03; chunks.push(int16); if (chunks.length > 8) chunks.shift(); return; }
        state = "rec"; speechMs = 0; silenceMs = 0; recMs = 0; set("listen", "سامعك…");
      }
      chunks.push(int16); recMs += ms;
      if (voiced) { speechMs += ms; silenceMs = 0; } else silenceMs += ms;
      if (silenceMs > 900 || recMs > 20000) {
        const c = chunks; chunks = []; const enough = speechMs > 400; speechMs = 0; silenceMs = 0; recMs = 0;
        if (enough) think(wavB64(c)); else state = "listen";
      }
    };
    engine = { stop: () => { abort && abort.abort(); window.stopAiSpeech && stopAiSpeech(); }, onChunk, think, interrupt: () => { if (state === "speak" || state === "think") { abort && abort.abort(); state = "listen"; window.stopAiSpeech && stopAiSpeech(); try { speechSynthesis.cancel(); } catch {} set("listen", "سامعك…"); } } };
    set("listen", "احكي، أنا سامعك 👂");
    if (opts.kickoff) think(null, opts.kickoff);
  }

  /* ===== start ===== */
  try { player = makePlayer(24000); try { await player.ctx.resume(); } catch {}
    mic = await micStream16k((int16, lv) => { if (engine && engine.live) engine.send(int16); else if (engine && engine.onChunk) engine.onChunk(int16, lv); });
  } catch { set("idle", "لازم تسمح للمايك 🎤"); return; }
  let liveOk = false;
  if (vm.live.length) { set("connect", "بتّصل…"); liveOk = await startLive(); }
  if (!alive) return;
  if (!liveOk) smartEngine();
  meterIv = setInterval(() => {
    if (!alive) return clearInterval(meterIv);
    const speaking = (player && player.busy) || (ttsPlayer && ttsPlayer.busy);
    const lv = speaking ? Math.max(player ? player.level() : 0, ttsPlayer ? ttsPlayer.level() : 0) * 2.2 : mic.level * 6;
    orb.style.transform = `scale(${1 + Math.min(lv, 1) * 0.18})`;
    if (engine && engine.live && !player.busy && ov.dataset.mode === "speak") set("listen", "احكي، أنا سامعك 👂");
  }, 80);
  orb.onclick = () => { buzz(); if (engine && engine.live) { if (player.busy) { player.stop(); set("listen", "سامعك…"); } } else if (engine && engine.interrupt) engine.interrupt(); };
  ov.querySelector("#cmute").onclick = e => { mic.muted = !mic.muted; e.target.textContent = mic.muted ? "🔇" : "🎤"; set(mic.muted ? "idle" : "listen", mic.muted ? "المايك مسكّر" : "سامعك…"); buzz(); };
  ov.querySelector("#cvoice").onclick = e => { S.set("voice", voicePref() === "m" ? "f" : "m"); e.target.textContent = voicePref() === "m" ? "👨" : "👩"; buzz(); if (engine && engine.live) engine.stop(); };
}
window.voiceSession = voiceSession;

/* ---------- call ---------- */
window.startCall = () => voiceSession({
  title: "المساعد ✨", subtitle: "مكالمة مع",
  sys: aiContext() + `\nهاي مكالمة صوتية مباشرة مع الطالب، زي مكالمة تلفون مع صاحب شاطر ومدرّس بنفس الوقت.` + DIALECT + `
- رد قصير (جملة لثلاث) إلا إذا طلب شرح؛ وإذا شرحت، قسّم الشرح لقطع صغيرة واسأله "ماشي لهون؟".
- إذا قاطعك، وقّف وجاوب على اللي قاله.
- عندك أدوات (واجباته، علاماته، امتحاناته، ملاحظاته، البحث بملفاته) — استخدمها لحالك لما تفيد.`,
  kickoff: "(الطالب فتح المكالمة هلأ. سلّم عليه باسمه الأول بجملة قصيرة ودافية واسأله شو بدّه.)",
  tools: aiTools().filter(t => !["open_course_file", "list_course_files"].includes(t.name))
});

/* ---------- voice review: pick anything (a file, a whole course, your weak spots, or any topic) ---------- */
routes.vreview = async () => {
  await ensureData();
  const st = { course: "", file: "", src: "course", level: "متوسط", n: 8, topic: "" };
  const draw = async () => {
    const files = st.course ? await courseFiles(st.course).catch(() => []) : [];
    const weakN = S.get("weak", []).length;
    $app.innerHTML = `<div class="page enter"><div class="top"><button class="back" onclick="history.back()">→ رجوع</button></div>
      <h1 style="margin:0 0 4px;font-size:22px">🎧 مراجعة صوتية</h1><p class="muted small" style="margin:0 0 14px">بيسألك بصوته، بتجاوب بصوتك زي ما بدك، وبيقلّك إذا صح وبيشرحلك. بدون ما تعمل بطاقات.</p>
      <div class="card"><div class="field"><label>شو بدك نراجع؟</label>
        <div class="seg wrap" id="vsrc"><button data-s="course" class="${st.src === "course" ? "on" : ""}">📚 مادة</button><button data-s="weak" class="${st.src === "weak" ? "on" : ""}">🎯 نقاط ضعفي${weakN ? ` (${weakN})` : ""}</button><button data-s="topic" class="${st.src === "topic" ? "on" : ""}">💬 موضوع</button></div></div>
        ${st.src === "course" ? `<div class="field"><label>المادة</label><select class="input" id="vc"><option value="">اختار مادة</option>${data.courses.map(c => `<option value="${c.id}" ${st.course == c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
          ${st.course ? `<div class="field"><label>من وين؟</label><select class="input" id="vf"><option value="">كل المادة</option>${files.filter(f => Study.studyable(Study.kindOf(f))).map((f, i) => `<option value="${f.cmid}.${f.idx}" ${st.file === f.cmid + "." + f.idx ? "selected" : ""}>${i + 1}. ${esc(f.title)}</option>`).join("")}</select></div>` : ""}` : ""}
        ${st.src === "topic" ? `<div class="field"><label>الموضوع</label><input class="input" id="vt" dir="auto" placeholder="مثلاً: Deadlock أو SQL Joins" value="${esc(st.topic)}"></div>` : ""}
        ${st.src === "weak" && !weakN ? `<p class="small muted">لسا ما في نقاط ضعف مسجّلة — بتنسجّل لحالها من الكويزات والمراجعات.</p>` : ""}
        <div class="field"><label>المستوى</label><div class="seg" id="vl">${["سهل", "متوسط", "صعب"].map(l => `<button data-l="${l}" class="${st.level === l ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <div class="field"><label>عدد الأسئلة</label><div class="seg" id="vn">${[5, 8, 12].map(n => `<button data-n="${n}" class="${st.n === n ? "on" : ""}">${n}</button>`).join("")}</div></div>
        <button class="btn primary block" id="vgo">🎧 يلا نبلّش</button></div>
      <div id="vprep"></div></div>`;
    document.getElementById("vsrc").onclick = e => { const b = e.target.closest("button"); if (b) { st.src = b.dataset.s; draw(); } };
    const vc = document.getElementById("vc"); if (vc) vc.onchange = e => { st.course = e.target.value; st.file = ""; draw(); };
    const vf = document.getElementById("vf"); if (vf) vf.onchange = e => { st.file = e.target.value; };
    const vt = document.getElementById("vt"); if (vt) vt.oninput = e => { st.topic = e.target.value; };
    document.getElementById("vl").onclick = e => { const b = e.target.closest("button"); if (b) { st.level = b.dataset.l; document.querySelectorAll("#vl button").forEach(x => x.classList.toggle("on", x === b)); } };
    document.getElementById("vn").onclick = e => { const b = e.target.closest("button"); if (b) { st.n = +b.dataset.n; document.querySelectorAll("#vn button").forEach(x => x.classList.toggle("on", x === b)); } };
    document.getElementById("vgo").onclick = start;
  };
  const start = async () => {
    if (!AI.ready()) { go("settings"); return; }
    const prep = document.getElementById("vprep"); prep.innerHTML = `<div class="card answer"></div>`; const w = waiter(prep.firstChild); w.status("read");
    let material = "", label = "";
    try {
      if (st.src === "course") {
        if (!st.course) { w.stop(); prep.innerHTML = `<div class="err">اختار مادة أول</div>`; return; }
        const c = data.courses.find(x => x.id == st.course); label = c ? c.name : "";
        const files = (await courseFiles(st.course)).filter(f => Study.studyable(Study.kindOf(f)));
        const pick = st.file ? files.filter(f => f.cmid + "." + f.idx === st.file) : files;
        if (st.file && pick[0]) label = pick[0].title;
        let budget = 45000;
        for (const f of pick) { if (budget <= 0) break; try { w.status("tool", `بقرأ ${f.title}…`); const idx = await fileTextIndex(f); const t = idx.map(p => p.text).join("\n").slice(0, st.file ? 45000 : Math.max(6000, budget / pick.length)); material += `\n=== ${f.title} ===\n${t}`; budget -= t.length; } catch { material += `\n=== ${f.title} === (ما قدرت أقرأ الملف، اعتمد على العنوان)`; } }
      } else if (st.src === "weak") { label = "نقاط ضعفي"; material = S.get("weak", []).slice(-25).map(x => `- ${x.topic}${x.src ? " (" + x.src + ")" : ""}`).join("\n") || "ما في نقاط ضعف مسجّلة؛ اسأل أسئلة عامة من مواده: " + data.courses.map(c => c.name).join("، "); }
      else { if (!st.topic.trim()) { w.stop(); prep.innerHTML = `<div class="err">اكتب الموضوع</div>`; return; } label = st.topic.trim(); material = "الموضوع: " + st.topic.trim(); }
    } catch (e) { w.stop(); prep.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    w.stop(); prep.innerHTML = "";
    voiceSession({
      title: "🎧 " + label, subtitle: "مراجعة صوتية", score: true, src: label, saveToChat: false,
      sys: `إنت مدرّس خصوصي بتعمل مراجعة صوتية للطالب (سنة خامسة نظم حاسوبية بجامعة البلقاء).` + DIALECT + `
طريقة المراجعة:
- اسأل سؤال واحد بس كل مرة، واضح وقصير، مستواه ${st.level}، ونوّع: تعريف، فهم، مقارنة، مثال، تطبيق صغير.
- استنى جوابه. قيّمه بمرونة (المهم الفكرة مش نفس الكلمات). إذا صح: مدح قصير وإضافة معلومة صغيرة. إذا غلط أو ناقص: صحّحه بلطف واشرح بجملتين بمثال.
- بعد كل تقييم استدعي record_answer.
- إذا قال "ما بعرف" أو طلب تلميح: اعطيه تلميح أو اشرح وانتقل.
- إذا طلب يغيّر الموضوع أو يصعّب أو يسهّل، اعمل اللي بده.
- بعد ${st.n} أسئلة: احكيله نتيجته وشو أكثر إشي لازم يراجعه، واسأله إذا بده يكمّل.
- اعتمد على هاي المادة:
${material.slice(0, 50000)}`,
      kickoff: `(ابدأ: رحّب بالطالب بجملة قصيرة، قلّه إنكم رح تراجعوا «${label}» بـ ${st.n} أسئلة، واسأل أول سؤال.)`
    });
  };
  draw();
};
