/* Service worker: offline app shell + background checks (Android Chrome, installed app) + notification clicks */
const CACHE = "wajebati-v8";
const SHELL = ["./", "index.html", "styles.css?v=8", "moodle.js?v=8", "ai.js?v=8", "app.js?v=8", "study.js?v=8", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const SITE = "https://s1.ebalqa.courses";

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== "wajebati-state").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // never touch Moodle / AI requests
  // network first so updates arrive, cache as fallback for offline
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});

async function backgroundCheck() {
  const state = await caches.open("wajebati-state");
  const res = await state.match("session"); if (!res) return;
  const { session, known = [] } = await res.json();
  if (!session || !session.token) return;
  const body = new URLSearchParams({ wstoken: session.token, wsfunction: "core_calendar_get_action_events_by_timesort",
    timesortfrom: Math.floor(Date.now() / 1000), limitnum: 50 });
  const r = await fetch(`${SITE}/webservice/rest/server.php?moodlewsrestformat=json`, { method: "POST", body });
  const j = await r.json(); if (!j.events) return;
  const knownSet = new Set(known);
  const fresh = j.events.filter(ev => !knownSet.has(`${ev.modulename}:${ev.instance}`));
  for (const ev of fresh.slice(0, 5)) {
    await self.registration.showNotification(ev.modulename === "quiz" ? "نزل كويز جديد 📝" : "نزل إشي جديد 📚", {
      body: `${ev.activityname || ev.name} — ${(ev.course && ev.course.fullname) || ""}`, icon: "icons/icon-192.png",
      tag: `${ev.modulename}-${ev.instance}`, data: { url: `./#${ev.modulename}-${ev.instance}` } });
  }
  const all = [...new Set([...known, ...j.events.map(ev => `${ev.modulename}:${ev.instance}`)])];
  await state.put("session", new Response(JSON.stringify({ session, known: all })));
}
self.addEventListener("periodicsync", e => { if (e.tag === "check-elearning") e.waitUntil(backgroundCheck().catch(() => {})); });
