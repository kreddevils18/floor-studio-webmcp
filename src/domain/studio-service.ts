import { database, getBlob, saveBlob, saveInitialProject } from '../data/database'
import { geometry } from '../core/geometry-engine'
import { createSampleProject } from './sample-project'
import type {
  ActivityEvent, ChangeOperation, ChangeSet, HumanRequest, LayoutPatch, PreviewAsset, PreviewTicket,
  ProjectDocumentV1, RevisionRecord, RoomStyle, StudioSnapshot, ValidationIssue,
} from './model'
import { newId, nowIso } from './model'

const clone = <T,>(value: T): T => structuredClone(value)
const IMPORT_MAX_BYTES = 2 * 1024 * 1024
const IMPORT_MAX_ITEMS = 2_000

function parseProjectImport(json: string): ProjectDocumentV1 {
  if (new TextEncoder().encode(json).byteLength > IMPORT_MAX_BYTES) throw new Error('Project JSON cannot exceed 2 MB.')
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('Project JSON is not valid JSON.') }
  const object = (input: unknown, path: string) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path} must be an object.`)
    return input as Record<string, unknown>
  }
  const string = (input: unknown, path: string, max = 500) => {
    if (typeof input !== 'string' || !input.trim() || input.length > max) throw new Error(`${path} must be a non-empty string of at most ${max} characters.`)
    return input
  }
  const optionalString = (input: unknown, path: string, max = 500) => input === undefined ? undefined : string(input, path, max)
  const id = (input: unknown, path: string) => {
    const result = string(input, path, 128)
    if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new Error(`${path} contains unsupported ID characters.`)
    return result
  }
  const integer = (input: unknown, path: string, min = -10_000_000, max = 10_000_000) => {
    if (!Number.isInteger(input) || (input as number) < min || (input as number) > max) throw new Error(`${path} must be an integer between ${min} and ${max}.`)
    return input as number
  }
  const finite = (input: unknown, path: string, min = -36_000, max = 36_000) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) throw new Error(`${path} must be a finite number between ${min} and ${max}.`)
    return input
  }
  const array = (input: unknown, path: string) => {
    if (!Array.isArray(input) || input.length > IMPORT_MAX_ITEMS) throw new Error(`${path} must be an array with at most ${IMPORT_MAX_ITEMS} items.`)
    return input
  }
  const point = (input: unknown, path: string) => { const item = object(input, path); return { x: integer(item.x, `${path}.x`), y: integer(item.y, `${path}.y`) } }
  const root = object(value, 'project')
  if (root.schemaVersion !== 1) throw new Error('Only ProjectDocumentV1 JSON is supported.')
  const floorValue = object(root.floor, 'project.floor')
  if (floorValue.unit !== 'mm') throw new Error('Only millimetre floor documents are supported.')
  const walls = array(floorValue.walls, 'project.floor.walls').map((entry, index) => { const item = object(entry, `walls[${index}]`); return { id: id(item.id, `walls[${index}].id`), start: point(item.start, `walls[${index}].start`), end: point(item.end, `walls[${index}].end`), thicknessMm: integer(item.thicknessMm, `walls[${index}].thicknessMm`, 1, 5_000), finish: optionalString(item.finish, `walls[${index}].finish`) } })
  const openings = array(floorValue.openings, 'project.floor.openings').map((entry, index) => { const item = object(entry, `openings[${index}]`); if (item.kind !== 'door' && item.kind !== 'window') throw new Error(`openings[${index}].kind is invalid.`); if (item.swing !== undefined && !['left', 'right', 'sliding'].includes(item.swing as string)) throw new Error(`openings[${index}].swing is invalid.`); return { id: id(item.id, `openings[${index}].id`), wallId: id(item.wallId, `openings[${index}].wallId`), kind: item.kind as 'door' | 'window', offsetMm: integer(item.offsetMm, `openings[${index}].offsetMm`, 0), widthMm: integer(item.widthMm, `openings[${index}].widthMm`, 1), swing: item.swing as 'left' | 'right' | 'sliding' | undefined } })
  const roomMarkers = array(floorValue.roomMarkers, 'project.floor.roomMarkers').map((entry, index) => { const item = object(entry, `roomMarkers[${index}]`); return { id: id(item.id, `roomMarkers[${index}].id`), name: string(item.name, `roomMarkers[${index}].name`, 120), position: point(item.position, `roomMarkers[${index}].position`) } })
  const furniture = array(floorValue.furniture, 'project.floor.furniture').map((entry, index) => { const item = object(entry, `furniture[${index}]`); return { id: id(item.id, `furniture[${index}].id`), kind: string(item.kind, `furniture[${index}].kind`, 120), label: string(item.label, `furniture[${index}].label`, 160), position: point(item.position, `furniture[${index}].position`), widthMm: integer(item.widthMm, `furniture[${index}].widthMm`, 1), depthMm: integer(item.depthMm, `furniture[${index}].depthMm`, 1), rotationDegrees: finite(item.rotationDegrees, `furniture[${index}].rotationDegrees`) } })
  const dimensions = array(floorValue.dimensions, 'project.floor.dimensions').map((entry, index) => { const item = object(entry, `dimensions[${index}]`); return { id: id(item.id, `dimensions[${index}].id`), start: point(item.start, `dimensions[${index}].start`), end: point(item.end, `dimensions[${index}].end`), label: optionalString(item.label, `dimensions[${index}].label`, 160) } })
  const annotations = array(floorValue.annotations, 'project.floor.annotations').map((entry, index) => { const item = object(entry, `annotations[${index}]`); if (item.kind !== 'comment' && item.kind !== 'note') throw new Error(`annotations[${index}].kind is invalid.`); return { id: id(item.id, `annotations[${index}].id`), position: point(item.position, `annotations[${index}].position`), text: string(item.text, `annotations[${index}].text`, 1_000), kind: item.kind as 'comment' | 'note' } })
  const roomStyles = array(floorValue.roomStyles, 'project.floor.roomStyles').map((entry, index) => { const item = object(entry, `roomStyles[${index}]`); const palette = array(item.palette, `roomStyles[${index}].palette`); if (palette.length > 20) throw new Error(`roomStyles[${index}].palette has too many colors.`); return { roomId: id(item.roomId, `roomStyles[${index}].roomId`), floorMaterial: string(item.floorMaterial, `roomStyles[${index}].floorMaterial`), wallFinish: string(item.wallFinish, `roomStyles[${index}].wallFinish`), ceilingHeightMm: integer(item.ceilingHeightMm, `roomStyles[${index}].ceilingHeightMm`, 1_000, 20_000), palette: palette.map((color, colorIndex) => string(color, `roomStyles[${index}].palette[${colorIndex}]`, 64)), renderStyle: string(item.renderStyle, `roomStyles[${index}].renderStyle`) } })
  const createdAt = string(root.createdAt, 'project.createdAt', 64); const updatedAt = string(root.updatedAt, 'project.updatedAt', 64)
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Project timestamps are invalid.')
  const project: ProjectDocumentV1 = { schemaVersion: 1, id: id(root.id, 'project.id'), name: string(root.name, 'project.name', 120), createdAt, updatedAt, revision: integer(root.revision, 'project.revision', 0, Number.MAX_SAFE_INTEGER), floor: { id: id(floorValue.id, 'project.floor.id'), name: string(floorValue.name, 'project.floor.name', 120), unit: 'mm', walls, openings, roomMarkers, furniture, dimensions, annotations, roomStyles } }
  const entityIds = [...walls, ...openings, ...roomMarkers, ...furniture, ...dimensions, ...annotations].map((entry) => entry.id)
  if (new Set(entityIds).size !== entityIds.length) throw new Error('Project contains duplicate entity IDs.')
  const wallIds = new Set(walls.map((wall) => wall.id)); if (openings.some((opening) => !wallIds.has(opening.wallId))) throw new Error('Project contains an opening attached to a missing wall.')
  const roomIds = new Set(roomMarkers.map((room) => room.id)); if (roomStyles.some((style) => !roomIds.has(style.roomId)) || new Set(roomStyles.map((style) => style.roomId)).size !== roomStyles.length) throw new Error('Project contains invalid room style references.')
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
      if (patch.openings) next.floor.openings = upsertById(next.floor.openings, patch.openings.upsert, patch.openings.remove)
      if (patch.roomMarkers) next.floor.roomMarkers = upsertById(next.floor.roomMarkers, patch.roomMarkers.upsert, patch.roomMarkers.remove)
      if (patch.furniture) next.floor.furniture = upsertById(next.floor.furniture, patch.furniture.upsert, patch.furniture.remove)
    } else {
      const replacements = new Map(operation.styles.map((style) => [style.roomId, style]))
      next.floor.roomStyles = next.floor.roomStyles.map((style) => replacements.get(style.roomId) ?? style)
      for (const style of operation.styles) if (!next.floor.roomStyles.some((existing) => existing.roomId === style.roomId)) next.floor.roomStyles.push(style)
    }
  }
  return next
}

type Listener = (snapshot: StudioSnapshot) => void

export class StudioService {
  private snapshotValue: StudioSnapshot | null = null
  private listeners = new Set<Listener>()

  get snapshot() { if (!this.snapshotValue) throw new Error('Studio has not initialized.'); return this.snapshotValue }
  subscribe(listener: Listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { const value = this.snapshot; for (const listener of this.listeners) listener(value) }

  async initialize() {
    const db = await database()
    const activeProjectId = await db.get('settings', 'activeProjectId')
    let project = activeProjectId ? await db.get('projects', activeProjectId) : undefined
    project ??= (await db.getAll('projects'))[0]
    if (!project) { project = createSampleProject(); await saveInitialProject(project) }
    const [drafts, requests, activity, previews, versions, tickets] = await Promise.all([
      db.getAllFromIndex('drafts', 'byProject', project.id), db.getAllFromIndex('requests', 'byProject', project.id),
      db.getAllFromIndex('activity', 'byProject', project.id), db.getAllFromIndex('previews', 'byProject', project.id),
      db.getAllFromIndex('revisions', 'byProject', project.id), db.getAllFromIndex('tickets', 'byProject', project.id),
    ])
    await Promise.all(tickets.map(async (ticket) => {
      if (ticket.status !== 'uploading') return
      const tx = db.transaction('tickets', 'readwrite'); const current = await tx.store.get(ticket.id)
      if (current?.status === 'uploading' && (!current.uploadLeaseExpiresAt || Date.parse(current.uploadLeaseExpiresAt) <= Date.now())) await tx.store.put({ ...current, status: 'prepared', uploadOwnerId: undefined, uploadLeaseExpiresAt: undefined })
      await tx.done
    }))
    this.snapshotValue = {
      project, draft: drafts.find((draft) => draft.status === 'draft' || draft.status === 'presented') ?? null,
      requests: requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      activity: activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      previews: previews.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      versions: versions.sort((a, b) => b.revision - a.revision), selectedIds: [], activeView: '2d',
    }
    if (!this.snapshot.activity.length) await this.log('system', 'Local project restored. Geometry is ready for review.')
    this.emit()
    return this.snapshot
  }

  private async log(kind: string, message: string) {
    const event: ActivityEvent = { id: newId('event'), projectId: this.snapshot.project.id, kind, message, createdAt: nowIso() }
    await (await database()).put('activity', event)
    this.snapshot.activity = [event, ...this.snapshot.activity].slice(0, 100)
    this.emit()
    return event
  }

  focus(ids: string[], view: '2d' | '3d' = '2d') { this.snapshot.selectedIds = [...new Set(ids)]; this.snapshot.activeView = view; this.emit() }
  setView(view: '2d' | '3d') { this.snapshot.activeView = view; this.emit() }

  async createProject(name: string) {
    if (!name.trim()) throw new Error('Project name is required.')
    const timestamp = nowIso()
    const project: ProjectDocumentV1 = {
      schemaVersion: 1, id: newId('project'), name: name.trim(), createdAt: timestamp, updatedAt: timestamp, revision: 0,
      floor: { id: newId('floor'), name: 'Ground floor', unit: 'mm', walls: [], openings: [], roomMarkers: [], furniture: [], dimensions: [], annotations: [], roomStyles: [] },
    }
    await saveInitialProject(project)
    this.snapshotValue = { project, draft: null, requests: [], activity: [], previews: [], versions: [{ id: `${project.id}:0`, projectId: project.id, revision: 0, document: project, createdAt: timestamp }], selectedIds: [], activeView: '2d' }
    await this.log('project', `Created ${project.name}.`)
    return project
  }

  async queueRequest(text: string) {
    if (!text.trim()) throw new Error('Describe the requested change first.')
    const timestamp = nowIso()
    const request: HumanRequest = { id: newId('request'), projectId: this.snapshot.project.id, text: text.trim(), selection: this.snapshot.selectedIds, status: 'pending', createdAt: timestamp, updatedAt: timestamp }
    await (await database()).put('requests', request)
    this.snapshot.requests = [...this.snapshot.requests, request]
    await this.log('request', 'Request queued locally. Ask Codex to process pending work.')
    return request
  }

  oldestPendingRequest() { return this.snapshot.requests.find((request) => request.status === 'pending') ?? null }
  async setRequestStatus(id: string, status: HumanRequest['status']) {
    const request = this.snapshot.requests.find((entry) => entry.id === id)
    if (!request) throw new Error('Request not found.')
    if (request.status === 'completed' || request.status === 'failed') throw new Error('Finished requests cannot change status.')
    if (status === 'pending') throw new Error('A request cannot be returned to pending.')
    request.status = status; request.updatedAt = nowIso()
    await (await database()).put('requests', request)
    await this.log('request', `Request ${status}.`)
    return request
  }

  async beginChange(baseRevision: number, requestId?: string) {
    if (this.snapshot.draft && ['draft', 'presented'].includes(this.snapshot.draft.status)) throw new Error('An active change already exists.')
    const draft: ChangeSet = { id: newId('change'), projectId: this.snapshot.project.id, baseRevision, operations: [], validationResults: [], status: 'draft', requestId, createdAt: nowIso() }
    const db = await database(); const tx = db.transaction(['projects', 'drafts'], 'readwrite')
    const persisted = await tx.objectStore('projects').get(this.snapshot.project.id)
    if (!persisted || baseRevision !== persisted.revision) { await tx.done; throw new Error(`Stale base revision ${baseRevision}; current revision is ${persisted?.revision ?? 'missing'}.`) }
    const activeDrafts = await tx.objectStore('drafts').index('byProject').getAll(this.snapshot.project.id)
    if (activeDrafts.some((entry) => entry.status === 'draft' || entry.status === 'presented')) { await tx.done; throw new Error('An active change already exists.') }
    await tx.objectStore('drafts').put(draft); await tx.done
    this.snapshot.draft = draft
    await this.log('change', `Change set opened on revision ${baseRevision}.`)
    return draft
  }

  private requireDraft() {
    const draft = this.snapshot.draft
    if (!draft || draft.status !== 'draft') throw new Error('No editable draft is open.')
    if (draft.baseRevision !== this.snapshot.project.revision) throw new Error(`Draft is stale; current revision is ${this.snapshot.project.revision}.`)
    return draft
  }

  async applyLayout(patch: LayoutPatch) { return this.appendOperation({ kind: 'layout', patch }) }
  async applyStyle(styles: RoomStyle[]) { return this.appendOperation({ kind: 'style', styles }) }
  private async appendOperation(operation: ChangeOperation) {
    const draft = this.requireDraft()
    const operationIds = operation.kind === 'layout'
      ? [operation.patch.walls?.upsert, operation.patch.openings?.upsert, operation.patch.roomMarkers?.upsert, operation.patch.furniture?.upsert].flatMap((items) => items?.map((item) => item.id) ?? [])
      : operation.styles.map((style) => style.roomId)
    if (new Set(operationIds).size !== operationIds.length) throw new Error('Transaction contains duplicate entity or room style IDs.')
    const staged = applyOperations(this.snapshot.project, [...draft.operations, operation])
    const issues = this.validateProject(staged)
    if (issues.some((issue) => ['duplicate_id', 'style_room_missing', 'duplicate_style'].includes(issue.code))) throw new Error('Transaction rejected because entity IDs or style references are invalid.')
    draft.operations.push(clone(operation)); draft.validationResults = issues
    await (await database()).put('drafts', draft)
    await this.log('change', `${operation.kind === 'layout' ? 'Layout' : 'Material'} edits staged.`)
    return { draft, issueCount: issues.length }
  }

  stagedProject() { return this.snapshot.draft ? applyOperations(this.snapshot.project, this.snapshot.draft.operations) : this.snapshot.project }
  async validateChange(): Promise<ValidationIssue[]> {
    const draft = this.requireDraft()
    draft.validationResults = this.validateProject(this.stagedProject())
    await (await database()).put('drafts', draft); this.emit()
    return draft.validationResults
  }

  private validateProject(project: ProjectDocumentV1) {
    const issues = geometry.validate(project.floor)
    const rooms = new Set(project.floor.roomMarkers.map((room) => room.id)); const styleIds = new Set<string>()
    for (const style of project.floor.roomStyles) {
      if (!rooms.has(style.roomId)) issues.push({ code: 'style_room_missing', severity: 'error', entityId: style.roomId, message: 'Room style references a missing room marker.' })
      if (styleIds.has(style.roomId)) issues.push({ code: 'duplicate_style', severity: 'error', entityId: style.roomId, message: 'Each room can have only one style record.' })
      styleIds.add(style.roomId)
    }
    return issues
  }

  async presentChange() {
    const draft = this.requireDraft()
    const issues = await this.validateChange()
    if (issues.some((issue) => issue.severity === 'error')) throw new Error('Resolve validation errors before presenting this change.')
    draft.status = 'presented'; await (await database()).put('drafts', draft)
    await this.log('change', 'Draft is ready for human review.'); return draft
  }

  async discardChange() {
    const draft = this.snapshot.draft
    if (!draft || draft.status === 'approved') throw new Error('No unapproved change exists.')
    draft.status = 'discarded'; await (await database()).put('drafts', draft)
    this.snapshot.draft = null; await this.log('change', 'Draft discarded.'); return draft
  }

  async approvePresentedChange() {
    const draft = this.snapshot.draft
    if (!draft || draft.status !== 'presented') throw new Error('Only a presented change can be approved.')
    const db = await database(); const tx = db.transaction(['projects', 'revisions', 'drafts'], 'readwrite')
    const [persisted, persistedDraft] = await Promise.all([tx.objectStore('projects').get(draft.projectId), tx.objectStore('drafts').get(draft.id)])
    if (!persisted || persisted.revision !== draft.baseRevision || persistedDraft?.status !== 'presented') { await tx.done; throw new Error('Cannot approve a stale or superseded change.') }
    const project = applyOperations(persisted, persistedDraft.operations)
    project.revision = persisted.revision + 1; project.updatedAt = nowIso(); persistedDraft.status = 'approved'
    const revision: RevisionRecord = { id: `${project.id}:${project.revision}`, projectId: project.id, revision: project.revision, document: clone(project), createdAt: project.updatedAt }
    await Promise.all([tx.objectStore('projects').put(project), tx.objectStore('revisions').put(revision), tx.objectStore('drafts').put(persistedDraft)]); await tx.done
    this.snapshot.project = project; this.snapshot.versions = [revision, ...this.snapshot.versions]; this.snapshot.draft = null
    await this.log('approval', `Revision ${project.revision} approved.`); return project
  }

  async restoreRevision(revisionNumber: number) {
    if (this.snapshot.draft) throw new Error('Discard the active draft before restoring a version.')
    const expectedRevision = this.snapshot.project.revision; const projectId = this.snapshot.project.id
    const db = await database(); const tx = db.transaction(['projects', 'revisions', 'drafts'], 'readwrite')
    const [persisted, source, drafts] = await Promise.all([
      tx.objectStore('projects').get(projectId), tx.objectStore('revisions').get(`${projectId}:${revisionNumber}`),
      tx.objectStore('drafts').index('byProject').getAll(projectId),
    ])
    if (!persisted || persisted.revision !== expectedRevision) { await tx.done; throw new Error('Cannot restore from a stale project snapshot.') }
    if (!source) { await tx.done; throw new Error('Revision not found.') }
    if (drafts.some((draft) => draft.status === 'draft' || draft.status === 'presented')) { await tx.done; throw new Error('Discard the active draft before restoring a version.') }
    const restored = clone(source.document); restored.revision = persisted.revision + 1; restored.updatedAt = nowIso()
    const revision: RevisionRecord = { id: `${restored.id}:${restored.revision}`, projectId: restored.id, revision: restored.revision, document: clone(restored), createdAt: restored.updatedAt }
    await Promise.all([tx.objectStore('projects').put(restored), tx.objectStore('revisions').put(revision)]); await tx.done
    this.snapshot.project = restored; this.snapshot.versions = [revision, ...this.snapshot.versions]
    await this.log('version', `Restored revision ${revisionNumber} as revision ${restored.revision}.`); return restored
  }

  async undo() {
    const previous = this.snapshot.versions.find((entry) => entry.revision < this.snapshot.project.revision)
    if (!previous) throw new Error('No earlier revision to restore.')
    return this.restoreRevision(previous.revision)
  }

  exportProject() { return JSON.stringify(this.snapshot.project, null, 2) }
  async importProject(json: string) {
    const imported = parseProjectImport(json)
    const issues = this.validateProject(imported)
    if (issues.some((issue) => issue.severity === 'error')) throw new Error(`Project geometry is invalid: ${issues.find((issue) => issue.severity === 'error')?.message}`)
    const timestamp = nowIso(); const project = clone(imported)
    project.id = newId('project'); project.floor.id = newId('floor'); project.revision = 0; project.createdAt = timestamp; project.updatedAt = timestamp
    await saveInitialProject(project); await this.initialize(); return project
  }

  async addPreviewAsset(asset: PreviewAsset) {
    await (await database()).put('previews', asset); this.snapshot.previews = [asset, ...this.snapshot.previews]
    await this.log('preview', `${asset.target.kind === 'room' ? 'Room' : 'Whole-floor'} preview received.`)
  }

  async commitPreviewAsset(ticket: PreviewTicket, ownerId: string, asset: PreviewAsset, blob: Blob) {
    const event: ActivityEvent = { id: newId('event'), projectId: asset.projectId, kind: 'preview', message: `${asset.target.kind === 'room' ? 'Room' : 'Whole-floor'} preview received.`, createdAt: nowIso() }
    const db = await database(); const tx = db.transaction(['blobs', 'tickets', 'previews', 'activity'], 'readwrite')
    const persistedTicket = await tx.objectStore('tickets').get(ticket.id)
    if (!persistedTicket || persistedTicket.status !== 'uploading' || persistedTicket.uploadOwnerId !== ownerId) { await tx.done; throw new Error('Upload lease is no longer owned by this session.') }
    const completedTicket: PreviewTicket = { ...ticket, status: 'ready', uploadOwnerId: undefined, uploadLeaseExpiresAt: undefined }
    await Promise.all([
      tx.objectStore('blobs').put(blob, asset.blobRef), tx.objectStore('tickets').put(completedTicket),
      tx.objectStore('previews').put(asset), tx.objectStore('activity').put(event),
    ]); await tx.done
    this.snapshot.previews = [asset, ...this.snapshot.previews]; this.snapshot.activity = [event, ...this.snapshot.activity].slice(0, 100); this.emit()
  }

  async seedBundledPreviews(items: Array<{ url: string; target: PreviewTicket['target']; prompt: string }>) {
    if (this.snapshot.previews.length) return
    for (const item of items) {
      const response = await fetch(item.url); if (!response.ok) continue
      const blob = await response.blob(); const bytes = new Uint8Array(await blob.arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
      const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const ticketId = newId('render'); const blobRef = newId('blob')
      await this.savePreviewBlob(blobRef, blob)
      const asset: PreviewAsset = {
        id: newId('preview'), ticketId, projectId: this.snapshot.project.id, target: item.target,
        sourcePlanRevision: this.snapshot.project.revision, prompt: item.prompt, mimeType: 'image/png', checksum, blobRef, createdAt: nowIso(),
      }
      await this.addPreviewAsset(asset)
    }
  }

  async saveTicket(ticket: PreviewTicket) { await (await database()).put('tickets', ticket) }
  async getTicket(ticketId: string) { return (await database()).get('tickets', ticketId) }
  async claimPreviewTicket(ticketId: string, ownerId: string, leaseExpiresAt: string) {
    const db = await database(); const tx = db.transaction(['tickets', 'projects'], 'readwrite')
    const ticket = await tx.objectStore('tickets').get(ticketId)
    const project = ticket ? await tx.objectStore('projects').get(ticket.projectId) : undefined
    const leaseExpired = ticket?.status === 'uploading' && (!ticket.uploadLeaseExpiresAt || Date.parse(ticket.uploadLeaseExpiresAt) <= Date.now())
    if (!ticket) { await tx.done; throw new Error('Render ticket not found.') }
    if (!project || project.id !== this.snapshot.project.id || ticket.sourcePlanRevision !== project.revision) { await tx.done; throw new Error('Render ticket is stale or belongs to another project.') }
    if (ticket.status !== 'prepared' && !leaseExpired) { await tx.done; throw new Error('Render ticket is not available for a new upload.') }
    const claimed = { ...ticket, status: 'uploading' as const, uploadOwnerId: ownerId, uploadLeaseExpiresAt: leaseExpiresAt }
    await tx.objectStore('tickets').put(claimed); await tx.done; return claimed
  }
  async failPreviewTicket(ticketId: string, ownerId: string) {
    const db = await database(); const tx = db.transaction('tickets', 'readwrite'); const ticket = await tx.store.get(ticketId)
    if (!ticket || ticket.status !== 'uploading' || ticket.uploadOwnerId !== ownerId) { await tx.done; throw new Error('Upload lease is no longer owned by this session.') }
    const failed = { ...ticket, status: 'failed' as const, uploadOwnerId: undefined, uploadLeaseExpiresAt: undefined }; await tx.store.put(failed); await tx.done; return failed
  }
  async renewPreviewTicketLease(ticketId: string, ownerId: string, leaseExpiresAt: string) {
    const db = await database(); const tx = db.transaction('tickets', 'readwrite'); const ticket = await tx.store.get(ticketId)
    if (!ticket || ticket.status !== 'uploading' || ticket.uploadOwnerId !== ownerId) { await tx.done; throw new Error('Upload lease is no longer owned by this session.') }
    const renewed = { ...ticket, uploadLeaseExpiresAt: leaseExpiresAt }; await tx.store.put(renewed); await tx.done; return renewed
  }
  async previewBlob(asset: PreviewAsset) { return getBlob(asset.blobRef) }
  async savePreviewBlob(ref: string, blob: Blob) { return saveBlob(ref, blob) }
}

export const studio = new StudioService()
