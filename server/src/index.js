// واجباتي server (Cloudflare Worker + KV, free tier).
// POST /trial {user} -> the trial's start/end for that university ID. The first call starts the trial;
// every later call (new phone, reinstall, cleared data) returns the same dates.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/") return json({ ok: true, app: "wajebati", now: Date.now() });
    if (url.pathname === "/trial" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch {}
      const user = String(body.user || "").trim().toLowerCase();
      if (!/^[a-z0-9._@-]{3,40}$/.test(user)) return json({ error: "bad user" }, 400);
      const days = Number(env.TRIAL_DAYS || 3);
      const key = "trial:" + user;
      let start = Number(await env.WAJEBATI.get(key));
      if (!start) { start = Date.now(); await env.WAJEBATI.put(key, String(start)); }
      return json({ user, start, end: start + days * 864e5, now: Date.now() });
    }
    return json({ error: "not found" }, 404);
  }
};
