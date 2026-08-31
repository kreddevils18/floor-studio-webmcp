export type Millimetres = number
export type EntityId = string

export interface PointMm {
  x: Millimetres
  y: Millimetres
}

export interface Wall {
  id: EntityId
  start: PointMm
  end: PointMm
  thicknessMm: Millimetres
  finish?: string
}

export interface Opening {
  id: EntityId
  wallId: EntityId
  kind: 'door' | 'window'
  offsetMm: Millimetres
  widthMm: Millimetres
  swing?: 'left' | 'right' | 'sliding'
}

export interface RoomMarker {
  id: EntityId
  name: string
  position: PointMm
}

export interface FurnitureSymbol {
  id: EntityId
  kind: string
  label: string
  position: PointMm
  widthMm: Millimetres
  depthMm: Millimetres
  rotationDegrees: number
}

export interface DimensionAnnotation {
  id: EntityId
  start: PointMm
  end: PointMm
  label?: string
}

export interface TextAnnotation {
  id: EntityId
  position: PointMm
  text: string
  kind: 'comment' | 'note'
}

export interface RoomStyle {
  roomId: EntityId
  floorMaterial: string
  wallFinish: string
  ceilingHeightMm: Millimetres
  palette: string[]
  renderStyle: string
}

export interface Floor {
  id: EntityId
  name: string
  unit: 'mm'
  walls: Wall[]
  openings: Opening[]
  roomMarkers: RoomMarker[]
  furniture: FurnitureSymbol[]
  dimensions: DimensionAnnotation[]
  annotations: TextAnnotation[]
  roomStyles: RoomStyle[]
}

export interface ProjectDocumentV1 {
  schemaVersion: 1
  id: EntityId
  name: string
  createdAt: string
  updatedAt: string
  revision: number
  floor: Floor
}

export type LayoutPatch = {
  walls?: { upsert?: Wall[]; remove?: EntityId[] }
  openings?: { upsert?: Opening[]; remove?: EntityId[] }
  roomMarkers?: { upsert?: RoomMarker[]; remove?: EntityId[] }
  furniture?: { upsert?: FurnitureSymbol[]; remove?: EntityId[] }
}

export type ChangeOperation = { kind: 'layout'; patch: LayoutPatch } | { kind: 'style'; styles: RoomStyle[] }

export interface ValidationIssue {
  code: string
  severity: 'error' | 'warning'
  entityId?: EntityId
  message: string
}

export interface ChangeSet {
  id: EntityId
  projectId: EntityId
  baseRevision: number
  operations: ChangeOperation[]
  validationResults: ValidationIssue[]
  status: 'draft' | 'presented' | 'discarded' | 'saved' | 'rejected'
  resultRevision?: number
  createdAt: string
}

export type RenderMode = '2d' | '3d'

export interface AgentTimelineEvent {
  id: EntityId
  projectId: EntityId
  sessionId: string
  callId: string
  sequence: number
  toolName: string
  phase: 'started' | 'succeeded' | 'failed' | 'awaiting-human'
  startedAt: string
  completedAt?: string
  durationMs?: number
  inputSummary?: string
  outputSummary?: string
  errorCode?: string
  baseRevision?: number
  resultRevision?: number
  changeId?: string
  entityIds?: string[]
}

export interface DerivedRoom {
  id: EntityId
  name: string
  polygon: PointMm[]
  areaSquareMetres: number
}

export interface PreviewTicket {
  id: EntityId
  projectId: EntityId
  target: { kind: 'room'; roomId: EntityId } | { kind: 'floor' }
  sourcePlanRevision: number
  renderMode: RenderMode
  prompt: string
  status: 'queued' | 'rendering' | 'ready' | 'failed'
  renderLeaseExpiresAt?: string
  uploadOwnerId?: string
  uploadLeaseExpiresAt?: string
  createdAt: string
}

export interface PreviewAsset {
  id: EntityId
  ticketId: EntityId
  projectId: EntityId
  target: PreviewTicket['target']
  sourcePlanRevision: number
  renderMode: RenderMode
  prompt: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  checksum: string
  blobRef: string
  createdAt: string
}

export interface RevisionRecord {
  id: string
  projectId: string
  revision: number
  document: ProjectDocumentV1
  createdAt: string
}

export interface StudioSnapshot {
  project: ProjectDocumentV1
  draft: ChangeSet | null
  timeline: AgentTimelineEvent[]
  previews: PreviewAsset[]
  tickets: PreviewTicket[]
  versions: RevisionRecord[]
  selectedIds: string[]
  activeView: '2d' | '3d' | 'render'
  renderMode: RenderMode
  selectedRevision: number
  projectState: 'draft' | 'saved'
}

export const nowIso = () => new Date().toISOString()
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
