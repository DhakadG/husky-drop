// Device identity for drop and share pages. Fingerprint Pro (public key,
// server-side matching, free tier) gives a visitor id that survives cleared
// cookies; the vendored open-source agent (vendor-fp.js, MIT) is the
// fallback when an ad blocker eats the Pro script. Either id is kept in the
// hd_fp cookie so every later request carries it without extra plumbing.
const FP_PRO_KEY = "Ju77MjhZRhdHsc51ifga";
const FP_PRO_REGION = "ap";
const cookie = (n) => document.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`))?.[1] || "";

export async function identify({ slug = "", sessionId = "", linkedId = "", kind = "" } = {}) {
  let fp = cookie("hd_fp");
  let fpEvent = "";
  // Pro runs every visit: the event id lets the worker pull the server-side
  // verdict (VPN, proxy, tampering, velocity...) for this exact page load.
  try {
    const pro = await import(`https://fpjscdn.net/v4/${FP_PRO_KEY}`).then((m) => m.start({ region: FP_PRO_REGION }));
    // linkedId = the signed-in account (when known); tag = what they opened.
    const r = await pro.get({ linkedId: linkedId || undefined, tag: { slug, kind, sessionId } });
    fpEvent = r.event_id || "";
    fp = r.visitor_id || fp;
  } catch {}
  if (!fp) {
    try {
      fp = window.FingerprintJS ? (await (await window.FingerprintJS.load()).get()).visitorId : "";
    } catch {}
  }
  if (fp) document.cookie = `hd_fp=${fp}; Path=/; Max-Age=${400 * 86400}; Secure; SameSite=Lax`;
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
  fetch("/api/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fp, fpEvent, slug, sessionId, meta }), keepalive: true }).catch(() => {});
  return fp;
}
