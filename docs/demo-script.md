# Demo script

## Preparation

1. Run `bun install`, `bun run build`, and `bun run preview`.
2. Open `http://127.0.0.1:4173/floor-studio-webmcp/` in a native WebMCP-capable browser.
3. Confirm the header reports **17 / 17 tools connected**. In another browser, confirm the unsupported state is explicit and the 2D review still renders.

## Agent-authored change

Ask Codex:

> Open the living room to the courtyard with a 1.8 m sliding door. Keep a clear 900 mm circulation path from the entry to the kitchen. Apply warm oak flooring and mineral plaster. Validate the plan and present the draft for my approval.

Observe the structured timeline as Codex reads context, opens a change, applies layout/style operations, validates, and presents. Confirm no composer, drawing, measurement, comment, generate, or other manual authoring control exists.

## Human checkpoint

When the presented draft is valid, inspect the orange proposed geometry and checkpoint summary. Confirm version history is locked and the project state reads **Draft**. Reject once to show that the local user can discard without a WebMCP approval tool. Repeat the change and approve it; confirm the revision increments, the checkpoint disappears, and the state reads **Saved**.

## Revision-bound preview

Select 3D inside Render, then press **Render**. Confirm the UI returns with **Geometry-authoritative**, identifies **Metric 3D scene** as the source, and produces a 1536×1024 capture without shell or timeline pixels. Export it and confirm it preserves the exact metric scene.

Select 2D inside Render, then press **Render**. Confirm the UI shows **Queued**. Have Codex call `floor.get_render_job`, then `floor.claim_render_job`; capture `[data-capture-target="plan-2d"]`, generate the whole-floor concept with Image Gen, and upload it with `floor.preview_begin`, ordered `floor.preview_chunk` calls, and `floor.preview_commit`. Confirm **Rendering** becomes **Concept ready** and the source reads **External AI · Concept only**.

Use the version dropdown to preview the older revision without writing data. Confirm Render is disabled there, while an existing older artifact remains viewable/exportable.

## Failure checks

- Start a change with a stale revision and confirm a stable `STALE_REVISION` failure appears in the timeline.
- Attempt an empty/conflicting/no-op transaction and confirm it is rejected atomically.
- Cancel a tool execution and confirm a terminal `CANCELLED` event is stored.
- Reload during a started call and confirm it recovers as `INTERRUPTED`.
