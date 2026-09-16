// Device identity for drop and share pages. FingerprintJS (vendor-fp.js,
// MIT) gives a visitor id that survives cleared cookies; it is kept in the
// hd_fp cookie so every later request carries it without extra plumbing.
// One "hello" per page load sends the id plus client details the admin can
// use to tell devices apart.
const cookie = (n) => document.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`))?.[1] || "";

export async function identify({ slug = "", sessionId = "" } = {}) {
  let fp = cookie("hd_fp");
  if (!fp && window.FingerprintJS) {
    try {
      fp = (await (await window.FingerprintJS.load()).get()).visitorId;
      document.cookie = `hd_fp=${fp}; Path=/; Max-Age=${400 * 86400}; Secure; SameSite=Lax`;
    } catch {}
  }
  const c = navigator.connection || {};
  const ua = navigator.userAgentData;
  const meta = {
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    viewport: `${innerWidth}x${innerHeight}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: navigator.language,
    platform: ua?.platform || navigator.platform,
    browser: ua?.brands?.map((b) => `${b.brand} ${b.version}`).filter((b) => !/Not/.test(b)).join(", ") || "",
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    touch: navigator.maxTouchPoints,
    conn: c.effectiveType,
    standalone: matchMedia("(display-mode: standalone)").matches,
    ref: document.referrer.slice(0, 120),
  };
  fetch("/api/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fp, slug, sessionId, meta }), keepalive: true }).catch(() => {});
  return fp;
}
