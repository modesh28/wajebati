/* AI assistant — calls Claude or Gemini directly from the phone with the user's own key (kept in this browser only). */
const AI = (() => {
  const S = Moodle.store;
  const defaults = {
    provider: "claude",
    claudeKey: "", claudeModel: "claude-sonnet-5-5",
    geminiKey: "", geminiModel: "gemini-3.8-flash"
  };
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
  async function chat({ system, messages, onText, signal }) {
    const s = settings();
    let full = "";
    if (s.provider === "claude") {
      const body = {
        model: s.claudeModel, max_tokens: 4096, stream: true, system,
        messages: messages.map(m => ({ role: m.role, content: [
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
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [
          ...(m.images || []).map(im => ({ inline_data: { mime_type: im.mime, data: im.data } })),
          { text: m.text || " " }
        ] }))
      };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(s.geminiKey)}`;
      let res = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const msg = await errText(res);
        const m = msg.match(/use models\/([\w.-]+)/);
        if (m && m[1] !== s.geminiModel) {
          save({ geminiModel: m[1] });
          res = await fetch(url.replace(encodeURIComponent(s.geminiModel), encodeURIComponent(m[1])), { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(await errText(res));
        } else throw new Error(msg);
      }
      await readSSE(res, ev => {
        const parts = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
        if (parts) for (const p of parts) if (p.text) { full += p.text; onText(full); }
      });
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

  return { settings, save, ready, chat, imageFromFile, md };
})();
