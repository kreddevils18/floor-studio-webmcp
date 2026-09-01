# System architecture

Floor Studio is a single-route static browser application. GitHub Pages serves immutable HTML, JavaScript, WebAssembly, and raster assets; it does not run an application server.

## Runtime boundaries

- React owns the one-screen 2D/3D/Render shell, read-only version selection, component focus rail, human checkpoint, and accessible SVG fallback.
- A code-native SVG renderer provides the default technical 2D plan with wall weights, opening cuts, door swings, windows, furniture symbols, labels, and metric dimension chains. React Three Fiber/Three.js remains available as the derived isometric view. Both read the same integer-millimetre `ProjectDocumentV1`.
- The Rust/WebAssembly core remains the geometry authority. JavaScript does not maintain a second scene model.
- IndexedDB stores the active project, immutable saved revisions, draft changes, a bounded typed agent timeline, render jobs, preview metadata, and binary image blobs. Approval serializes against the exact persisted base revision.
- Native WebMCP tools register directly on `document.modelContext`. A single catalog owns metadata, schemas, handlers, registration, UI disclosure, and tests. One `AbortController` owns registration lifetime; unsupported or partially registered browsers are reported truthfully.
- Authoritative 3D rendering stays inside the page. The scene registers a capture provider after React Three Fiber mounts the metric scene; Render creates a dedicated orthographic camera, produces a fixed 1536×1024 offscreen Three.js frame, and persists its project hash, raster hash, camera matrices, renderer version, and revision. External Image Gen remains available for 2D concept previews: Codex claims the queued job through WebMCP and streams the raster back through bounded upload tools. Concept previews are never described as geometry-verified.

The Three.js scene is lazy-loaded so the 2D review shell remains the initial experience. No SVG drawing primitive or Three.js object is persisted as a second design model.

## Agent transaction pipeline

Every tool execution follows one shared path: strict JSON-schema validation, geometry/studio readiness, durable `started` timeline event, cancellation check, semantic validation, handler execution, a second cancellation check before finalization, then a durable terminal event. Errors expose stable machine-readable codes.

Layout and style operations enter one active `ChangeSet` tied to an exact base revision. Each operation is applied atomically, rejects conflicts and true no-ops, and may be inspected without writing validation state. `floor.present_change` reruns validation and persists the validation result immediately before changing the draft to `presented`.

The WebMCP surface intentionally has no approval operation. Only the local human controls can commit or reject a valid presented draft. Approval writes the next immutable revision, records the terminal change result as `saved`, and leaves only Draft/Saved as visible project states.

Historical revisions are display-only projections from immutable revision records. Selecting one never rewrites the active project, cannot queue a new render, and is disabled while a draft is active.

## Trust and upload boundaries

Schemas reject unexpected properties and enforce lengths, item bounds, enums, patterns, and numeric ranges at runtime. Semantic validators enforce entity uniqueness, opening references, style-room references, operation conflicts, maximum transaction sizes, and non-empty meaningful changes.

Concept render jobs progress through `queued → rendering → ready`, with `failed` for terminal errors. Only one project job may be active. Claim and upload leases expire independently so abandoned work can be retried safely. Preview uploads allow PNG, JPEG, and WebP only. Each upload declares its byte count and SHA-256 digest, uses ordered decoded chunks no larger than 256 KiB, is capped at 12 MB, must decode successfully at a minimum of 512×512 pixels, and holds an expiring single-owner lease. Commit and abort recheck ownership before changing durable state. These checks prove transport integrity, not structural fidelity. Authoritative Three.js captures are persisted atomically only when the project-document hash matches the active saved revision and the raster hash matches the captured bytes.

## Persistence migration

Schema version 3 preserves projects, revisions, drafts, tickets, previews, and blobs. It removes the obsolete request queue and generic activity stores, creates an indexed timeline store, converts incomplete started calls to `INTERRUPTED` on reload, and hides orphan preview metadata. Legacy `prepared/uploading` tickets and mode-less previews are normalized in place when loaded; no server migration is required.
