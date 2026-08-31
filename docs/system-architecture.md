# System architecture

Floor Studio is a static browser application. GitHub Pages serves immutable HTML, JavaScript, WebAssembly, and raster assets; it does not run an application server.

## Runtime boundaries

- React owns the collaboration shell and synchronized SVG annotation layer.
- WebGPU draws the grid, room fills, wall geometry, selections, and proposals. The Rust/WebAssembly core supplies deterministic derived geometry and wall buffers from integer-millimetre source data.
- IndexedDB stores the active project, immutable approved revisions, draft changes, requests, activity, render tickets, preview metadata, and binary image blobs. Approval and version restore serialize against persisted revisions in single transactions so separate tabs cannot overwrite the same next revision.
- Native WebMCP tools register directly on `document.modelContext`. Their lifetime is owned by one `AbortController`; unsupported browsers receive no substitute API.
- Image generation occurs outside the page. Codex prepares a project-bound ticket, captures the plan, invokes Image Gen, and streams the raster back through bounded WebMCP upload tools.

## Trust and transaction boundaries

Human request text is marked as untrusted tool output. Agent mutations enter a `ChangeSet` tied to an exact base revision and are validated before presentation. The WebMCP surface intentionally has no approval operation; only the local human control can commit a presented draft.

JSON imports are limited to 2 MB, validated across every persisted field and geometry/reference invariant, then assigned a fresh local project identity at revision zero. Preview uploads claim expiring, single-owner IndexedDB leases; each chunk renews ownership and commit/abort rechecks it before changing durable state.

Preview uploads allow PNG, JPEG, and WebP only. Each upload declares its byte count and SHA-256 digest, uses ordered decoded chunks no larger than 256 KiB, and is capped at 12 MB. SVG and incomplete or malformed uploads are rejected.
