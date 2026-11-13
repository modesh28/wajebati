/* AI assistant — calls the AI model directly from the phone with the user's own key (kept in this browser only). */
const AI = (() => {
  const S = Moodle.store;
  const defaults = {
    provider: "gemini",
    claudeKey: "", claudeModel: "claude-sonnet-5-5",
    geminiKey: "", geminiModel: "gemini-3.8-flash", geminiAuto: true, lang: "both"
  };
  let usedModel = null;
  const FALLBACK_FREE = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
  function nextPacificMidnight() {
    const n = new Date(); const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 8, 5));
    if (d <= n) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  // Free models: ask Google which Flash / Flash-Lite models this key can use (Pro models aren't free), newest first.
  async function freeChain(key) {
    const c = S.get("ai.freechain");
    if (c && c.key === key.slice(-6) && Date.now() - c.t < 24 * 3600 * 1000 && c.list.length) return c.list;
    let list = [];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
      const j = await r.json();
      list = (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""))
        .filter(n => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(n)); // stable Flash / Flash-Lite only
      const ver = n => parseFloat(n.match(/gemini-([\d.]+)/)[1]);
      list.sort((a, b) => (a.includes("lite") - b.includes("lite")) || ver(b) - ver(a));
    } catch {}
    if (!list.length) list = FALLBACK_FREE;
    S.set("ai.freechain", { key: key.slice(-6), t: Date.now(), list });
    return list;
  }
  function settings() {
    const s = Object.assign({}, defaults, S.get("ai.settings", {}));
    s.provider = "gemini";
    if (/^gemini-(1|2)\./.test(s.geminiModel)) { s.geminiModel = defaults.geminiModel; S.set("ai.settings", s); } // old retired models
    return s;
  }
  // how the AI should explain: both languages (default), Arabic, or English — always from zero
  function langRule() {
    const l = settings().lang;
    const zero = "درّس من الصفر: افترض إنه الطالب أول مرة بيسمع بالموضوع، ابدأ بالأساسيات والمتطلبات السابقة بجملة، وبعدين ابني خطوة خطوة، وكل مصطلح جديد عرّفه أول ما يطلع، واستخدم تشبيهات من الحياة وأمثلة محلولة.";
    if (l === "en") return zero + " Answer fully in clear, simple English (the student is Arabic-speaking: keep sentences short and define every technical term).";
    if (l === "ar") return zero + " احكي باللهجة الأردنية، والمصطلحات التقنية بالإنجليزي بين قوسين.";
    return zero + " اشرح بالعربي والإنجليزي مع بعض: كل فكرة اشرحها أول بالعربي (لهجة أردنية بسيطة)، وبعدها سطر **In English:** بنفس الفكرة بإنجليزي بسيط، عشان الطالب يفهم ويتعوّد على لغة الامتحان. وكل مصطلح اكتبه هيك: العربي (English).";
  }
  function save(s) { S.set("ai.settings", Object.assign(settings(), s)); }
  function ready() { const s = settings(); return s.provider === "claude" ? !!s.claudeKey : !!s.geminiKey; }

  // Read SSE stream line by line
  async function readSSE(res, onData) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("data:")) { const d = line.slice(5).trim(); if (d && d !== "[DONE]") { try { onData(JSON.parse(d)); } catch {} } }
      }
    }
  }

  async function errText(res) {
    let t = ""; try { const j = await res.json(); t = (j.error && (j.error.message || j.error.type)) || JSON.stringify(j); } catch { t = res.statusText; }
    if (res.status === 401 || res.status === 403) return "المفتاح (API key) غلط أو ما إله صلاحية. راجعه من الإعدادات.";
    if (res.status === 429) return "وصلت الحد المسموح هلأ. استنى شوي وجرّب، أو بدّل للموديل الثاني من الإعدادات.";
    if (res.status === 404) return "اسم الموديل مش موجود: " + t + " — غيّره من الإعدادات.";
    return "خطأ من مزوّد الذكاء الاصطناعي: " + t;
  }

  // messages: [{role:"user"|"assistant", text, images:[{mime,data(base64)}]}]
  async function chat({ system, messages, onText, onModel, onStatus, signal, json = false, depth = "fast", tools = null }) {
    const s = settings();
    let full = "";
    if (s.provider === "claude") {
      const body = {
        model: s.claudeModel, max_tokens: 8000, stream: true, system,
        messages: messages.map(m => ({ role: m.role, content: [
          ...(m.docs || []).map(d => ({ type: "document", source: { type: "base64", media_type: d.mime, data: d.data } })),
          ...(m.images || []).map(im => ({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } })),
          { type: "text", text: m.text || " " }
        ] }))
      };
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-api-key": s.claudeKey, "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await errText(res));
      await readSSE(res, ev => {
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { full += ev.delta.text; onText(full); }
        if (ev.type === "error") throw new Error(ev.error && ev.error.message);
      });
    } else {
      const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [
        ...(m.docs || []).map(d => ({ inline_data: { mime_type: d.mime, data: d.data } })),
        ...(m.audio || []).map(a => ({ inline_data: { mime_type: a.mime, data: a.data } })),
        ...(m.images || []).map(im => ({ inline_data: { mime_type: im.mime, data: im.data } })),
        { text: m.text || " " }
      ] }));
      const toolDecl = tools && tools.length ? [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, ...(parameters ? { parameters } : {}) })) }] : null;
      const noThink = S.get("ai.nothink", {}); // models that refuse the thinking setting
      const makeBody = (model) => {
        const gc = { temperature: json ? 0.4 : 0.7 };
        if (json) gc.responseMimeType = "application/json";
        // fast replies: keep the model's "thinking" short in chat; let it think more for study material
        if (!noThink[model]) gc.thinkingConfig = { thinkingLevel: depth === "deep" ? "medium" : depth === "smart" ? "low" : "minimal", includeThoughts: true };
        return JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: gc, ...(toolDecl ? { tools: toolDecl } : {}) });
      };
      const chain = s.geminiAuto ? await freeChain(s.geminiKey) : [s.geminiModel];
      const cool = S.get("ai.cooldown", {});
      if (!chain.some(m => !(cool[m] > Date.now()))) {
        const soon = Math.min(...chain.map(m => cool[m] || Date.now()));
        throw new Error(`المساعد وصل حده لهلأ 😅 بيرجع يشتغل حوالي الساعة ${new Date(soon).toLocaleTimeString("ar-JO", { hour: "numeric", minute: "2-digit" })}.`);
      }
      const HEDGE = depth === "deep" ? 8000 : 4000, FIRST_BYTE = depth === "deep" ? 45000 : 20000, STALL = 25000;
      // One request. Race: start the best model; if it hasn't started answering within a few seconds,
      // start the next one too and keep whichever answers first (the other is cancelled).
      const round = () => new Promise((resolve, reject) => {
        const queue = chain.filter(m => !(cool[m] > Date.now()));
        let winner = null, done = false, active = 0, lastErr = null, hedgeTimer = null;
        const attempts = new Set();
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(hedgeTimer); attempts.forEach(c => c.abort("lost")); signal && signal.removeEventListener("abort", onUserAbort); fn(v); };
        const onUserAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; finish(reject, e); };
        if (signal) { if (signal.aborted) return onUserAbort(); signal.addEventListener("abort", onUserAbort); }
        const failNext = (err) => {
          lastErr = err || lastErr;
          if (done || winner) return;
          if (queue.length) start();
          else if (active === 0) finish(reject, new Error(lastErr && lastErr.message === "وصلت الحد"
            ? "المساعد مضغوط هلأ، جرّب كمان دقيقة." : "ما زبط: " + (lastErr ? lastErr.message : "")));
        };
        const scheduleHedge = () => { clearTimeout(hedgeTimer); hedgeTimer = setTimeout(() => { if (!winner && !done && queue.length) { onStatus && onStatus("slow"); start(); scheduleHedge(); } }, HEDGE); };
        async function start() {
          const model = queue.shift(); if (!model) return;
          active++;
          const ctl = new AbortController(); attempts.add(ctl);
          onStatus && onStatus("try", model);
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(s.geminiKey)}`;
          let timer = setTimeout(() => ctl.abort("slow"), FIRST_BYTE);
          let mine = "", res; const calls = [], parts = [];
          const end = () => { clearTimeout(timer); attempts.delete(ctl); active--; };
          try { res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" }, body: makeBody(model) }); }
          catch (e) { end(); if (!done) failNext(new Error("الموديل تأخر أو انقطع النت")); return; }
          if (!res.ok) {
            let j = {}; try { j = await res.json(); } catch {}
            end();
            if (done) return;
            const msg = (j.error && j.error.message) || res.statusText;
            if (res.status === 401 || (res.status === 400 && /API key/i.test(msg)) || (res.status === 403 && /key/i.test(msg)))
              return finish(reject, new Error("مفتاح الذكاء الاصطناعي غلط. راجعه من الإعدادات."));
            if (res.status === 429) {
              const daily = /per.?day|PerDay|daily/i.test(JSON.stringify(j));
              const retry = JSON.stringify(j).match(/"retryDelay":\s*"(\d+)s"/);
              cool[model] = daily ? nextPacificMidnight() : Date.now() + ((retry ? +retry[1] : 60) + 2) * 1000;
              S.set("ai.cooldown", cool); return failNext(new Error("وصلت الحد"));
            }
            if (res.status === 400 && /thinking/i.test(msg) && !noThink[model]) { noThink[model] = 1; S.set("ai.nothink", noThink); queue.unshift(model); return failNext(); }
            if (res.status === 404 || (res.status === 400 && /model|not supported|not available/i.test(msg))) {
              cool[model] = Date.now() + 24 * 3600 * 1000; S.set("ai.cooldown", cool); S.del("ai.freechain"); return failNext(new Error(msg));
            }
            if (res.status >= 500) return failNext(new Error("السيرفر مضغوط"));
            return finish(reject, new Error("صار خطأ بالمساعد: " + msg));
          }
          clearTimeout(timer);
          timer = setTimeout(() => ctl.abort("slow"), FIRST_BYTE); // still waiting for the first words
          const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort("stall"), STALL); };
          const claim = () => { if (!winner) { winner = model; usedModel = model; clearTimeout(hedgeTimer); attempts.forEach(c => c !== ctl && c.abort("lost")); onModel && onModel(model); } return winner === model; };
          try {
            await readSSE(res, ev => {
              const ps = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
              if (!ps) return;
              for (const p of ps) {
                if (p.thought) { bump(); if (!winner) onStatus && onStatus("thinking", model); continue; }
                if (p.functionCall) { if (!claim()) return; bump(); calls.push(p.functionCall); parts.push(p); continue; }
                if (!p.text) { if (p.thoughtSignature && winner === model) parts.push(p); continue; }
                if (!claim()) return;
                bump(); mine += p.text; parts.push(p); onText(mine);
              }
            });
          } catch (e) {
            end();
            if (done) return;
            if (winner === model) return finish(resolve, { text: mine + (calls.length ? "" : "\n\n_(انقطع الرد)_"), calls, parts });
            return failNext(new Error("الموديل علّق"));
          }
          end();
          if (done) return;
          if (winner === model) return finish(resolve, { text: mine, calls, parts });
          if (!winner) failNext(new Error("الموديل ما رد بإشي"));
        }
        start(); scheduleHedge();
      });
      // The assistant can use tools (look up your courses, open lecture files, check deadlines…):
      // run them and continue until it gives the final answer.
      for (let r = 0; r < 6; r++) {
        const out = await round();
        if (!out.calls.length || !tools) return out.text;
        contents.push({ role: "model", parts: out.parts });
        const resp = [], extra = [];
        for (const c of out.calls) {
          const tool = tools.find(t => t.name === c.name);
          onStatus && onStatus("tool", tool && tool.label ? tool.label(c.args || {}) : c.name);
          let res;
          try { res = tool ? await tool.execute(c.args || {}) : { error: "unknown tool" }; } catch (e) { res = { error: e.message }; }
          if (res && res.attach) { for (const d of res.attach) extra.push({ inline_data: { mime_type: d.mime, data: d.data } }); delete res.attach; }
          resp.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: res && typeof res === "object" ? res : { result: res } } });
        }
        contents.push({ role: "user", parts: [...resp, ...extra] });
      }
      return "ما قدرت أكمّل، جرّب تسأل بطريقة ثانية.";
    }
    return full;
  }

  // Shrink a photo before sending (keeps cost and upload time low)
  function imageFromFile(file, max = 1568) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas"); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const dataUrl = c.toDataURL("image/jpeg", 0.85);
        resolve({ mime: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("ما قدرت أقرأ الصورة")); };
      img.src = url;
    });
  }

  // Tiny, safe markdown renderer for answers
  function md(src) {
    const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const blocks = []; let s = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, l, code) => { blocks.push(`<pre class="lang-${esc(l || "txt")}"><code>${esc(code)}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
    const lines = s.split("\n"); let html = "", list = null, table = null;
    const flushTable = () => { if (!table) return; const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)); html += `<div class="tbl"><table>` + rows.map((r, i) => `<tr>${r.replace(/^\s*\||\|\s*$/g, "").split("|").map(c => i ? `<td dir="auto">${c.trim()}</td>` : `<th dir="auto">${c.trim()}</th>`).join("")}</tr>`).join("") + `</table></div>`; table = null; };
    for (const ln of lines) {
      if (/^\s*\|.*\|\s*$/.test(ln)) { if (list) { html += `</${list}>`; list = null; } (table = table || []).push(ln); continue; }
      flushTable();
      const ul = ln.match(/^\s*[-*•]\s+(.*)/), ol = ln.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) { const t = ul ? "ul" : "ol"; if (list !== t) { if (list) html += `</${list}>`; html += `<${t}>`; list = t; } html += `<li dir="auto">${(ul || ol)[1]}</li>`; continue; }
      if (list) { html += `</${list}>`; list = null; }
      if (ln.trim()) html += `<p dir="auto">${ln}</p>`;
    }
    if (list) html += `</${list}>`;
    flushTable();
    return html.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[i]).replace(/<p>(<pre>[\s\S]*?<\/pre>)<\/p>/g, "$1");
  }

  return { langRule, settings, save, ready, chat, imageFromFile, md, freeChain, get usedModel() { return usedModel; } };
})();
