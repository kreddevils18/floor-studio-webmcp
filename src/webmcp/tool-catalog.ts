import { operationEntityIds } from '../domain/change-set'
import type { LayoutPatch, RoomStyle } from '../domain/model'
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, PreviewUploadService } from '../domain/preview-upload'
import { studio } from '../domain/studio-service'
import { idSchema, layoutPatchSchema, objectSchema, type StrictJsonSchema, styleSchema } from './schemas'

export type ToolAnnotations = { readOnlyHint: boolean; untrustedContentHint: boolean }
export type ToolContext = { signal: AbortSignal }
export interface FloorTool {
  name: string
  label: string
  description: string
  inputSchema: StrictJsonSchema
  annotations: ToolAnnotations
  run(input: Record<string, unknown>, context: ToolContext): unknown | Promise<unknown>
}

const upload = new PreviewUploadService(studio)
const readOnly = { readOnlyHint: true, untrustedContentHint: true }
const mutating = { readOnlyHint: false, untrustedContentHint: false }

function bounds() {
  const points = studio.snapshot.project.floor.walls.flatMap((wall) => [wall.start, wall.end])
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, widthMm: 0, heightMm: 0 }
  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))
  return { minX, minY, maxX, maxY, widthMm: maxX - minX, heightMm: maxY - minY }
}

export const toolCatalog: FloorTool[] = [
  {
    name: 'floor.create_project',
    label: 'Create project',
    description: 'Create and activate one blank metric single-floor project.',
    inputSchema: objectSchema({ name: { type: 'string', minLength: 1, maxLength: 120 } }, ['name']),
    annotations: mutating,
    async run({ name }) {
      const project = await studio.createProject(name as string)
      return { projectId: project.id, revision: project.revision }
    },
  },
  {
    name: 'floor.get_context',
    label: 'Read project context',
    description: 'Read concise active project, revision, bounds, entity counts, and change context.',
    inputSchema: objectSchema({}),
    annotations: readOnly,
    run() {
      const state = studio.snapshot
      return {
        projectId: state.project.id,
        name: state.project.name,
        revision: state.project.revision,
        bounds: bounds(),
        counts: {
          walls: state.project.floor.walls.length,
          openings: state.project.floor.openings.length,
          rooms: state.project.floor.roomMarkers.length,
          furniture: state.project.floor.furniture.length,
        },
        activeChange: state.draft
          ? {
              changeId: state.draft.id,
              baseRevision: state.draft.baseRevision,
              status: state.draft.status,
              operationCount: state.draft.operations.length,
            }
          : null,
      }
    },
  },
  {
    name: 'floor.list_entities',
    label: 'List entities',
    description: 'List a small paginated slice of floor entities, styles, versions, or draft operations.',
    inputSchema: objectSchema(
      {
        kind: { type: 'string', enum: ['walls', 'openings', 'rooms', 'furniture', 'styles', 'versions', 'operations'] },
        cursor: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      ['kind'],
    ),
    annotations: readOnly,
    run({ kind, cursor = 0, limit = 20 }) {
      const state = studio.snapshot
      const lists: Record<string, unknown[]> = {
        walls: state.project.floor.walls,
        openings: state.project.floor.openings,
        rooms: state.project.floor.roomMarkers,
        furniture: state.project.floor.furniture,
        styles: state.project.floor.roomStyles,
        versions: state.versions.map(({ revision, createdAt }) => ({ revision, createdAt })),
        operations: state.draft?.operations ?? [],
      }
      const list = lists[kind as string]
      const start = cursor as number
      const items = list.slice(start, start + (limit as number))
      return { items, nextCursor: start + items.length < list.length ? start + items.length : null }
    },
  },
  {
    name: 'floor.begin_change',
    label: 'Begin change',
    description: 'Open a transactional draft against the exact active project revision.',
    inputSchema: objectSchema({ baseRevision: { type: 'integer', minimum: 0 } }, ['baseRevision']),
    annotations: mutating,
    async run({ baseRevision }) {
      const draft = await studio.beginChange(baseRevision as number)
      return { changeId: draft.id, baseRevision: draft.baseRevision }
    },
  },
  {
    name: 'floor.apply_layout',
    label: 'Apply layout',
    description: 'Stage a bounded wall, opening, room-marker, or furniture mutation batch.',
    inputSchema: objectSchema({ patch: layoutPatchSchema }, ['patch']),
    annotations: mutating,
    async run({ patch }) {
      const result = await studio.applyLayout(patch as LayoutPatch)
      return {
        changeId: result.draft.id,
        operationCount: result.draft.operations.length,
        issueCount: result.issueCount,
        entityIds: operationEntityIds(patch as LayoutPatch),
      }
    },
  },
  {
    name: 'floor.apply_style',
    label: 'Apply room style',
    description: 'Stage a bounded room material, finish, ceiling, palette, and render-style update.',
    inputSchema: objectSchema({ styles: { type: 'array', items: styleSchema, minItems: 1, maxItems: 25 } }, ['styles']),
    annotations: mutating,
    async run({ styles }) {
      const result = await studio.applyStyle(styles as RoomStyle[])
      return {
        changeId: result.draft.id,
        operationCount: result.draft.operations.length,
        issueCount: result.issueCount,
        entityIds: (styles as RoomStyle[]).map((style) => style.roomId),
      }
    },
  },
  {
    name: 'floor.validate_change',
    label: 'Validate change',
    description: 'Purely validate the active draft without writing validation state.',
    inputSchema: objectSchema({
      cursor: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    annotations: readOnly,
    async run({ cursor = 0, limit = 20 }) {
      const issues = await studio.validateChange()
      const start = cursor as number
      const items = issues.slice(start, start + (limit as number))
      return {
        valid: !issues.some((issue) => issue.severity === 'error'),
        issues: items,
        nextCursor: start + items.length < issues.length ? start + items.length : null,
      }
    },
  },
  {
    name: 'floor.present_change',
    label: 'Present for review',
    description: 'Revalidate and present a valid draft for local human approval; cannot approve it.',
    inputSchema: objectSchema({}),
    annotations: mutating,
    async run() {
      const draft = await studio.presentChange()
      return {
        changeId: draft.id,
        baseRevision: draft.baseRevision,
        status: draft.status,
        operationCount: draft.operations.length,
        approval: 'human_required',
      }
    },
  },
  {
    name: 'floor.get_change_status',
    label: 'Read change status',
    description: 'Read draft, presented, saved, rejected, or discarded status and resulting revision.',
    inputSchema: objectSchema({ changeId: idSchema }, ['changeId']),
    annotations: readOnly,
    async run({ changeId }) {
      const draft = await studio.getChangeStatus(changeId as string)
      return {
        changeId: draft.id,
        status: draft.status,
        baseRevision: draft.baseRevision,
        resultRevision: draft.resultRevision ?? null,
      }
    },
  },
  {
    name: 'floor.discard_change',
    label: 'Discard draft',
    description: 'Discard the current unapproved agent draft.',
    inputSchema: objectSchema({}),
    annotations: mutating,
    async run() {
      const draft = await studio.discardChange()
      return { changeId: draft.id, status: draft.status }
    },
  },
  {
    name: 'floor.focus',
    label: 'Focus entities',
    description: 'Frame and highlight entities in the human spatial review scene.',
    inputSchema: objectSchema(
      {
        entityIds: { type: 'array', items: idSchema, minItems: 1, maxItems: 50 },
        mode: { type: 'string', enum: ['2d', '3d'] },
      },
      ['entityIds'],
    ),
    annotations: mutating,
    run({ entityIds, mode = '3d' }) {
      studio.focus(entityIds as string[], mode as '2d' | '3d')
      return { selected: entityIds, mode }
    },
  },
  {
    name: 'floor.get_render_job',
    label: 'Read queued render job',
    description: 'Read the oldest revision-bound 2D or 3D render job requested by the local human UI.',
    inputSchema: objectSchema({}),
    annotations: readOnly,
    async run() {
      const ticket = await studio.queuedRenderJob()
      return ticket
        ? {
            ticketId: ticket.id,
            sourcePlanRevision: ticket.sourcePlanRevision,
            renderMode: ticket.renderMode,
            status: ticket.status,
          }
        : { ticketId: null }
    },
  },
  {
    name: 'floor.claim_render_job',
    label: 'Claim Image Gen render',
    description:
      'Claim a queued UI render job and receive its exact Image Gen brief, capture target, and upload contract.',
    inputSchema: objectSchema({ ticketId: idSchema }, ['ticketId']),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async run({ ticketId }) {
      const ticket = await studio.claimRenderJob(ticketId as string)
      return {
        ticketId: ticket.id,
        projectId: ticket.projectId,
        sourcePlanRevision: ticket.sourcePlanRevision,
        target: ticket.target,
        renderMode: ticket.renderMode,
        prompt: ticket.prompt,
        captureTarget:
          ticket.renderMode === '2d' ? '[data-capture-target="plan-2d"]' : '[data-capture-target="scene-3d"]',
        upload: {
          allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
          maxBytes: PREVIEW_MAX_BYTES,
          chunkBytes: PREVIEW_CHUNK_BYTES,
        },
      }
    },
  },
  {
    name: 'floor.preview_begin',
    label: 'Begin preview upload',
    description: 'Claim a rendering ticket and begin one bounded raster upload.',
    inputSchema: objectSchema(
      {
        ticketId: idSchema,
        mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
        checksum: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        expectedBytes: { type: 'integer', minimum: 1, maximum: PREVIEW_MAX_BYTES },
      },
      ['ticketId', 'mimeType', 'checksum', 'expectedBytes'],
    ),
    annotations: mutating,
    async run({ ticketId, mimeType, checksum, expectedBytes }, { signal }) {
      const ticket = await studio.getTicket(ticketId as string)
      if (!ticket) throw new Error('Render ticket not found.')
      return upload.begin(ticket, mimeType as string, checksum as string, expectedBytes as number, signal)
    },
  },
  {
    name: 'floor.preview_chunk',
    label: 'Append preview chunk',
    description: 'Append one ordered base64 raster chunk of at most 256 KiB decoded bytes.',
    inputSchema: objectSchema(
      {
        ticketId: idSchema,
        index: { type: 'integer', minimum: 0 },
        base64: { type: 'string', minLength: 4, maxLength: 349_528 },
      },
      ['ticketId', 'index', 'base64'],
    ),
    annotations: mutating,
    run({ ticketId, index, base64 }, { signal }) {
      return upload.append(ticketId as string, index as number, base64 as string, signal)
    },
  },
  {
    name: 'floor.preview_commit',
    label: 'Commit preview',
    description: 'Verify checksum and raster signature, then persist the revision-bound preview.',
    inputSchema: objectSchema({ ticketId: idSchema }, ['ticketId']),
    annotations: mutating,
    async run({ ticketId }, { signal }) {
      const asset = await upload.commit(ticketId as string, signal)
      return { previewId: asset.id, checksum: asset.checksum, sourcePlanRevision: asset.sourcePlanRevision }
    },
  },
  {
    name: 'floor.preview_abort',
    label: 'Abort preview upload',
    description: 'Abort and clean up one incomplete preview upload.',
    inputSchema: objectSchema({ ticketId: idSchema }, ['ticketId']),
    annotations: mutating,
    run({ ticketId }) {
      return upload.abort(ticketId as string)
    },
  },
]

export const toolByName = new Map(toolCatalog.map((tool) => [tool.name, tool]))
