# Husky Drop Safe Development Foundation Design

## Objective

Create a safe, reproducible local development foundation before changing the
mobile gallery or viewer. The foundation must let developers open the real
share UI against realistic local media, verify byte-range video behavior, and
exercise error states without reading or mutating production Cloudflare KV,
Google Drive, or live analytics.

The same release also repairs the project-local MemPalace setup and stops
implementation plans from being published to GitHub while preserving durable
product specifications and local planning history.

This is the first release in the approved staged program. It does not change
production gallery, viewer, authentication, or media-delivery behavior.

## Current-state evidence

- `package.json` maps `npm run dev` directly to `wrangler dev`.
- `wrangler.jsonc` configures the `KV` binding with `remote: true`, so the
  default development path is not an acceptable isolated fixture environment.
- The share client requests metadata, verification, redirects, listings,
  summaries, signed-download refreshes, file information, ZIP tickets,
  opened events, and tracking events through `/api/share/*`.
- The production media route already understands byte ranges, but its
  sub-100 MiB inline-cache behavior is deliberately unsuitable as the only
  local proof of streaming.
- Git currently tracks 27 files under `docs/plans/` and four files under
  `docs/superpowers/plans/`. Several completed plans still contain unchecked
  boxes, so they are useful working records rather than authoritative product
  state.
- `mempalace.yaml` and `entities.json` are local and ignored, but the room
  map contains an empty `design` room and the entity map classifies
  Cloudflare as a person.
- MemPalace 3.5.0 is installed and its `husky_drop` wing is readable, but the
  index predates current source modules and the MCP server is not registered
  with Codex.

## Approaches considered

### Use the production Worker and real links during development

This provides realistic data but risks live KV, Drive, session, and analytics
side effects. It also makes tests depend on credentials, network state, and
expiring tokens. Rejected as the default development path.

### Add fixture branches inside the production Worker

This reuses production routing, but mixes test-only behavior into deployed
code and increases the chance that fixture media or bypasses become reachable
in production. Rejected.

### Run a dependency-free loopback fixture server

Serve the real `public/` assets and a small, explicit subset of share APIs
from a Node process bound to loopback. Store test media outside `public/` and
implement HTTP range semantics in the fixture server. This is the selected
approach because it is isolated, inspectable, and uses only the Node standard
library already available to the repository.

## Architecture

### Local fixture server

Add `scripts/dev-fixture-server.mjs` and expose it as
`npm run dev:fixtures`.

The server:

- Binds to `127.0.0.1` by default. It must not bind to all interfaces unless
  a future explicit option is designed and approved.
- Serves the existing `public/` directory without copying or rewriting the
  application.
- Maps `/s/local-media` to the existing share page so the browser exercises
  the same client entry point used in production.
- Implements only the API surface required by the share page and returns
  `404` for unknown fixture APIs.
- Keeps all fixture state in process memory and resets it on restart.
- Does not import the Worker, load `.dev.vars`, contact Cloudflare, contact
  Google, or emit external analytics.
- Rejects path traversal, encoded traversal, NUL bytes, and requests that
  resolve outside the approved public or fixture roots.
- Supports clean shutdown on `SIGINT` and `SIGTERM`.

The default port is `8788` so it does not collide with Wrangler's usual
development port. It may be overridden with a non-secret `PORT` environment
variable; `PORT=0` requests an ephemeral port for automated tests. Startup
output prints the exact loopback URL and fixture slug.

### Fixture API contract

The server supplies deterministic responses for:

| Route | Fixture behavior |
|---|---|
| `GET /api/share/meta/local-media` | Active share metadata with no required login or PIN |
| `POST /api/share/verify` | Successful local verification response |
| `POST /api/share/redirect` | Production-shaped `400` response because the fixture is a gallery share |
| `POST /api/share/list` | Mixed image, video, unsupported-media, and folder entries |
| `POST /api/share/summary` | Totals matching the fixture listing |
| `POST /api/share/refresh-dl` | Stable local media URLs rather than signed Drive URLs |
| `POST /api/share/file-info` | Deterministic image/video metadata and an empty-metadata case |
| `POST /api/share/zip-ticket` | Explicit local-not-supported response |
| `POST /api/share/opened` | Local no-content acknowledgement |
| `POST /api/share/track` | Local no-content acknowledgement |

The fixture responses use the same field names and broad shapes consumed by
`public/share.js`. Tests validate those shapes so fixture drift fails
locally instead of silently producing an unrealistic gallery.

Authentication itself is not bypassed in production code. A later access
release will test the Google-account switching UI through a separate
deterministic auth seam.

### Fixture media

Store media under `test/dev-fixtures/media/`, outside the Cloudflare asset
directory:

- One landscape image.
- One portrait image.
- One browser-compatible H.264 MP4.
- One browser-compatible WebM.
- One small invalid `video/quicktime` resource that deterministically reaches
  the unsupported/decode-error UI.

Fixtures must be small, license-clear, synthetic, non-personal, and contain no
user screenshots or production content. They are referenced only by the
fixture server, so Wrangler does not publish them as static assets.

An adjacent README records the synthetic generation command and SHA-256 for
each binary. Generation may use FFmpeg when preparing the repository, but the
server and test suite have no runtime FFmpeg dependency.

### HTTP media and range semantics

Local media routes implement behavior that a browser video element can
actually seek against:

- A request without `Range` returns `200`, the complete body,
  `Content-Type`, `Content-Length`, and `Accept-Ranges: bytes`.
- A valid single byte range returns `206`, only the requested bytes,
  `Content-Range`, the partial `Content-Length`, and
  `Accept-Ranges: bytes`.
- Requests carrying `?inline=1` also return `x-husky-asset-tier: full` and
  `x-husky-original-bytes: <total>` so the existing full-image verifier treats
  fixture responses exactly like production media responses.
- Open-ended and suffix ranges are supported.
- An unsatisfiable or malformed range returns `416` with
  `Content-Range: bytes */<total>`.
- Multi-range requests are rejected with `416`; multipart range assembly is
  unnecessary for the browser flows under test.
- `HEAD` mirrors the corresponding headers without a body.
- Streams use Node file streams rather than reading the whole video into
  memory.

This fixture contract becomes the authoritative local oracle for the later
production streaming change.

## Git plan-tracking boundary

Implementation plans are working artifacts and remain available locally, but
new commits must not publish them:

- Add anchored ignore rules for `/docs/plans/` and
  `/docs/superpowers/plans/`.
- Remove those paths from the Git index with `git rm --cached`; do not delete
  the local files.
- Keep `docs/superpowers/specs/`, `docs/PLAN.md`, audit reports, and the
  redesign package's product plan tracked because they are durable product or
  design documentation.
- Do not rewrite Git history. The tracked plans contain no observed secrets,
  and history rewriting would add risk without improving the requested
  current-state boundary.
- Add a local ignored `docs/superpowers/plans/INDEX.md` that distinguishes
  active and archived plans. Moving old local plans is optional; no mass
  rename is required for this release.

Future implementation plans continue to use
`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, but the directory is local
only. Design specifications remain tracked and reviewable.

## MemPalace repair

MemPalace remains local-only and is not a production dependency.

### Project configuration

Replace the stale room layout with focused rooms for documentation, frontend,
backend, tests, and general material:

| Room | Source keywords |
|---|---|
| documentation | `docs`, documentation, specifications |
| frontend | `public`, client, UI, CSS |
| backend | `src`, Worker, API, Cloudflare |
| tests | `scripts`, `test`, verification, fixtures |
| general | unmatched repository files |

Remove the empty `design/assets` room.

Correct the project entity map to:

- People: none.
- Projects: `husky-drop`.
- Topics: Cloudflare Workers, Google Drive, share gallery, media viewer.

The repair changes only the ignored project configuration. It does not
blindly remove global known entities that another workspace might use.

### MCP and index

- Register the local MCP command with Codex using the existing palace path.
- Verify registration with `codex mcp list`.
- Re-mine the repository into the `husky_drop` wing with normal
  `.gitignore` protection.
- Explicitly include the two ignored plan roots when they should remain
  searchable.
- Never use `--no-gitignore`; secrets, `.dev.vars`, Wrangler state, and
  other ignored data must stay outside the palace.
- Do not use an external LLM mining mode for this repository.
- Verify the new index with status and representative searches for mobile
  selection, video streaming, and viewer metadata.

A newly registered MCP may require a fresh Codex session before tools appear.
The CLI remains the verified fallback in the current session.

## Error handling and developer experience

- Startup fails clearly if the port is unavailable or fixture roots are
  missing.
- API errors are JSON with an explicit status code.
- Static and media misses return `404` without leaking absolute paths.
- Stream failures terminate the response and are logged locally without
  process secrets or stack traces in the browser body.
- The fixture server prints concise request failures but does not log every
  successful media chunk.
- The command requires no account, token, database seed, or prior Wrangler
  session.

## Test strategy

Add a standard-library test script that starts the server on an ephemeral
loopback port and shuts it down after assertions.

Automated coverage must prove:

- The share route serves the real share HTML.
- Metadata and listing responses contain the required fixture fields.
- A full media request returns `200` and exact bytes.
- Fixed, open-ended, and suffix ranges return correct `206` bodies and
  headers.
- Invalid, unsatisfiable, and multi-range requests return `416`.
- `HEAD` returns headers without a body.
- Encoded traversal and direct fixture-root traversal are rejected.
- Tracking/opened acknowledgements remain local.
- The process binds to loopback.
- Existing repository tests still pass.

Manual browser verification at a phone-sized viewport must show:

- The local share gallery loads mixed media and thumbnails.
- Compatible MP4 and WebM fixtures play and seek.
- The unsupported fixture reaches a recoverable error path.
- Network inspection shows partial responses for explicit range requests.
- No production share, KV, Drive, or analytics request occurs.

## Delivery and deployment boundary

The foundation release consists of:

- The tracked design specification.
- The fixture server, fixtures, tests, and package script.
- The tracked `.gitignore` changes and index removals for implementation
  plans.
- Local-only MemPalace configuration, MCP registration, and rebuilt index.

Implementation is developed and verified on an isolated `codex/` branch.
The ready foundation commit is merged carefully into `main` and pushed by
itself. The push may trigger the configured Cloudflare build, but it does not
change production Worker routes or public assets. Gallery behavior changes
begin only in the next independently tested and independently pushed release.

## Acceptance criteria

The foundation is complete when all of the following are proven:

1. `npm run dev:fixtures` serves the real share UI at its printed loopback URL
   without credentials or production services.
2. Automated tests prove correct full, partial, invalid, suffix, open-ended,
   and `HEAD` media responses.
3. The browser fixture includes compatible image/video media and an
   unsupported-media case.
4. No fixture content is exposed through the production public asset
   directory or imported by the Worker.
5. The two implementation-plan roots are ignored and absent from the current
   Git index while their local files remain present.
6. Durable specs and product documentation remain tracked.
7. MemPalace's project config and entities are corrected, its MCP registration
   is visible, its wing is freshly mined, and representative searches return
   current source rather than retired implementations.
8. Existing tests and new foundation tests pass.
9. The working tree is clean after the release commit.
10. No push to `origin/main` occurs until this release is independently
    verified and ready.
