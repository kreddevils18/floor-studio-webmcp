# Floor Studio

Floor Studio is a static, local-first residential floor designer built for a human and Codex to work together through the native WebMCP browser API. It uses React, TypeScript, a Rust/WebAssembly geometry core, WebGPU with an SVG overlay, and IndexedDB. No application server, account, embedded key, or cloud database is required.

## Local development

Requirements: Node.js 24+, Rust stable, and a browser with WebGPU. Native WebMCP requires a compatible browser; the editor remains usable without it and reports compatibility explicitly.

```bash
npm install
npm run wasm:build
npm run dev
```

Quality gates:

```bash
cargo test --manifest-path wasm/floor-core/Cargo.toml
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Data and privacy

Projects, revisions, queued requests, and preview images stay in the browser's IndexedDB. Export a versioned JSON document for backup or transfer. The composer queues work locally; it cannot contact or wake Codex.

## Agent workflow

In a native WebMCP-capable browser, Floor Studio registers `floor.*` tools directly on `document.modelContext`. Codex claims a queued request, stages transactional changes against an exact base revision, validates them, and presents the draft. Only the human **Approve** action commits it.
