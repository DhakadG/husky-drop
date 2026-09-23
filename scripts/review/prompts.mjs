// The prompts. These carry the repo's own context and a hard ban on generic
// advice, because a review that says "consider adding error handling" costs
// money and teaches nobody anything.

export const SHARED_RULES = `
## What makes a finding worth writing down

A finding must be something a competent reviewer who knows THIS codebase would
raise. Concretely, each one must have:

- a location: file and line numbers you actually read, not a guess;
- a scenario: the input, state or sequence that makes it go wrong, in one
  sentence ("a share with 0 folders", "a second tab open on the same drop",
  "Drive returns 403 on the third chunk");
- a consequence a person would notice: wrong data, lost work, a hang, a silent
  failure, money, a security hole, or a thing the user cannot do at all;
- a fix that could be applied today, described precisely enough to implement.

## What is NOT a finding, and will be discarded

- "Consider adding tests / types / error handling / logging / comments"
  without naming the exact case that is unhandled and what breaks.
- Style, formatting, naming preferences, or anything the linter already covers.
- "This function is long" or "this could be refactored" with no defect behind it.
- Framework or dependency suggestions. This project is deliberately vanilla JS
  on Cloudflare Workers with no bundler and no runtime dependencies. Proposing
  React, TypeScript, a test framework, a state library or a CSS framework is
  out of scope and will be discarded.
- Repeating a known trap the context below already documents as handled.
- Anything you are not at least 60% sure is real. Say less, mean it.

Rank ruthlessly. Twelve findings maximum. If a file is genuinely fine, return
few findings or none and say so in the verdict - that is a useful answer.
`;

export const REPO_RULES = `
## House rules this code is held to

- File bytes never pass through the Worker on upload; the browser PUTs to
  Drive directly.
- KV writes are the scarce resource and KV has no compare-and-set. Concurrent
  writers each get their own key and readers union them. Live progress goes to
  the Durable Object, not KV.
- \`waitUntil\` is capped around 30 s, so long work is chunked with an explicit
  time box and the next chunk is scheduled through the SELF service binding
  (a Worker fetching its own hostname is Cloudflare error 1042).
- Anything user-controlled that reaches HTML goes through esc() / escAttr() in
  the browser or escapeHtml() on the server, or is set with textContent.
- Icons come from uiIcon(name), validated against public/icons.svg.
- Lists are updated through reconcile() so one element is reused per key.
- Loading states use the skeleton vocabulary in public/skeleton.js, sized like
  the real content, and only shown when the wait passes ~180 ms.
- R2 holds page-load thumbnail tiers and watched video previews only; anything
  heavier streams from Drive through the edge cache.
- Modules stay under roughly 500 lines.
`;

export function fileReviewPrompt({ path, role, imports, importedBy, source, context }) {
  return `You are reviewing one file of a production Cloudflare Worker application, in depth, as if you owned it.

${context}

${REPO_RULES}
${SHARED_RULES}

## The file

Path: \`${path}\`
${role ? `Role, per the repo's own map: ${role}` : ""}
${imports.length ? `It imports: ${imports.join(", ")}` : ""}
${importedBy.length ? `It is imported by: ${importedBy.join(", ")}` : ""}

Read every line. Look specifically for:

1. **Correctness** - races, off-by-one, unhandled rejections, state that can
   desync, retries that duplicate work, cleanup that does not run, an await
   missing inside a loop, a cache key that collides, a cursor that can go
   backwards.
2. **Edge and empty states** - zero items, one item, thousands, a name with
   quotes or emoji, a file with no thumbnail, an expired token mid-action, a
   second tab, a slow network, a user who navigates away.
3. **Resource and cost** - KV writes in a loop, Drive calls on a hot path,
   subrequest budget, unbounded memory, an R2 put that should not exist.
4. **Security** - authorization checked before work, signature verified before
   cache, unescaped values, a token that outlives what it grants, a path or id
   taken from the client and trusted.
5. **What is missing** - the thing a user of this file's feature would expect
   and cannot do; the state this code can enter and never leave; the error it
   swallows so nobody learns anything; the number it shows with no way to act
   on it.
6. **Dead weight** - code no caller reaches, a flag never set, a branch that
   cannot execute, a helper duplicated three files over.

Answer with JSON only, no prose around it, matching exactly:

{
  "verdict": "one or two sentences: is this file in good shape, and what is the single most important thing about it",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "correctness|security|cost|ux|missing-feature|dead-code|maintainability",
      "lines": "42 or 42-58",
      "title": "short imperative claim",
      "scenario": "the exact input or sequence that triggers it",
      "consequence": "what a person notices",
      "fix": "what to change, precisely",
      "confidence": 0.0
    }
  ],
  "missing": ["features or affordances this file's area should have and does not - be concrete and specific to this product"],
  "questions": ["anything you could not determine from this file alone that changes your assessment"]
}

Source follows, with line numbers.

${source}`;
}

export function surfaceReviewPrompt({ title, what, api, files, context }) {
  return `You are doing a product and engineering makeover review of one surface of a production file-delivery app. Not a diff review - you are looking at the whole surface and asking what it should be.

${context}

${REPO_RULES}
${SHARED_RULES}

## The surface

**${title}**

${what}

Endpoints involved: ${api.join(", ") || "none"}

Review this surface as a whole - the server code, the client code and the
markup together - and answer these questions in particular:

1. **Is it complete?** What would a person reasonably try to do here and find
   they cannot? What data does the app already have that this surface should
   show and does not? What number is displayed with no way to act on it?
2. **Is it connected?** Does every card, row and counter lead somewhere useful?
   Where does a user hit a dead end, or have to go to another tab and search
   for something this one already knows about? Name the exact link or action
   that is missing, and where it should go.
3. **Is it organised?** Are the blocks in the order someone needs them? Is
   anything buried, duplicated across tabs, or grouped by how the code is
   written rather than by what a person is doing?
4. **Does it tell the truth?** Empty states, loading states, stale data,
   optimistic UI that can lie, a count computed one way here and another way
   elsewhere, a spinner that never ends.
5. **Does it hold up?** The correctness, cost and security checks from the file
   review, applied across the boundary between these files - especially state
   that lives in two places, requests that race, and work repeated per render.

Answer with JSON only, matching exactly:

{
  "verdict": "two or three sentences on the state of this surface",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "correctness|security|cost|ux|missing-feature|organisation|interlinking",
      "where": "file:line, or the UI element",
      "title": "short imperative claim",
      "scenario": "when it bites",
      "consequence": "what a person notices",
      "fix": "what to change, precisely",
      "confidence": 0.0
    }
  ],
  "missing_features": [
    {
      "title": "the feature",
      "why": "the concrete situation that wants it",
      "where": "which tab, block or card it belongs in",
      "effort": "small|medium|large",
      "depends_on": "data or endpoint it needs, or 'already available'"
    }
  ],
  "interlinks": [
    { "from": "element or view", "to": "where it should lead", "why": "what it saves the user" }
  ],
  "layout": ["concrete changes to the order or grouping of blocks on this surface"]
}

The files of this surface follow, each with line numbers.

${files}`;
}
