import { geometry } from '../core/geometry-engine'
import { database, getBlob, saveBlob, saveInitialProject } from '../data/database'
import { validateLayoutPatch, validateStyles } from './change-set'
import type {
  AgentTimelineEvent,
  AuthoritativeRenderCapture,
  ChangeOperation,
  ChangeSet,
  LayoutPatch,
  PreviewAsset,
  PreviewTicket,
  ProjectDocumentV1,
  RenderMode,
  RevisionRecord,
  RoomStyle,
  StudioSnapshot,
  ValidationIssue,
} from './model'
import { newId, nowIso } from './model'
import { validateRasterBlob } from './raster-validation'
import { createSampleProject } from './sample-project'

const clone = <T>(value: T): T => structuredClone(value)
const IMPORT_MAX_BYTES = 2 * 1024 * 1024
const IMPORT_MAX_ITEMS = 2_000

function leaseExpired(expiresAt?: string) {
  return !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()
}

function isActiveRenderTicket(ticket: PreviewTicket) {
  return ticket.status === 'queued' || ticket.status === 'rendering'
}

function failRenderTicket(ticket: PreviewTicket): PreviewTicket {
  return {
    ...ticket,
    status: 'failed',
    renderLeaseExpiresAt: undefined,
    uploadOwnerId: undefined,
    uploadLeaseExpiresAt: undefined,
  }
}

function parseProjectImport(json: string): ProjectDocumentV1 {
  if (new TextEncoder().encode(json).byteLength > IMPORT_MAX_BYTES) throw new Error('Project JSON cannot exceed 2 MB.')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('Project JSON is not valid JSON.')
  }
  const object = (input: unknown, path: string) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path} must be an object.`)
    return input as Record<string, unknown>
  }
  const string = (input: unknown, path: string, max = 500) => {
    if (typeof input !== 'string' || !input.trim() || input.length > max)
      throw new Error(`${path} must be a non-empty string of at most ${max} characters.`)
    return input
  }
  const optionalString = (input: unknown, path: string, max = 500) =>
    input === undefined ? undefined : string(input, path, max)
  const id = (input: unknown, path: string) => {
    const result = string(input, path, 128)
    if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new Error(`${path} contains unsupported ID characters.`)
    return result
  }
  const integer = (input: unknown, path: string, min = -10_000_000, max = 10_000_000) => {
    if (!Number.isInteger(input) || (input as number) < min || (input as number) > max)
      throw new Error(`${path} must be an integer between ${min} and ${max}.`)
    return input as number
  }
  const finite = (input: unknown, path: string, min = -36_000, max = 36_000) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max)
      throw new Error(`${path} must be a finite number between ${min} and ${max}.`)
    return input
  }
  const array = (input: unknown, path: string) => {
    if (!Array.isArray(input) || input.length > IMPORT_MAX_ITEMS)
      throw new Error(`${path} must be an array with at most ${IMPORT_MAX_ITEMS} items.`)
    return input
  }
  const point = (input: unknown, path: string) => {
    const item = object(input, path)
    return { x: integer(item.x, `${path}.x`), y: integer(item.y, `${path}.y`) }
  }
  const root = object(value, 'project')
  if (root.schemaVersion !== 1) throw new Error('Only ProjectDocumentV1 JSON is supported.')
  const floorValue = object(root.floor, 'project.floor')
  if (floorValue.unit !== 'mm') throw new Error('Only millimetre floor documents are supported.')
  const walls = array(floorValue.walls, 'project.floor.walls').map((entry, index) => {
    const item = object(entry, `walls[${index}]`)
    return {
      id: id(item.id, `walls[${index}].id`),
      start: point(item.start, `walls[${index}].start`),
      end: point(item.end, `walls[${index}].end`),
      thicknessMm: integer(item.thicknessMm, `walls[${index}].thicknessMm`, 1, 5_000),
      finish: optionalString(item.finish, `walls[${index}].finish`),
    }
  })
  const openings = array(floorValue.openings, 'project.floor.openings').map((entry, index) => {
    const item = object(entry, `openings[${index}]`)
    if (item.kind !== 'door' && item.kind !== 'window') throw new Error(`openings[${index}].kind is invalid.`)
    if (item.swing !== undefined && !['left', 'right', 'sliding'].includes(item.swing as string))
      throw new Error(`openings[${index}].swing is invalid.`)
    return {
      id: id(item.id, `openings[${index}].id`),
      wallId: id(item.wallId, `openings[${index}].wallId`),
      kind: item.kind as 'door' | 'window',
      offsetMm: integer(item.offsetMm, `openings[${index}].offsetMm`, 0),
      widthMm: integer(item.widthMm, `openings[${index}].widthMm`, 1),
      swing: item.swing as 'left' | 'right' | 'sliding' | undefined,
    }
  })
  const roomMarkers = array(floorValue.roomMarkers, 'project.floor.roomMarkers').map((entry, index) => {
    const item = object(entry, `roomMarkers[${index}]`)
    return {
      id: id(item.id, `roomMarkers[${index}].id`),
      name: string(item.name, `roomMarkers[${index}].name`, 120),
      position: point(item.position, `roomMarkers[${index}].position`),
    }
  })
  const furniture = array(floorValue.furniture, 'project.floor.furniture').map((entry, index) => {
    const item = object(entry, `furniture[${index}]`)
    return {
      id: id(item.id, `furniture[${index}].id`),
      kind: string(item.kind, `furniture[${index}].kind`, 120),
      label: string(item.label, `furniture[${index}].label`, 160),
      position: point(item.position, `furniture[${index}].position`),
      widthMm: integer(item.widthMm, `furniture[${index}].widthMm`, 1),
      depthMm: integer(item.depthMm, `furniture[${index}].depthMm`, 1),
      rotationDegrees: finite(item.rotationDegrees, `furniture[${index}].rotationDegrees`),
    }
  })
  const dimensions = array(floorValue.dimensions, 'project.floor.dimensions').map((entry, index) => {
    const item = object(entry, `dimensions[${index}]`)
    return {
      id: id(item.id, `dimensions[${index}].id`),
      start: point(item.start, `dimensions[${index}].start`),
      end: point(item.end, `dimensions[${index}].end`),
      label: optionalString(item.label, `dimensions[${index}].label`, 160),
    }
  })
  const annotations = array(floorValue.annotations, 'project.floor.annotations').map((entry, index) => {
    const item = object(entry, `annotations[${index}]`)
    if (item.kind !== 'comment' && item.kind !== 'note') throw new Error(`annotations[${index}].kind is invalid.`)
    return {
      id: id(item.id, `annotations[${index}].id`),
      position: point(item.position, `annotations[${index}].position`),
      text: string(item.text, `annotations[${index}].text`, 1_000),
      kind: item.kind as 'comment' | 'note',
    }
  })
  const roomStyles = array(floorValue.roomStyles, 'project.floor.roomStyles').map((entry, index) => {
    const item = object(entry, `roomStyles[${index}]`)
    const palette = array(item.palette, `roomStyles[${index}].palette`)
    if (palette.length > 20) throw new Error(`roomStyles[${index}].palette has too many colors.`)
    return {
      roomId: id(item.roomId, `roomStyles[${index}].roomId`),
      floorMaterial: string(item.floorMaterial, `roomStyles[${index}].floorMaterial`),
      wallFinish: string(item.wallFinish, `roomStyles[${index}].wallFinish`),
      ceilingHeightMm: integer(item.ceilingHeightMm, `roomStyles[${index}].ceilingHeightMm`, 1_000, 20_000),
      palette: palette.map((color, colorIndex) => string(color, `roomStyles[${index}].palette[${colorIndex}]`, 64)),
      renderStyle: string(item.renderStyle, `roomStyles[${index}].renderStyle`),
    }
  })
  const createdAt = string(root.createdAt, 'project.createdAt', 64)
  const updatedAt = string(root.updatedAt, 'project.updatedAt', 64)
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt)))
    throw new Error('Project timestamps are invalid.')
  const project: ProjectDocumentV1 = {
    schemaVersion: 1,
    id: id(root.id, 'project.id'),
    name: string(root.name, 'project.name', 120),
    createdAt,
    updatedAt,
    revision: integer(root.revision, 'project.revision', 0, Number.MAX_SAFE_INTEGER),
    floor: {
      id: id(floorValue.id, 'project.floor.id'),
      name: string(floorValue.name, 'project.floor.name', 120),
      unit: 'mm',
      walls,
      openings,
      roomMarkers,
      furniture,
      dimensions,
      annotations,
      roomStyles,
    },
  }
  const entityIds = [...walls, ...openings, ...roomMarkers, ...furniture, ...dimensions, ...annotations].map(
    (entry) => entry.id,
  )
  if (new Set(entityIds).size !== entityIds.length) throw new Error('Project contains duplicate entity IDs.')
  const wallIds = new Set(walls.map((wall) => wall.id))
  if (openings.some((opening) => !wallIds.has(opening.wallId)))
    throw new Error('Project contains an opening attached to a missing wall.')
  const roomIds = new Set(roomMarkers.map((room) => room.id))
  if (
    roomStyles.some((style) => !roomIds.has(style.roomId)) ||
    new Set(roomStyles.map((style) => style.roomId)).size !== roomStyles.length
  )
    throw new Error('Project contains invalid room style references.')
  return project
}

function upsertById<T extends { id: string }>(current: T[], items: T[] = [], remove: string[] = []) {
  const removed = new Set(remove)
  const replacements = new Map(items.map((item) => [item.id, item]))
  const result = current.filter((item) => !removed.has(item.id)).map((item) => replacements.get(item.id) ?? item)
  for (const item of items) if (!result.some((existing) => existing.id === item.id)) result.push(item)
  return result
}

export function applyOperations(base: ProjectDocumentV1, operations: ChangeOperation[]): ProjectDocumentV1 {
  const next = clone(base)
  for (const operation of operations) {
    if (operation.kind === 'layout') {
      const patch = operation.patch
      if (patch.walls) next.floor.walls = upsertById(next.floor.walls, patch.walls.upsert, patch.walls.remove)
      if (patch.openings)
        next.floor.openings = upsertById(next.floor.openings, patch.openings.upsert, patch.openings.remove)
      if (patch.roomMarkers)
        next.floor.roomMarkers = upsertById(next.floor.roomMarkers, patch.roomMarkers.upsert, patch.roomMarkers.remove)
      if (patch.furniture)
        next.floor.furniture = upsertById(next.floor.furniture, patch.furniture.upsert, patch.furniture.remove)
    } else {
      const replacements = new Map(operation.styles.map((style) => [style.roomId, style]))
      next.floor.roomStyles = next.floor.roomStyles.map((style) => replacements.get(style.roomId) ?? style)
      for (const style of operation.styles)
        if (!next.floor.roomStyles.some((existing) => existing.roomId === style.roomId))
          next.floor.roomStyles.push(style)
    }
  }
  return next
}

type Listener = (snapshot: StudioSnapshot) => void

export class StudioService {
  private snapshotValue: StudioSnapshot | null = null
  private initialization: Promise<StudioSnapshot> | null = null
  private listeners = new Set<Listener>()

  get snapshot() {
    if (!this.snapshotValue) throw new Error('Studio has not initialized.')
    return this.snapshotValue
  }
  getSnapshot = () => this.snapshotValue
  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit() {
    this.snapshot.projectState = this.snapshot.draft ? 'draft' : 'saved'
    this.snapshotValue = { ...this.snapshot }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  async startTimeline(input: Omit<AgentTimelineEvent, 'id' | 'projectId' | 'phase' | 'startedAt' | 'sequence'>) {
    const nextSequence = (this.snapshot.timeline[0]?.sequence ?? 0) + 1
    const event: AgentTimelineEvent = {
      ...input,
      id: newId('timeline'),
      projectId: this.snapshot.project.id,
      phase: 'started',
      startedAt: nowIso(),
      sequence: nextSequence,
    }
    const db = await database()
    await db.put('timeline', event)
    this.snapshot.timeline = [event, ...this.snapshot.timeline].slice(0, 200)
    this.emit()
    const all = await db.getAllFromIndex('timeline', 'byProject', event.projectId)
    await Promise.all(
      all
        .sort((a, b) => b.sequence - a.sequence)
        .slice(200)
        .map((old) => db.delete('timeline', old.id)),
    )
    return event
  }

  async finishTimeline(
    id: string,
    phase: 'succeeded' | 'failed' | 'awaiting-human',
    fields: Partial<AgentTimelineEvent> = {},
  ) {
    const current =
      this.snapshot.timeline.find((event) => event.id === id) ?? (await (await database()).get('timeline', id))
    if (!current) throw new Error('Timeline event not found.')
    const completedAt = nowIso()
    const event: AgentTimelineEvent = {
      ...current,
      ...fields,
      phase,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(current.startedAt)),
    }
    await (await database()).put('timeline', event)
    this.snapshot.timeline = [event, ...this.snapshot.timeline.filter((item) => item.id !== id)].sort(
      (a, b) => b.sequence - a.sequence,
    )
    this.emit()
    return event
  }

  initialize() {
    this.initialization ??= this.restoreSnapshot().finally(() => {
      this.initialization = null
    })
    return this.initialization
  }

  private async restoreSnapshot() {
    const db = await database()
    const activeProjectId = await db.get('settings', 'activeProjectId')
    let project = activeProjectId ? await db.get('projects', activeProjectId) : undefined
    project ??= (await db.getAll('projects'))[0]
    if (!project) {
      project = createSampleProject()
      await saveInitialProject(project)
    }
    const [drafts, timeline, previews, versions, tickets] = await Promise.all([
      db.getAllFromIndex('drafts', 'byProject', project.id),
      db.getAllFromIndex('timeline', 'byProject', project.id),
      db.getAllFromIndex('previews', 'byProject', project.id),
      db.getAllFromIndex('revisions', 'byProject', project.id),
      db.getAllFromIndex('tickets', 'byProject', project.id),
    ])
    const normalizedDrafts = await Promise.all(
      drafts.map(async (draft) => {
        if (String(draft.status) !== 'approved') return draft
        const normalized = {
          ...draft,
          status: 'saved' as const,
          resultRevision: draft.resultRevision ?? draft.baseRevision + 1,
        }
        await db.put('drafts', normalized)
        return normalized
      }),
    )
    const normalizedTickets = await Promise.all(
      tickets.map(async (ticket) => {
        const legacyStatus = String(ticket.status)
        const uploadExpired = leaseExpired(ticket.uploadLeaseExpiresAt)
        const renderExpired = leaseExpired(ticket.renderLeaseExpiresAt)
        let normalized: PreviewTicket = {
          ...ticket,
          renderMode: ticket.renderMode ?? '2d',
          artifactKind: ticket.artifactKind ?? 'concept',
          status:
            legacyStatus === 'prepared'
              ? 'queued'
              : legacyStatus === 'uploading'
                ? uploadExpired
                  ? 'queued'
                  : 'rendering'
                : ticket.status === 'rendering' &&
                    ((ticket.uploadOwnerId && uploadExpired) || (!ticket.uploadOwnerId && renderExpired))
                  ? 'queued'
                  : ticket.status,
          renderLeaseExpiresAt:
            legacyStatus === 'uploading' && !uploadExpired
              ? ticket.uploadLeaseExpiresAt
              : ticket.status === 'rendering' &&
                  ((ticket.uploadOwnerId && uploadExpired) || (!ticket.uploadOwnerId && renderExpired))
                ? undefined
                : ticket.renderLeaseExpiresAt,
          uploadOwnerId: uploadExpired ? undefined : ticket.uploadOwnerId,
          uploadLeaseExpiresAt: uploadExpired ? undefined : ticket.uploadLeaseExpiresAt,
        }
        if (isActiveRenderTicket(normalized) && normalized.sourcePlanRevision !== project.revision)
          normalized = failRenderTicket(normalized)
        if (JSON.stringify(normalized) !== JSON.stringify(ticket)) await db.put('tickets', normalized)
        return normalized
      }),
    )
    const normalizedPreviews = await Promise.all(
      previews.map(async (preview) => {
        const normalized = {
          ...preview,
          renderMode: preview.renderMode ?? ('2d' as const),
          artifactKind: preview.artifactKind ?? ('concept' as const),
        }
        if (!preview.renderMode || !preview.artifactKind) await db.put('previews', normalized)
        return normalized
      }),
    )
    this.snapshotValue = {
      project,
      draft: normalizedDrafts.find((draft) => draft.status === 'draft' || draft.status === 'presented') ?? null,
      timeline: timeline.sort((a, b) => b.sequence - a.sequence),
      previews: normalizedPreviews
        .filter((preview) => normalizedTickets.some((ticket) => ticket.id === preview.ticketId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      tickets: normalizedTickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      versions: versions.sort((a, b) => b.revision - a.revision),
      selectedIds: [],
      activeView: '2d',
      renderMode: '2d',
      selectedRevision: project.revision,
      projectState: normalizedDrafts.some((draft) => draft.status === 'draft' || draft.status === 'presented')
        ? 'draft'
        : 'saved',
    }
    const interrupted = this.snapshot.timeline.filter((event) => event.phase === 'started')
    await Promise.all(
      interrupted.map((event) =>
        this.finishTimeline(event.id, 'failed', {
          errorCode: 'INTERRUPTED',
          outputSummary: 'Interrupted by page reload.',
        }),
      ),
    )
    this.emit()
    return this.snapshot
  }

  focus(ids: string[], view: StudioSnapshot['activeView'] = '3d') {
    this.snapshot.selectedIds = [...new Set(ids)]
    this.snapshot.activeView = view
    this.emit()
  }
  setView(view: StudioSnapshot['activeView']) {
    this.snapshot.activeView = view
    this.emit()
  }
  setRenderMode(mode: RenderMode) {
    this.snapshot.renderMode = mode
    this.emit()
  }

  selectRevision(revision: number) {
    if (this.snapshot.draft) throw new Error('Resolve the active draft before viewing version history.')
    if (!this.snapshot.versions.some((entry) => entry.revision === revision)) throw new Error('Revision not found.')
    this.snapshot.selectedRevision = revision
    this.snapshot.selectedIds = []
    this.emit()
  }

  displayedProject() {
    if (this.snapshot.selectedRevision === this.snapshot.project.revision) return this.snapshot.project
    return (
      this.snapshot.versions.find((entry) => entry.revision === this.snapshot.selectedRevision)?.document ??
      this.snapshot.project
    )
  }

  async createProject(name: string) {
    if (!name.trim()) throw new Error('Project name is required.')
    const timestamp = nowIso()
    const project: ProjectDocumentV1 = {
      schemaVersion: 1,
      id: newId('project'),
      name: name.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
      floor: {
        id: newId('floor'),
        name: 'Ground floor',
        unit: 'mm',
        walls: [],
        openings: [],
        roomMarkers: [],
        furniture: [],
        dimensions: [],
        annotations: [],
        roomStyles: [],
      },
    }
    await saveInitialProject(project)
    this.snapshotValue = {
      project,
      draft: null,
      timeline: [],
      previews: [],
      tickets: [],
      versions: [
        { id: `${project.id}:0`, projectId: project.id, revision: 0, document: project, createdAt: timestamp },
      ],
      selectedIds: [],
      activeView: '2d',
      renderMode: '2d',
      selectedRevision: project.revision,
      projectState: 'saved',
    }
    this.emit()
    return project
  }

  async beginChange(baseRevision: number) {
    if (this.snapshot.draft && ['draft', 'presented'].includes(this.snapshot.draft.status))
      throw new Error('An active change already exists.')
    const draft: ChangeSet = {
      id: newId('change'),
      projectId: this.snapshot.project.id,
      baseRevision,
      operations: [],
      validationResults: [],
      status: 'draft',
      createdAt: nowIso(),
    }
    const db = await database()
    const tx = db.transaction(['projects', 'drafts'], 'readwrite')
    const persisted = await tx.objectStore('projects').get(this.snapshot.project.id)
    if (!persisted || baseRevision !== persisted.revision) {
      await tx.done
      throw new Error(`Stale base revision ${baseRevision}; current revision is ${persisted?.revision ?? 'missing'}.`)
    }
    const activeDrafts = await tx.objectStore('drafts').index('byProject').getAll(this.snapshot.project.id)
    if (activeDrafts.some((entry) => entry.status === 'draft' || entry.status === 'presented')) {
      await tx.done
      throw new Error('An active change already exists.')
    }
    await tx.objectStore('drafts').put(draft)
    await tx.done
    this.snapshot.draft = draft
    this.snapshot.selectedRevision = this.snapshot.project.revision
    this.emit()
    return draft
  }

  private requireDraft() {
    const draft = this.snapshot.draft
    if (!draft || draft.status !== 'draft') throw new Error('No editable draft is open.')
    if (draft.baseRevision !== this.snapshot.project.revision)
      throw new Error(`Draft is stale; current revision is ${this.snapshot.project.revision}.`)
    return draft
  }

  async applyLayout(patch: LayoutPatch) {
    validateLayoutPatch(patch, this.stagedProject())
    return this.appendOperation({ kind: 'layout', patch })
  }
  async applyStyle(styles: RoomStyle[]) {
    validateStyles(styles, this.stagedProject())
    return this.appendOperation({ kind: 'style', styles })
  }
  private async appendOperation(operation: ChangeOperation) {
    const draft = this.requireDraft()
    const operationIds =
      operation.kind === 'layout'
        ? [
            operation.patch.walls?.upsert,
            operation.patch.openings?.upsert,
            operation.patch.roomMarkers?.upsert,
            operation.patch.furniture?.upsert,
          ].flatMap((items) => items?.map((item) => item.id) ?? [])
        : operation.styles.map((style) => style.roomId)
    if (new Set(operationIds).size !== operationIds.length)
      throw new Error('Transaction contains duplicate entity or room style IDs.')
    const before = this.stagedProject()
    const staged = applyOperations(before, [operation])
    if (JSON.stringify(staged.floor) === JSON.stringify(before.floor))
      throw new Error('Change does not modify the active project.')
    const issues = this.validateProject(staged)
    if (issues.some((issue) => ['duplicate_id', 'style_room_missing', 'duplicate_style'].includes(issue.code)))
      throw new Error('Transaction rejected because entity IDs or style references are invalid.')
    draft.operations.push(clone(operation))
    draft.validationResults = issues
    await (await database()).put('drafts', draft)
    this.emit()
    return { draft, issueCount: issues.length }
  }

  stagedProject() {
    return this.snapshot.draft
      ? applyOperations(this.snapshot.project, this.snapshot.draft.operations)
      : this.snapshot.project
  }
  async validateChange(): Promise<ValidationIssue[]> {
    this.requireDraft()
    return this.validateProject(this.stagedProject())
  }

  private validateProject(project: ProjectDocumentV1) {
    const issues = geometry.validate(project.floor)
    const rooms = new Set(project.floor.roomMarkers.map((room) => room.id))
    const styleIds = new Set<string>()
    for (const style of project.floor.roomStyles) {
      if (!rooms.has(style.roomId))
        issues.push({
          code: 'style_room_missing',
          severity: 'error',
          entityId: style.roomId,
          message: 'Room style references a missing room marker.',
        })
      if (styleIds.has(style.roomId))
        issues.push({
          code: 'duplicate_style',
          severity: 'error',
          entityId: style.roomId,
          message: 'Each room can have only one style record.',
        })
      styleIds.add(style.roomId)
    }
    return issues
  }

  async presentChange() {
    const draft = this.requireDraft()
    if (
      !draft.operations.length ||
      JSON.stringify(this.stagedProject().floor) === JSON.stringify(this.snapshot.project.floor)
    )
      throw new Error('A no-op change cannot be presented.')
    const issues = this.validateProject(this.stagedProject())
    if (issues.some((issue) => issue.severity === 'error'))
      throw new Error('Resolve validation errors before presenting this change.')
    draft.validationResults = issues
    draft.status = 'presented'
    await (await database()).put('drafts', draft)
    this.emit()
    return draft
  }

  async discardChange() {
    const draft = this.snapshot.draft
    if (!draft || draft.status === 'saved') throw new Error('No unsaved change exists.')
    draft.status = 'discarded'
    await (await database()).put('drafts', draft)
    this.snapshot.draft = null
    this.emit()
    return draft
  }

  async rejectPresentedChange() {
    const draft = this.snapshot.draft
    if (!draft || draft.status !== 'presented') throw new Error('Only a presented change can be rejected.')
    draft.status = 'rejected'
    await (await database()).put('drafts', draft)
    this.snapshot.draft = null
    this.emit()
    return draft
  }

  async getChangeStatus(changeId: string) {
    const change = await (await database()).get('drafts', changeId)
    if (!change || change.projectId !== this.snapshot.project.id) throw new Error('Change not found.')
    return change
  }

  async approvePresentedChange() {
    const draft = this.snapshot.draft
    if (!draft || draft.status !== 'presented') throw new Error('Only a presented change can be approved.')
    const db = await database()
    const tx = db.transaction(['projects', 'revisions', 'drafts', 'tickets'], 'readwrite')
    const [persisted, persistedDraft, tickets] = await Promise.all([
      tx.objectStore('projects').get(draft.projectId),
      tx.objectStore('drafts').get(draft.id),
      tx.objectStore('tickets').index('byProject').getAll(draft.projectId),
    ])
    if (!persisted || persisted.revision !== draft.baseRevision || persistedDraft?.status !== 'presented') {
      await tx.done
      throw new Error('Cannot approve a stale or superseded change.')
    }
    const project = applyOperations(persisted, persistedDraft.operations)
    project.revision = persisted.revision + 1
    project.updatedAt = nowIso()
    persistedDraft.status = 'saved'
    persistedDraft.resultRevision = project.revision
    const revision: RevisionRecord = {
      id: `${project.id}:${project.revision}`,
      projectId: project.id,
      revision: project.revision,
      document: clone(project),
      createdAt: project.updatedAt,
    }
    const invalidatedTickets = tickets
      .filter(isActiveRenderTicket)
      .filter((ticket) => ticket.sourcePlanRevision !== project.revision)
      .map(failRenderTicket)
    await Promise.all([
      tx.objectStore('projects').put(project),
      tx.objectStore('revisions').put(revision),
      tx.objectStore('drafts').put(persistedDraft),
      ...invalidatedTickets.map((ticket) => tx.objectStore('tickets').put(ticket)),
    ])
    await tx.done
    this.snapshot.project = project
    this.snapshot.versions = [revision, ...this.snapshot.versions]
    this.snapshot.selectedRevision = project.revision
    this.snapshot.draft = null
    this.snapshot.tickets = this.snapshot.tickets.map(
      (ticket) => invalidatedTickets.find((invalidated) => invalidated.id === ticket.id) ?? ticket,
    )
    this.emit()
    return project
  }

  async restoreRevision(revisionNumber: number) {
    if (this.snapshot.draft) throw new Error('Discard the active draft before restoring a version.')
    const expectedRevision = this.snapshot.project.revision
    const projectId = this.snapshot.project.id
    const db = await database()
    const tx = db.transaction(['projects', 'revisions', 'drafts', 'tickets'], 'readwrite')
    const [persisted, source, drafts, tickets] = await Promise.all([
      tx.objectStore('projects').get(projectId),
      tx.objectStore('revisions').get(`${projectId}:${revisionNumber}`),
      tx.objectStore('drafts').index('byProject').getAll(projectId),
      tx.objectStore('tickets').index('byProject').getAll(projectId),
    ])
    if (!persisted || persisted.revision !== expectedRevision) {
      await tx.done
      throw new Error('Cannot restore from a stale project snapshot.')
    }
    if (!source) {
      await tx.done
      throw new Error('Revision not found.')
    }
    if (drafts.some((draft) => draft.status === 'draft' || draft.status === 'presented')) {
      await tx.done
      throw new Error('Discard the active draft before restoring a version.')
    }
    const restored = clone(source.document)
    restored.revision = persisted.revision + 1
    restored.updatedAt = nowIso()
    const revision: RevisionRecord = {
      id: `${restored.id}:${restored.revision}`,
      projectId: restored.id,
      revision: restored.revision,
      document: clone(restored),
      createdAt: restored.updatedAt,
    }
    const invalidatedTickets = tickets
      .filter(isActiveRenderTicket)
      .filter((ticket) => ticket.sourcePlanRevision !== restored.revision)
      .map(failRenderTicket)
    await Promise.all([
      tx.objectStore('projects').put(restored),
      tx.objectStore('revisions').put(revision),
      ...invalidatedTickets.map((ticket) => tx.objectStore('tickets').put(ticket)),
    ])
    await tx.done
    this.snapshot.project = restored
    this.snapshot.versions = [revision, ...this.snapshot.versions]
    this.snapshot.selectedRevision = restored.revision
    this.snapshot.tickets = this.snapshot.tickets.map(
      (ticket) => invalidatedTickets.find((invalidated) => invalidated.id === ticket.id) ?? ticket,
    )
    this.emit()
    return restored
  }

  async undo() {
    const previous = this.snapshot.versions.find((entry) => entry.revision < this.snapshot.project.revision)
    if (!previous) throw new Error('No earlier revision to restore.')
    return this.restoreRevision(previous.revision)
  }

  exportProject() {
    return JSON.stringify(this.snapshot.project, null, 2)
  }
  async importProject(json: string) {
    const imported = parseProjectImport(json)
    const issues = this.validateProject(imported)
    if (issues.some((issue) => issue.severity === 'error'))
      throw new Error(`Project geometry is invalid: ${issues.find((issue) => issue.severity === 'error')?.message}`)
    const timestamp = nowIso()
    const project = clone(imported)
    project.id = newId('project')
    project.floor.id = newId('floor')
    project.revision = 0
    project.createdAt = timestamp
    project.updatedAt = timestamp
    await saveInitialProject(project)
    await this.initialize()
    return project
  }

  async addPreviewAsset(asset: PreviewAsset) {
    await (await database()).put('previews', asset)
    this.snapshot.previews = [asset, ...this.snapshot.previews]
    this.emit()
  }

  async saveAuthoritative3dPreview(capture: AuthoritativeRenderCapture) {
    if (capture.blob.type !== 'image/png') throw new Error('Authoritative 3D captures must be PNG images.')
    if (capture.manifest.width !== 1536 || capture.manifest.height !== 1024)
      throw new Error('Authoritative 3D captures must use the fixed 1536 × 1024 frame.')
    if (
      capture.manifest.renderer !== 'three.js' ||
      capture.manifest.camera.position.length !== 3 ||
      capture.manifest.camera.quaternion.length !== 4 ||
      capture.manifest.camera.projectionMatrix.length !== 16 ||
      ![
        ...capture.manifest.camera.position,
        ...capture.manifest.camera.quaternion,
        ...capture.manifest.camera.projectionMatrix,
      ].every(Number.isFinite)
    )
      throw new Error('Authoritative 3D capture camera provenance is invalid.')
    await validateRasterBlob(capture.blob, { width: 1536, height: 1024 })
    const project = clone(this.snapshot.project)
    if (this.snapshot.draft || this.snapshot.selectedRevision !== project.revision)
      throw new Error('Authoritative capture requires the latest saved revision.')
    const [sourceDigest, documentDigest] = await Promise.all([
      crypto.subtle.digest('SHA-256', await capture.blob.arrayBuffer()),
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(project))),
    ])
    const hex = (value: ArrayBuffer) =>
      [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const checksum = hex(sourceDigest)
    if (checksum !== capture.manifest.sourceHash || hex(documentDigest) !== capture.manifest.documentHash)
      throw new Error('The authoritative capture provenance does not match its raster or project document.')

    const ticketId = newId('render')
    const blobRef = newId('blob')
    const createdAt = nowIso()
    const ticket: PreviewTicket = {
      id: ticketId,
      projectId: project.id,
      target: { kind: 'floor' },
      sourcePlanRevision: project.revision,
      renderMode: '3d',
      artifactKind: 'authoritative',
      prompt: 'Deterministic Three.js capture from the authoritative metric project document.',
      status: 'ready',
      createdAt,
    }
    const asset: PreviewAsset = {
      id: newId('preview'),
      ticketId,
      projectId: project.id,
      target: { kind: 'floor' },
      sourcePlanRevision: project.revision,
      renderMode: '3d',
      artifactKind: 'authoritative',
      sourceManifest: capture.manifest,
      prompt: ticket.prompt,
      mimeType: 'image/png',
      checksum,
      blobRef,
      createdAt,
    }
    const db = await database()
    const tx = db.transaction(['blobs', 'tickets', 'previews', 'projects', 'settings'], 'readwrite')
    const [activeProjectId, persistedProject] = await Promise.all([
      tx.objectStore('settings').get('activeProjectId'),
      tx.objectStore('projects').get(project.id),
    ])
    if (activeProjectId !== project.id || persistedProject?.revision !== project.revision) {
      await tx.done
      throw new Error('The project revision changed while the authoritative render was captured.')
    }
    await Promise.all([
      tx.objectStore('blobs').put(capture.blob, blobRef),
      tx.objectStore('tickets').put(ticket),
      tx.objectStore('previews').put(asset),
    ])
    await tx.done
    this.snapshot.previews = [asset, ...this.snapshot.previews]
    this.snapshot.tickets = [ticket, ...this.snapshot.tickets]
    this.emit()
    return asset
  }

  async commitPreviewAsset(ticket: PreviewTicket, ownerId: string, asset: PreviewAsset, blob: Blob) {
    const db = await database()
    const tx = db.transaction(['blobs', 'tickets', 'previews', 'projects', 'settings'], 'readwrite')
    const [persistedTicket, activeProjectId] = await Promise.all([
      tx.objectStore('tickets').get(ticket.id),
      tx.objectStore('settings').get('activeProjectId'),
    ])
    const persistedProject = persistedTicket
      ? await tx.objectStore('projects').get(persistedTicket.projectId)
      : undefined
    if (
      !persistedTicket ||
      activeProjectId !== persistedTicket.projectId ||
      persistedProject?.revision !== persistedTicket.sourcePlanRevision ||
      persistedTicket.status !== 'rendering' ||
      persistedTicket.uploadOwnerId !== ownerId ||
      leaseExpired(persistedTicket.uploadLeaseExpiresAt) ||
      asset.projectId !== persistedTicket.projectId ||
      asset.sourcePlanRevision !== persistedTicket.sourcePlanRevision ||
      asset.renderMode !== persistedTicket.renderMode
    ) {
      await tx.done
      throw new Error('Upload lease is no longer owned by this session.')
    }
    const completedTicket: PreviewTicket = {
      ...persistedTicket,
      status: 'ready',
      renderLeaseExpiresAt: undefined,
      uploadOwnerId: undefined,
      uploadLeaseExpiresAt: undefined,
    }
    await Promise.all([
      tx.objectStore('blobs').put(blob, asset.blobRef),
      tx.objectStore('tickets').put(completedTicket),
      tx.objectStore('previews').put(asset),
    ])
    await tx.done
    this.snapshot.previews = [asset, ...this.snapshot.previews]
    this.snapshot.tickets = [completedTicket, ...this.snapshot.tickets.filter((item) => item.id !== ticket.id)]
    this.emit()
  }

  async seedBundledPreviews(items: Array<{ url: string; target: PreviewTicket['target']; prompt: string }>) {
    if (this.snapshot.previews.length) return
    for (const item of items) {
      const response = await fetch(item.url)
      if (!response.ok) continue
      const blob = await response.blob()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
      const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const ticketId = newId('render')
      const blobRef = newId('blob')
      await this.savePreviewBlob(blobRef, blob)
      await this.saveTicket({
        id: ticketId,
        projectId: this.snapshot.project.id,
        target: item.target,
        sourcePlanRevision: this.snapshot.project.revision,
        renderMode: '2d',
        artifactKind: 'concept',
        prompt: item.prompt,
        status: 'ready',
        createdAt: nowIso(),
      })
      const asset: PreviewAsset = {
        id: newId('preview'),
        ticketId,
        projectId: this.snapshot.project.id,
        target: item.target,
        sourcePlanRevision: this.snapshot.project.revision,
        renderMode: '2d',
        artifactKind: 'concept',
        prompt: item.prompt,
        mimeType: 'image/png',
        checksum,
        blobRef,
        createdAt: nowIso(),
      }
      await this.addPreviewAsset(asset)
    }
  }

  async saveTicket(ticket: PreviewTicket) {
    const db = await database()
    const tx = db.transaction('tickets', 'readwrite')
    const projectTickets = await tx.store.index('byProject').getAll(ticket.projectId)
    if (isActiveRenderTicket(ticket)) {
      let active = projectTickets.find(
        (item) => isActiveRenderTicket(item) && item.sourcePlanRevision === ticket.sourcePlanRevision,
      )
      const renderExpired =
        active?.status === 'rendering' &&
        (active.uploadOwnerId ? leaseExpired(active.uploadLeaseExpiresAt) : leaseExpired(active.renderLeaseExpiresAt))
      if (active && renderExpired) {
        active = {
          ...active,
          status: 'queued',
          renderLeaseExpiresAt: undefined,
          uploadOwnerId: undefined,
          uploadLeaseExpiresAt: undefined,
        }
        await tx.store.put(active)
      }
      const stale = projectTickets
        .filter(isActiveRenderTicket)
        .filter((item) => item.sourcePlanRevision !== ticket.sourcePlanRevision)
        .map(failRenderTicket)
      await Promise.all(stale.map((item) => tx.store.put(item)))
      if (stale.length)
        this.snapshot.tickets = this.snapshot.tickets.map(
          (item) => stale.find((invalidated) => invalidated.id === item.id) ?? item,
        )
      if (active) {
        await tx.done
        this.snapshot.tickets = [active, ...this.snapshot.tickets.filter((item) => item.id !== active.id)]
        this.emit()
        return active
      }
    }
    await tx.store.put(ticket)
    await tx.done
    this.snapshot.tickets = [ticket, ...this.snapshot.tickets]
    this.emit()
    return ticket
  }
  async getTicket(ticketId: string) {
    return (await database()).get('tickets', ticketId)
  }
  async queuedRenderJob() {
    const db = await database()
    const tickets = await db.getAllFromIndex('tickets', 'byProject', this.snapshot.project.id)
    const expired = tickets
      .filter(
        (ticket) =>
          ticket.status === 'rendering' &&
          (ticket.uploadOwnerId
            ? leaseExpired(ticket.uploadLeaseExpiresAt)
            : leaseExpired(ticket.renderLeaseExpiresAt)),
      )
      .map((ticket) => ({
        ...ticket,
        status: 'queued' as const,
        renderLeaseExpiresAt: undefined,
        uploadOwnerId: undefined,
        uploadLeaseExpiresAt: undefined,
      }))
    return [...tickets.filter((ticket) => ticket.status === 'queued'), ...expired]
      .filter((ticket) => ticket.sourcePlanRevision === this.snapshot.project.revision)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  }
  async claimRenderJob(ticketId: string) {
    const db = await database()
    const tx = db.transaction(['tickets', 'projects', 'settings'], 'readwrite')
    const [ticket, activeProjectId] = await Promise.all([
      tx.objectStore('tickets').get(ticketId),
      tx.objectStore('settings').get('activeProjectId'),
    ])
    const project = ticket ? await tx.objectStore('projects').get(ticket.projectId) : undefined
    if (!ticket) {
      await tx.done
      throw new Error('Render job not found.')
    }
    if (!project || activeProjectId !== project.id || ticket.sourcePlanRevision !== project.revision) {
      await tx.done
      throw new Error('Render job is stale or belongs to another project.')
    }
    const reclaimable =
      ticket.status === 'rendering' &&
      (ticket.uploadOwnerId ? leaseExpired(ticket.uploadLeaseExpiresAt) : leaseExpired(ticket.renderLeaseExpiresAt))
    if (ticket.status !== 'queued' && !reclaimable) {
      await tx.done
      throw new Error('Render job is not queued.')
    }
    const claimed: PreviewTicket = {
      ...ticket,
      status: 'rendering',
      renderLeaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      uploadOwnerId: undefined,
      uploadLeaseExpiresAt: undefined,
    }
    await tx.objectStore('tickets').put(claimed)
    await tx.done
    this.snapshot.tickets = [claimed, ...this.snapshot.tickets.filter((item) => item.id !== ticket.id)]
    this.emit()
    return claimed
  }
  async claimPreviewTicket(ticketId: string, ownerId: string, leaseExpiresAt: string) {
    const db = await database()
    const tx = db.transaction(['tickets', 'projects', 'settings'], 'readwrite')
    const [ticket, activeProjectId] = await Promise.all([
      tx.objectStore('tickets').get(ticketId),
      tx.objectStore('settings').get('activeProjectId'),
    ])
    const project = ticket ? await tx.objectStore('projects').get(ticket.projectId) : undefined
    const leaseExpired =
      ticket?.status === 'rendering' &&
      Boolean(ticket.uploadOwnerId) &&
      (!ticket.uploadLeaseExpiresAt || Date.parse(ticket.uploadLeaseExpiresAt) <= Date.now())
    if (!ticket) {
      await tx.done
      throw new Error('Render ticket not found.')
    }
    if (!project || activeProjectId !== project.id || ticket.sourcePlanRevision !== project.revision) {
      await tx.done
      throw new Error('Render ticket is stale or belongs to another project.')
    }
    if (ticket.status !== 'rendering' || (ticket.uploadOwnerId && !leaseExpired)) {
      await tx.done
      throw new Error('Render ticket is not available for a new upload.')
    }
    const claimed: PreviewTicket = {
      ...ticket,
      uploadOwnerId: ownerId,
      uploadLeaseExpiresAt: leaseExpiresAt,
    }
    await tx.objectStore('tickets').put(claimed)
    await tx.done
    this.snapshot.tickets = [claimed, ...this.snapshot.tickets.filter((item) => item.id !== ticket.id)]
    this.emit()
    return claimed
  }
  async failRenderJob(ticketId: string) {
    const db = await database()
    const tx = db.transaction(['tickets', 'settings'], 'readwrite')
    const [ticket, activeProjectId] = await Promise.all([
      tx.objectStore('tickets').get(ticketId),
      tx.objectStore('settings').get('activeProjectId'),
    ])
    if (!ticket || ticket.projectId !== activeProjectId || ticket.status !== 'rendering' || ticket.uploadOwnerId) {
      await tx.done
      throw new Error('Render job is not available to fail before upload.')
    }
    const failed = failRenderTicket(ticket)
    await tx.objectStore('tickets').put(failed)
    await tx.done
    this.snapshot.tickets = [failed, ...this.snapshot.tickets.filter((item) => item.id !== ticketId)]
    this.emit()
    return failed
  }
  async failPreviewTicket(ticketId: string, ownerId: string) {
    const db = await database()
    const tx = db.transaction(['tickets', 'settings'], 'readwrite')
    const [ticket, activeProjectId] = await Promise.all([
      tx.objectStore('tickets').get(ticketId),
      tx.objectStore('settings').get('activeProjectId'),
    ])
    if (
      !ticket ||
      ticket.projectId !== activeProjectId ||
      ticket.status !== 'rendering' ||
      ticket.uploadOwnerId !== ownerId ||
      leaseExpired(ticket.uploadLeaseExpiresAt)
    ) {
      await tx.done
      throw new Error('Upload lease is no longer owned by this session.')
    }
    const failed = failRenderTicket(ticket)
    await tx.objectStore('tickets').put(failed)
    await tx.done
    this.snapshot.tickets = [failed, ...this.snapshot.tickets.filter((item) => item.id !== ticketId)]
    this.emit()
    return failed
  }
  async renewPreviewTicketLease(ticketId: string, ownerId: string, leaseExpiresAt: string) {
    const db = await database()
    const tx = db.transaction(['tickets', 'settings'], 'readwrite')
    const [ticket, activeProjectId] = await Promise.all([
      tx.objectStore('tickets').get(ticketId),
      tx.objectStore('settings').get('activeProjectId'),
    ])
    if (
      !ticket ||
      ticket.projectId !== activeProjectId ||
      ticket.status !== 'rendering' ||
      ticket.uploadOwnerId !== ownerId ||
      leaseExpired(ticket.uploadLeaseExpiresAt)
    ) {
      await tx.done
      throw new Error('Upload lease is no longer owned by this session.')
    }
    const renewed = { ...ticket, uploadLeaseExpiresAt: leaseExpiresAt }
    await tx.objectStore('tickets').put(renewed)
    await tx.done
    this.snapshot.tickets = [renewed, ...this.snapshot.tickets.filter((item) => item.id !== ticketId)]
    this.emit()
    return renewed
  }
  async previewBlob(asset: PreviewAsset) {
    return getBlob(asset.blobRef)
  }
  async savePreviewBlob(ref: string, blob: Blob) {
    return saveBlob(ref, blob)
  }
}

export const studio = new StudioService()
