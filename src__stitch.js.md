# Review — `src/stitch.js`

_agent review (file) · 2026-09-23_

> Suggestions only, never automatic merges, with model output validated against known keys and emails. The concern is where the data goes, not the code.

## Findings

### MEDIUM · Disclose, minimise or keep in-house the visitor data sent to the model

**Where:** 41-64, 23-40 · **Category:** security · **Confidence:** 0.65

**When:** The nightly stitch runs with GEMINI_API_KEY (free tier) or ANTHROPIC_API_KEY set.

**Result:** Every known account's email, typed names, places, device details and visit history, plus up to 300 anonymous visitors' device fingerprints, are sent to a third-party model API. The privacy policy lists only Google Drive, Cloudflare and the email provider as processors, Google's free Gemini tier may use prompts to improve its products, and Google OAuth user data (emails, names) passed to another AI provider sits badly with Google's Limited Use policy.

**Fix:** Hash emails and replace them with opaque ids in the prompt (map back server-side), drop places/names that are not needed for matching, use a paid tier with no-training terms, and add the model provider to public/privacy.html's processors section - or make the stitch opt-in per deployment.
