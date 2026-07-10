# Plan 02 — Admin unlock (`#auth` panel in `public/admin.html`)

**Files touched:** `public/admin.html`, `public/admin.js`, `public/style.css`.
**Depends on:** plan 00 (`.grad-border`, `.icon-tile`, `.brand` logo, `.btn` pills, icons §D).
**New assets:** none.
**Mockup:** `Admin Unlock.dc.html`.

Constraints honored: the unlock screen stays inside the single admin page (`/admin`); `unlock()` in admin.js toggles `#auth` / `#panel` by id, and `handleAdminSigninError` / `tryToken` write to `#tok-err` — so the ids `auth`, `admin-google`, `tok`, `tok-go`, `tok-err` are all preserved. The app keeps BOTH auth paths (Google OAuth + admin token); the mockup shows only a password — the Google button is styled as the secondary action.

---

### Change 1: rebuild the auth panel markup
**File:** `public/admin.html`
**Why:** Gradient-border hero card with lock tile, mono-labeled password field with show/hide toggle, rate-limit notice, and back-home link.
**Locate:**
```html
<body class="admin-page">
<main class="admin-shell">
  <section id="auth" class="panel center-panel">
    <p class="eyebrow">admin</p>
    <h1>Unlock dashboard</h1>
    <button class="btn google-btn" id="admin-google" type="button">
      <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
```
**Action:** REPLACE
**Old code:**
```html
  <section id="auth" class="panel center-panel">
    <p class="eyebrow">admin</p>
    <h1>Unlock dashboard</h1>
    <button class="btn google-btn" id="admin-google" type="button">
      <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.9 6.1C12.3 13 17.7 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.9 7.2l7.6 5.9c4.4-4.1 7.1-10.1 7.1-17.4z"/>
        <path fill="#FBBC05" d="M10.4 19.3c-.5 1.4-.8 3-.8 4.7s.3 3.3.8 4.7l-7.9 6.1C.9 31.6 0 27.9 0 24s.9-7.6 2.5-10.8l7.9 6.1z"/>
        <path fill="#34A853" d="M24 48c6.4 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.7-3.5-13.6-9.3l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/>
      </svg>
      Sign in with Google
    </button>
    <div class="field">
      <label for="tok">Admin token</label>
      <input id="tok" type="password" autocomplete="current-password" />
    </div>
    <button class="btn" id="tok-go">Unlock</button>
    <div class="msg-err" id="tok-err"></div>
  </section>
```
**New code:**
```html
  <section id="auth" class="auth-wrap">
    <a class="brand auth-brand" href="/"><i class="brand-mark"></i><span>losthusky <span class="brand-slash">/</span> drop</span></a>
    <div class="grad-border auth-card">
      <div class="grad-border-inner auth-inner">
        <div class="auth-head">
          <span class="icon-tile auth-lock">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="#2f6bff"><rect x="5" y="10" width="14" height="10" rx="3" opacity="0.22"></rect><path d="M7 10V8a5 5 0 0 1 10 0v2h-2V8a3 3 0 0 0-6 0v2H7zm-2 2h14v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6zm7 2a1.5 1.5 0 0 0-.8 2.8V18h1.6v-1.2A1.5 1.5 0 0 0 12 14z"></path></svg>
          </span>
          <h1>Unlock dashboard</h1>
          <p>Admin access only. Your session stays signed in on this device for 30 days.</p>
        </div>
        <button class="btn ghost google-btn" id="admin-google" type="button">
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.9 6.1C12.3 13 17.7 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.9 7.2l7.6 5.9c4.4-4.1 7.1-10.1 7.1-17.4z"/>
            <path fill="#FBBC05" d="M10.4 19.3c-.5 1.4-.8 3-.8 4.7s.3 3.3.8 4.7l-7.9 6.1C.9 31.6 0 27.9 0 24s.9-7.6 2.5-10.8l7.9 6.1z"/>
            <path fill="#34A853" d="M24 48c6.4 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.7-3.5-13.6-9.3l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/>
          </svg>
          Sign in with Google
        </button>
        <div class="auth-divider"><span>or use the admin token</span></div>
        <div class="auth-field">
          <label for="tok">Admin token</label>
          <div class="auth-input">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#9aa8b8"><path d="M14 3a7 7 0 0 1 6.9 8.2c-.5 3-3 5.4-6 5.7-.6.1-1.2 0-1.8-.1L11 19h-2v2H7v2H3v-4l7.2-7.2c-.1-.6-.2-1.2-.1-1.8.3-3 2.7-5.5 5.7-6 .4-.1.8-.1 1.2 0zM16 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"></path></svg>
            <input id="tok" type="password" autocomplete="current-password" placeholder="••••••••••" />
            <button type="button" id="tok-eye" title="show token" aria-label="show token">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#9aa8b8"><path d="M12 5c5 0 8.6 3.6 10 7-1.4 3.4-5 7-10 7S3.4 15.4 2 12c1.4-3.4 5-7 10-7z" opacity="0.25"></path><path d="M12 7c3.9 0 6.8 2.6 8 5-1.2 2.4-4.1 5-8 5s-6.8-2.6-8-5c1.2-2.4 4.1-5 8-5zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"></path></svg>
            </button>
          </div>
        </div>
        <button class="btn" id="tok-go" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#ffffff"><path d="M13 4a1 1 0 0 1 1 1v3h-2V6H6v12h6v-2h2v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h8z" opacity="0.75"></path><path d="M15.6 8.6L20 12l-4.4 3.4-1.2-1.5 1.8-1.4H9v-2h7.2l-1.8-1.4 1.2-1.5z"></path></svg>
          Unlock
        </button>
        <div class="msg-err" id="tok-err"></div>
        <div class="auth-note">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#1fb27a"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5l8-3z" opacity="0.18"></path><path d="M12 4.2l6 2.2v4.7c0 3.9-2.5 6.8-6 8.8-3.5-2-6-4.9-6-8.8V6.4l6-2.2zm-1 9.4l-1.8-1.8-1.2 1.2 3 3 5-5-1.2-1.2-3.8 3.8z"></path></svg>
          <span>Rate-limited: 5 attempts, then a 15-minute lockout.</span>
        </div>
      </div>
    </div>
    <a class="auth-back" href="/">← back to home</a>
  </section>
```
**Verify:** `/admin` (signed out) shows the centered gradient-border card; both sign-in paths work; a wrong token shows the error in the card; `?adminSigninError=` messages still surface.

### Change 2: show/hide token toggle
**File:** `public/admin.js`
**Why:** The new eye button must flip the input type.
**Locate:**
```js
    location.href = "/api/admin/auth/login";
  });
  $("tok-go").addEventListener("click", tryToken);
  $("tok").addEventListener("keydown", (e) => e.key === "Enter" && tryToken());
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });
```
**Action:** INSERT AFTER
**New code:**
```js
  $("tok-eye")?.addEventListener("click", () => {
    const tok = $("tok");
    tok.type = tok.type === "password" ? "text" : "password";
  });
```
**Verify:** Clicking the eye toggles the token field between dots and plain text.

### Change 3: unlock screen styles
**File:** `public/style.css`
**Why:** Layout for the new auth markup. Appended after plan 01's homepage block.
**Locate:**
```css
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
**Action:** INSERT AFTER
**New code:**
```css

/* ---------- Admin unlock v3 ---------- */
.auth-wrap {
  min-height: calc(100dvh - 60px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  padding: 40px 16px;
}
.auth-brand {
  font-size: 17px;
}
.auth-card {
  width: min(400px, 100%);
}
.auth-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 30px 28px 26px;
}
.auth-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  text-align: center;
}
.auth-lock {
  width: 54px;
  height: 54px;
  border-radius: 18px;
}
.auth-lock svg {
  width: 24px;
  height: 24px;
}
.auth-head h1 {
  margin: 6px 0 0;
  font-family: var(--font-display);
  font-size: 23px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.auth-head p {
  margin: 0;
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.55;
}
.auth-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--faint);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.auth-divider::before,
.auth-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: rgba(12, 26, 43, 0.1);
}
.auth-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.auth-field label {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.auth-input {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(12, 26, 43, 0.12);
  border-radius: 13px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.95);
}
.auth-input:focus-within {
  border-color: var(--accent);
}
.auth-input svg {
  flex: 0 0 auto;
}
.auth-input input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  font: 400 15px var(--font-body);
  color: var(--ink);
  padding: 14px 0;
}
.auth-input button {
  cursor: pointer;
  border: none;
  background: none;
  padding: 6px;
  display: inline-flex;
}
.auth-input button:hover {
  opacity: 0.7;
}
.auth-note {
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 12px;
  border: 1px solid rgba(12, 26, 43, 0.07);
  background: rgba(255, 255, 255, 0.6);
  padding: 11px 13px;
}
.auth-note svg {
  flex: 0 0 auto;
}
.auth-note span {
  font-size: 12.5px;
  color: var(--ink-soft);
  line-height: 1.5;
}
.auth-back {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  text-decoration: none;
}
.auth-back:hover {
  color: var(--accent);
}
```
**Verify:** Card is vertically centered, ~400px wide, with gradient border and glass interior; back link under the card.

---

## Placeholder data
None — this screen has no data. The "30 days" and "5 attempts / 15-minute lockout" copy states real backend behavior (`ADMIN_SESSION_TTL`, `rateLimitRemote(env, login:…, 5, 15*60)` in `src/worker.js:228`).

## Responsive
The card is `min(400px,100%)` and the wrap has `padding:40px 16px` — nothing further needed; no sidebar exists pre-unlock.
