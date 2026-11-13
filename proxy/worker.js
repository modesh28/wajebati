// واجباتي — tiny file proxy (Cloudflare Worker, free plan).
// The university's site doesn't let other websites download course files directly (CORS),
// so this worker fetches ONLY course files from s1.ebalqa.courses and passes them to the app.
const ALLOWED_HOST = "s1.ebalqa.courses";
const ALLOWED_ORIGIN = "https://modesh28.github.io";

export default {
  async fetch(request) {
    const cors = { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get("url");
    let u;
    try { u = new URL(target); } catch { return new Response("bad url", { status: 400, headers: cors }); }
    if (u.protocol !== "https:" || u.hostname !== ALLOWED_HOST || !u.pathname.startsWith("/webservice/pluginfile.php/"))
      return new Response("not allowed", { status: 403, headers: cors });
    const r = await fetch(u.toString(), { redirect: "follow" });
    const h = new Headers(cors);
    for (const k of ["content-type", "content-length", "content-disposition"]) if (r.headers.get(k)) h.set(k, r.headers.get(k));
    h.set("Cache-Control", "no-store");
    return new Response(r.body, { status: r.status, headers: h });
  }
};
