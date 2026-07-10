# Plan 01 — Homepage (`public/index.html`)

**Files touched:** `public/index.html`, `public/style.css`.
**Depends on:** plan 00 (tokens, `.grad-text`, `.eyebrow`, `.bar`, `.icon-tile`, `.glass-tile`, `.brand-slash`, `.bg-fx`, pill `.btn`, icon library §D).
**New assets:** none.
**Mockup:** `Home.dc.html`.

Deliberate deviations from the mockup (do not "fix" these):
- Footer keeps **privacy / terms** links and the contact address — required for the Google OAuth consent screen (the mockup's "demo drop" and "docs" links have no real public URLs).
- The second hero CTA scrolls to the how-it-works section (`#how`) instead of linking a demo drop page.

---

### Change 1: canonical fonts link
**File:** `public/index.html`
**Why:** Standardize on the design-system font weights (Unbounded 600/700/800).
**Locate:**
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/style.css" />
</head>
<body class="home">
<main class="home-shell">
```
**Action:** REPLACE
**Old code:**
```html
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
```
**New code:**
```html
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
```
**Verify:** Fonts still load; headings render in Unbounded.

### Change 2: replace the whole page body
**File:** `public/index.html`
**Why:** The homepage is fully redesigned (hero grid + floating drop card, three steps, feature strip, slim footer). No JS on this page, so a single replacement is safest for the executor.
**Locate:**
```html
<link rel="stylesheet" href="/style.css" />
</head>
<body class="home">
<main class="home-shell">
  <nav class="topbar">
    <a class="brand" href="/"><i class="brand-mark"></i>losthusky<span>/</span>drop</a>
    <div class="nav-cluster">
```
**Action:** REPLACE
**Old code:**
```html
<body class="home">
<main class="home-shell">
  <nav class="topbar">
    <a class="brand" href="/"><i class="brand-mark"></i>losthusky<span>/</span>drop</a>
    <div class="nav-cluster">
      <a class="nav-link" href="/privacy">privacy</a>
      <a class="nav-link" href="/terms">terms</a>
      <a class="nav-link" href="/admin">admin</a>
    </div>
  </nav>

  <section class="home-hero">
    <div class="hero-copy-block">
      <p class="eyebrow">private media transfer and share gallery</p>
      <h1>LostHusky Drop</h1>
      <p class="hero-copy">
        A personal file drop and gallery system for collecting original photos
        and videos, saving them to Google Drive, and sharing polished private
        albums with the people who need access.
      </p>
      <div class="hero-actions">
        <a class="btn" href="/admin">Open dashboard</a>
        <a class="btn ghost" href="/privacy">Privacy policy</a>
      </div>
    </div>
    <div class="home-console panel" aria-label="app capabilities">
      <div class="console-head">
        <span></span><span></span><span></span>
      </div>
      <div class="console-grid">
        <div><b>630</b><span>file gallery support</span></div>
        <div><b>ZIP64</b><span>server streamed archives</span></div>
        <div><b>OAuth</b><span>viewer identity for private shares</span></div>
        <div><b>Live</b><span>transfer queue monitoring</span></div>
      </div>
      <div class="console-queue" aria-hidden="true">
        <p><span style="width:64%"></span></p>
        <p><span style="width:87%"></span></p>
        <p><span style="width:42%"></span></p>
      </div>
    </div>
  </section>

  <section class="home-section">
    <div>
      <p class="eyebrow">what it does</p>
      <h2>Collect originals, track transfers, and share galleries without passing files through the app server.</h2>
    </div>
    <p class="section-copy">
      Uploaders send files through private drop links. The browser uploads
      directly to Google Drive using resumable sessions, while the app handles
      access control, progress, metadata, gallery browsing, and owner-facing
      activity history.
    </p>
  </section>

  <section class="feature-band">
    <div>
      <b>Direct Drive uploads</b>
      <span>Large photos and videos use Google Drive resumable upload sessions instead of Worker file buffering.</span>
    </div>
    <div>
      <b>Private share galleries</b>
      <span>PIN protected albums support responsive tiles, media viewing, thumbnails, downloads, and server ZIPs.</span>
    </div>
    <div>
      <b>Google sign-in gate</b>
      <span>Optional OAuth sign-in lets owners see which signed-in viewer opened, viewed, or downloaded share content.</span>
    </div>
    <div>
      <b>Live transfer queue</b>
      <span>The dashboard shows active uploaders, per-file progress, throughput, ETA, and recent activity.</span>
    </div>
  </section>

  <section class="home-section home-split">
    <div class="panel">
      <p class="eyebrow">security model</p>
      <h2>Access is scoped to private links.</h2>
      <p class="section-copy">
        Drop links and share links can expire, pause, require a PIN, and limit
        usage. Share download URLs are short-lived and refreshed only after the
        same share checks pass again.
      </p>
    </div>
    <div class="panel">
      <p class="eyebrow">public documents</p>
      <h2>Consent-screen links</h2>
      <div class="legal-link-grid">
        <a href="/privacy">Application privacy policy</a>
        <a href="/terms">Application terms of service</a>
      </div>
      <p class="muted">For questions about this application, contact notify@losthusky.qzz.io.</p>
    </div>
  </section>

  <section class="home-foot">
    <span>LostHusky Drop</span>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </section>
</main>
```
**New code:**
```html
<body class="home">
<div class="bg-fx" aria-hidden="true"></div>
<main class="home-shell home-v3">
  <nav class="topbar">
    <a class="brand" href="/"><i class="brand-mark"></i><span>losthusky <span class="brand-slash">/</span> drop</span></a>
    <a class="nav-link admin-pill" href="/admin">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="10" width="14" height="10" rx="2.5" opacity="0.25"></rect><path d="M7 10V8a5 5 0 0 1 10 0v2h-2V8a3 3 0 0 0-6 0v2H7zm-2 2h14v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z"></path></svg>
      Admin
    </a>
  </nav>

  <section class="hero-v3">
    <div class="hero-v3-copy">
      <span class="eyebrow">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11l-1 8.5L18.5 10H12l1-8z"></path></svg>
        self-hosted · your Drive, your rules
      </span>
      <h1>Collect original-quality files, <span class="grad-text">straight into your Drive.</span></h1>
      <p class="hero-v3-sub">
        Send friends a link. They drop photos and videos — full resolution, no
        compression, multi-gigabyte files — and everything lands organized in
        your Google Drive. No accounts, no apps, no WhatsApp crunch.
      </p>
      <div class="hero-actions">
        <a class="btn" href="/admin">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z"></path></svg>
          Create a drop link
        </a>
        <a class="btn ghost" href="#how">
          See how it works
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5l7 7-7 7-1.4-1.4L13.2 12 7.6 6.4 9 5z"></path></svg>
        </a>
      </div>
      <div class="hero-v3-checks">
        <span><svg width="12" height="12" viewBox="0 0 24 24" fill="#1fb27a"><path d="M10.4 17.2l-5-5 1.4-1.4 3.6 3.6 7.8-7.8 1.4 1.4-9.2 9.2z"></path></svg>resumable uploads</span>
        <span><svg width="12" height="12" viewBox="0 0 24 24" fill="#1fb27a"><path d="M10.4 17.2l-5-5 1.4-1.4 3.6 3.6 7.8-7.8 1.4 1.4-9.2 9.2z"></path></svg>no size limits</span>
        <span><svg width="12" height="12" viewBox="0 0 24 24" fill="#1fb27a"><path d="M10.4 17.2l-5-5 1.4-1.4 3.6 3.6 7.8-7.8 1.4 1.4-9.2 9.2z"></path></svg>zero storage cost</span>
      </div>
    </div>

    <div class="hero-v3-visual" aria-hidden="true">
      <div class="hero-v3-glow"></div>
      <div class="mini-drop-card">
        <div class="mini-drop-head">
          <span class="mini-drop-icon">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 3a1 1 0 0 1 .7.3l4.5 4.5a1 1 0 0 1-1.4 1.4L13 6.4V15a1 1 0 1 1-2 0V6.4L8.2 9.2a1 1 0 0 1-1.4-1.4l4.5-4.5A1 1 0 0 1 12 3z"></path><path d="M4 15a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2a1 1 0 0 1 1-1z" opacity="0.6"></path></svg>
          </span>
          <div><div class="mini-drop-title">Jibhi &amp; Koksar</div><div class="mini-drop-meta">96 files · 6.2 GB</div></div>
          <span class="mini-drop-pct">68%</span>
        </div>
        <div class="bar"><i style="width:68%"></i></div>
        <div class="mini-drop-files">
          <div class="glass-tile mini-file">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#1fb27a"><circle cx="12" cy="12" r="10" opacity="0.16"></circle><path d="M10.4 15.2l-3-3 1.3-1.3 1.7 1.7 4.9-4.9 1.3 1.3-6.2 6.2z"></path></svg>
            <b>IMG_4753.HEIC</b><span>2.6 MB</span>
          </div>
          <div class="glass-tile mini-file active">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#15c0c9"><path d="M5 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm13.5 3.8l2.9-1.9a1 1 0 0 1 1.6.8v6.6a1 1 0 0 1-1.6.8l-2.9-1.9V9.8z"></path></svg>
            <b>DJI_0284.MOV</b><span class="speed">34 MB/s</span>
          </div>
          <div class="glass-tile mini-file queued">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#9aa8b8"><rect x="4" y="5" width="16" height="14" rx="2.5"></rect></svg>
            <b>IMG_4880.DNG</b><span>queued</span>
          </div>
        </div>
        <div class="mini-drop-foot">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#1fb27a"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5l8-3z"></path></svg>
          direct to Google Drive · encrypted
        </div>
      </div>
    </div>
  </section>

  <section class="steps-v3" id="how">
    <div class="steps-v3-head">
      <h2>Three steps, zero friction</h2>
      <p>for you and for the people sending you files</p>
    </div>
    <div class="steps-v3-grid">
      <div class="panel step-card">
        <span class="icon-tile">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#2f6bff"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a3 3 0 0 1 4.2 4.2l-2 2a1 1 0 1 1-1.4-1.4l2-2a1 1 0 0 0-1.4-1.4l-2.8 2.8a1 1 0 0 1-1.4 0z"></path><path d="M13.4 10.6a1 1 0 0 1 0 1.4l-2.8 2.8a3 3 0 0 1-4.2-4.2l2-2a1 1 0 0 1 1.4 1.4l-2 2a1 1 0 1 0 1.4 1.4l2.8-2.8a1 1 0 0 1 1.4 0z" opacity="0.55"></path></svg>
        </span>
        <div class="step-title"><span style="color:#2f6bff">1 ·</span> Make a link</div>
        <p>Name it, point it at a Drive folder, optionally add a PIN, expiry or size budget. Ten seconds.</p>
      </div>
      <div class="panel step-card">
        <span class="icon-tile" style="background:linear-gradient(135deg,rgba(21,192,201,0.16),rgba(31,178,122,0.14))">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#0e9aa7"><path d="M12 3a1 1 0 0 1 .7.3l4.5 4.5a1 1 0 0 1-1.4 1.4L13 6.4V15a1 1 0 1 1-2 0V6.4L8.2 9.2a1 1 0 0 1-1.4-1.4l4.5-4.5A1 1 0 0 1 12 3z"></path><path d="M4 15a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2a1 1 0 0 1 1-1z" opacity="0.55"></path></svg>
        </span>
        <div class="step-title"><span style="color:#0e9aa7">2 ·</span> Friends drop files</div>
        <p>They open the link on any device, type a name, and add files. Uploads run in parallel and resume if the network drops.</p>
      </div>
      <div class="panel step-card">
        <span class="icon-tile" style="background:linear-gradient(135deg,rgba(123,107,255,0.16),rgba(47,107,255,0.14))">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#7b6bff"><path d="M5 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7z" opacity="0.3"></path><path d="M7 6h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm3.4 8.2l1.3-1.3 1.1 1.1 2.5-2.5 1.3 1.3-3.8 3.8-2.4-2.4z"></path></svg>
        </span>
        <div class="step-title"><span style="color:#7b6bff">3 ·</span> It lands in Drive</div>
        <p>Every uploader gets their own subfolder. Watch transfers live, then share galleries back with a /s/ link.</p>
      </div>
    </div>
  </section>

  <section class="panel strip-v3">
    <div class="strip-item">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#2f6bff"><circle cx="12" cy="12" r="10" opacity="0.14"></circle><path d="M13 2L4.5 13.5H11l-1 8.5L18.5 10H12l1-8z"></path></svg>
      <div><b>Fast by design</b><div>Parallel chunked uploads saturate the connection — 4.5 GB in under an hour on hotel Wi-Fi.</div></div>
    </div>
    <div class="strip-item">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#0e9aa7"><circle cx="12" cy="12" r="10" opacity="0.14"></circle><path d="M12 5a7 7 0 1 1-6.3 4h2.3A5 5 0 1 0 12 7v2.5L7.5 6 12 2.5V5z"></path></svg>
      <div><b>Survives bad networks</b><div>Interrupted transfers resume from the last verified chunk — never from zero.</div></div>
    </div>
    <div class="strip-item">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#7b6bff"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5l8-3z" opacity="0.14"></path><path d="M12 4.2l6 2.2v4.7c0 3.9-2.5 6.8-6 8.8-3.5-2-6-4.9-6-8.8V6.4l6-2.2zm-1 9.4l-1.8-1.8-1.2 1.2 3 3 5-5-1.2-1.2-3.8 3.8z"></path></svg>
      <div><b>Private by default</b><div>PINs, expiry dates, size budgets and full activity logs on every link.</div></div>
    </div>
    <div class="strip-item">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#1fb27a"><ellipse cx="12" cy="6" rx="8" ry="3" opacity="0.35"></ellipse><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0 1.7-3.6 3-8 3S4 7.7 4 6zm16 6c0 1.7-3.6 3-8 3s-8-1.3-8-3"></path></svg>
      <div><b>Your storage</b><div>Files stream straight into your Google Drive — nothing is stored on a middleman server.</div></div>
    </div>
  </section>

  <footer class="foot-v3">
    <span>© 2026 losthusky/drop — built for friends, not customers · notify@losthusky.qzz.io</span>
    <div>
      <a href="/privacy">privacy</a>
      <a href="/terms">terms</a>
      <a href="/admin">admin</a>
    </div>
  </footer>
</main>
```
**Verify:** `/` renders the new hero with the tilted floating drop card, three step cards, feature strip and footer; privacy/terms links still reachable; no console errors (page has no JS).

### Change 3: homepage v3 styles
**File:** `public/style.css`
**Why:** Layout classes for the new homepage (appended after plan 00's block so the tokens exist).
**Locate:**
```css
/* Dashed empty-state card */
.empty-dashed {
  border: 1.5px dashed rgba(12, 26, 43, 0.18);
  border-radius: 18px;
  padding: 26px;
  text-align: center;
  color: var(--muted);
  font-size: 13.5px;
  background: rgba(255, 255, 255, 0.4);
}
```
**Action:** INSERT AFTER
**New code:**
```css

/* ---------- Homepage v3 ---------- */
@keyframes floaty {
  0%,
  100% {
    transform: translateY(0) rotate(-6deg);
  }
  50% {
    transform: translateY(-10px) rotate(-6deg);
  }
}
.home-v3 {
  width: min(1080px, calc(100% - 40px));
  display: flex;
  flex-direction: column;
  gap: 64px;
}
.admin-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 700 13.5px var(--font-body);
  color: var(--ink);
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.65);
  box-shadow: 0 8px 20px -12px rgba(20, 60, 120, 0.45);
}
.admin-pill:hover {
  border-color: rgba(47, 107, 255, 0.4);
  color: var(--accent);
}
.hero-v3 {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: 44px;
  align-items: center;
}
.hero-v3-copy {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.hero-v3 h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(34px, 5.6vw, 54px);
  font-weight: 800;
  letter-spacing: -0.035em;
  line-height: 1.04;
}
.hero-v3-sub {
  margin: 0;
  color: var(--ink-soft);
  font-size: 17px;
  line-height: 1.65;
  max-width: 52ch;
}
.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.hero-v3-checks {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}
.hero-v3-checks span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hero-v3-visual {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 360px;
}
.hero-v3-glow {
  position: absolute;
  inset: 8% 6%;
  border-radius: 32px;
  background: linear-gradient(135deg, rgba(47, 107, 255, 0.16), rgba(21, 192, 201, 0.16), rgba(123, 107, 255, 0.12));
  filter: blur(2px);
}
.mini-drop-card {
  position: relative;
  width: min(320px, 90%);
  border-radius: 26px;
  border: 1px solid rgba(255, 255, 255, 0.95);
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(16px);
  box-shadow: 0 34px 80px -36px rgba(20, 60, 120, 0.6);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: floaty 7s ease-in-out infinite;
  transform: rotate(-6deg);
}
.mini-drop-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mini-drop-icon {
  width: 38px;
  height: 38px;
  border-radius: 13px;
  background: var(--grad);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 22px -10px rgba(47, 107, 255, 0.7);
}
.mini-drop-title {
  font-weight: 800;
  font-size: 14.5px;
}
.mini-drop-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.mini-drop-pct {
  margin-left: auto;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
}
.mini-drop-files {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.mini-file {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 11px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.8);
}
.mini-file.active {
  border-color: rgba(47, 107, 255, 0.25);
}
.mini-file.queued {
  opacity: 0.7;
  background: rgba(255, 255, 255, 0.6);
}
.mini-file span {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--faint);
}
.mini-file span.speed {
  color: var(--accent);
}
.mini-drop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.steps-v3 {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.steps-v3-head {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.steps-v3-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(22px, 3.4vw, 30px);
  font-weight: 800;
  letter-spacing: -0.03em;
}
.steps-v3-head p {
  margin: 0;
  color: var(--muted);
  font-size: 14.5px;
}
.steps-v3-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}
.step-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
}
.step-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.step-card p {
  margin: 0;
  color: var(--ink-soft);
  font-size: 13.5px;
  line-height: 1.6;
}
.strip-v3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 20px;
  padding: 28px;
}
.strip-item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.strip-item > svg {
  flex: 0 0 auto;
  margin-top: 2px;
}
.strip-item b {
  font-size: 14px;
}
.strip-item div div {
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
  margin-top: 3px;
}
.foot-v3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding-top: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--faint);
}
.foot-v3 div {
  display: flex;
  gap: 16px;
}
.foot-v3 a {
  color: var(--accent);
  text-decoration: none;
}
.foot-v3 a:hover {
  color: #0e9aa7;
}
@media (max-width: 860px) {
  .hero-v3 {
    grid-template-columns: 1fr;
  }
  .hero-v3-visual {
    min-height: 300px;
    order: -1;
  }
  .home-v3 {
    gap: 44px;
  }
}
```
**Verify:** Desktop: 2-col hero with floating card right; ≤860px: single column with the card above the copy; feature strip wraps to 2/1 columns automatically.

---

## Placeholder data
The mini drop card (`Jibhi & Koksar`, `96 files · 6.2 GB`, `68%`, `IMG_4753.HEIC`, `DJI_0284.MOV 34 MB/s`, `IMG_4880.DNG`) is **decorative placeholder content** (`aria-hidden="true"`), intentionally static — it illustrates the product, it is not wired to data. Everything else on the page is static copy.

## Responsive
Handled in Change 3's trailing `@media (max-width: 860px)` block: hero collapses to one column with the visual on top; step cards and feature strip already collapse via `auto-fit` grids. No sidebar on this page.

## Optional cleanup (not required)
Old homepage-only CSS (`.home-console`, `.console-head`, `.console-grid`, `.console-queue`, `.home-hero`, `.hero-copy-block`, `.home-split`, `.legal-link-grid`, `.home-foot`, `.home-section`) becomes unused after this plan. Leave it in place — privacy/terms pages share other `home-*` classes and dead CSS is harmless; deletion can be a later sweep.
