/* AI assistant — calls Claude or Gemini directly from the phone with the user's own key (kept in this browser only). */
const AI = (() => {
  const S = Moodle.store;
  const defaults = {
    provider: "gemini",
    claudeKey: "", claudeModel: "claude-sonnet-5-5",
    geminiKey: "", geminiModel: "gemini-3.8-flash", geminiAuto: true
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
    if (/^gemini-(1|2)\./.test(s.geminiModel)) { s.geminiModel = defaults.geminiModel; S.set("ai.settings", s); } // old retired models
    return s;
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
  async function chat({ system, messages, onText, onModel, signal, json = false, depth = "fast" }) {
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
      const baseBody = ({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [
          ...(m.docs || []).map(d => ({ inline_data: { mime_type: d.mime, data: d.data } })),
          ...(m.images || []).map(im => ({ inline_data: { mime_type: im.mime, data: im.data } })),
          { text: m.text || " " }
        ] }))
      });
      const noThink = S.get("ai.nothink", {}); // models that refuse the thinking setting
      const makeBody = (model) => {
        const gc = { temperature: json ? 0.4 : 0.7 };
        if (json) gc.responseMimeType = "application/json";
        // fast replies: keep the model's "thinking" short in chat; let it think more for study material
        if (!noThink[model]) gc.thinkingConfig = { thinkingLevel: depth === "deep" ? "high" : "low" };
        return JSON.stringify({ ...baseBody, generationConfig: gc });
      };
      const chain = s.geminiAuto ? await freeChain(s.geminiKey) : [s.geminiModel];
      const cool = S.get("ai.cooldown", {});
      const t0 = Date.now();
      const tryList = chain.filter(m => !(cool[m] > t0));
      if (!tryList.length) {
        const soon = Math.min(...chain.map(m => cool[m] || t0));
        throw new Error(`خلصت كل الموديلات المجانية لهلأ 😅 بترجع تشتغل حوالي الساعة ${new Date(soon).toLocaleTimeString("ar-JO", { hour: "numeric", minute: "2-digit" })}.`);
      }
      let lastErr = null;
      for (const model of tryList) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(s.geminiKey)}`;
        // each try gets its own timer: if a model doesn't start answering in time, move to the next one
        const ctl = new AbortController(); const onAbort = () => ctl.abort(); signal && signal.addEventListener("abort", onAbort);
        let timer = setTimeout(() => ctl.abort("slow"), depth === "deep" ? 45000 : 20000);
        let res;
        try { res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" }, body: makeBody(model) }); }
        catch (e) { clearTimeout(timer); signal && signal.removeEventListener("abort", onAbort); if (signal && signal.aborted) throw e; lastErr = new Error("الموديل تأخر أو انقطع النت"); continue; }
        if (res.ok) {
          clearTimeout(timer); timer = null;
          let stall = setTimeout(() => ctl.abort("stall"), 30000); // stream froze
          const bump = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort("stall"), 30000); };
          usedModel = model;
          onModel && onModel(model);
          try {
            await readSSE(res, ev => {
              bump();
              const parts = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
              if (parts) for (const p of parts) if (p.text && !p.thought) { full += p.text; onText(full); }
            });
          } catch (e) { if (signal && signal.aborted) throw e; if (full) { clearTimeout(stall); return full + "\n\n_(انقطع الرد)_"; } }
          finally { clearTimeout(stall); signal && signal.removeEventListener("abort", onAbort); }
          if (full) return full;
          lastErr = new Error("الموديل ما رد بإشي"); continue;
        }
        clearTimeout(timer); signal && signal.removeEventListener("abort", onAbort);
        let j = {}; try { j = await res.json(); } catch {}
        const msg = (j.error && j.error.message) || res.statusText;
        if (res.status === 401 || (res.status === 400 && /API key/i.test(msg)) || res.status === 403 && /key/i.test(msg))
          throw new Error("مفتاح Gemini غلط. راجعه من الإعدادات.");
        if (res.status === 429) {
          // daily limit → wait till quota resets (midnight Pacific ≈ 10:00 Amman); per-minute → short wait
          const daily = /per.?day|PerDay|daily/i.test(JSON.stringify(j));
          const retry = JSON.stringify(j).match(/"retryDelay":\s*"(\d+)s"/);
          cool[model] = daily ? nextPacificMidnight() : Date.now() + ((retry ? +retry[1] : 60) + 2) * 1000;
          S.set("ai.cooldown", cool); lastErr = new Error("وصلت الحد"); continue;
        }
        if (res.status === 400 && /thinking/i.test(msg) && !noThink[model]) {
          noThink[model] = 1; S.set("ai.nothink", noThink); tryList.splice(tryList.indexOf(model) + 1, 0, model); continue;
        }
        if (res.status === 404 || (res.status === 400 && /model|not supported|not available/i.test(msg))) {
          cool[model] = Date.now() + 24 * 3600 * 1000; S.set("ai.cooldown", cool);
          S.del("ai.freechain"); lastErr = new Error(msg); continue;
        }
        if (res.status >= 500) { lastErr = new Error("سيرفرات Google مضغوطة"); await new Promise(r => setTimeout(r, 600)); continue; }
        throw new Error("خطأ من Gemini: " + msg);
      }
      throw new Error(lastErr && lastErr.message === "وصلت الحد"
        ? "كل الموديلات المجانية وصلت حدها هلأ. استنى دقيقة وجرّب." : "ما زبط: " + (lastErr ? lastErr.message : ""));
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
    const blocks = []; let s = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, l, code) => { blocks.push(`<pre><code>${esc(code)}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    s = esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
    const lines = s.split("\n"); let html = "", list = null;
    for (const ln of lines) {
      const ul = ln.match(/^\s*[-*•]\s+(.*)/), ol = ln.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) { const t = ul ? "ul" : "ol"; if (list !== t) { if (list) html += `</${list}>`; html += `<${t}>`; list = t; } html += `<li>${(ul || ol)[1]}</li>`; continue; }
      if (list) { html += `</${list}>`; list = null; }
      if (ln.trim()) html += `<p>${ln}</p>`;
    }
    if (list) html += `</${list}>`;
    return html.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[i]).replace(/<p>(<pre>[\s\S]*?<\/pre>)<\/p>/g, "$1");
  }

  return { settings, save, ready, chat, imageFromFile, md, freeChain, get usedModel() { return usedModel; } };
})();
