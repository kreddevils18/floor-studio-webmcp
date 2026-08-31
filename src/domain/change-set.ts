import type { LayoutPatch, ProjectDocumentV1, RoomStyle } from './model'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z][a-zA-Z0-9 -]{0,31})$/

type MutationGroup = { upsert?: Array<{ id: string }>; remove?: string[] }

export function validateLayoutPatch(patch: LayoutPatch, project: ProjectDocumentV1) {
  const groups = Object.values(patch).filter(Boolean) as MutationGroup[]
  if (!groups.length || groups.every((group) => !(group.upsert?.length || group.remove?.length))) {
    throw new Error('Layout patch must contain at least one mutation.')
  }
  let entityCount = 0
  for (const group of groups) {
    const upsertIds = group.upsert?.map((item) => item.id) ?? []
    const removeIds = group.remove ?? []
    entityCount += upsertIds.length + removeIds.length
    for (const id of [...upsertIds, ...removeIds]) if (!ID_PATTERN.test(id)) throw new Error(`Invalid entity ID: ${id}`)
    if (new Set(upsertIds).size !== upsertIds.length || new Set(removeIds).size !== removeIds.length)
      throw new Error('Mutation groups cannot contain duplicate IDs.')
    if (upsertIds.some((id) => removeIds.includes(id)))
      throw new Error('An ID cannot be both upserted and removed in one mutation group.')
  }
  if (entityCount > 50) throw new Error('A layout call may mutate at most 50 entities.')

  const existingWalls = new Set(project.floor.walls.map((wall) => wall.id))
  for (const id of patch.walls?.remove ?? []) existingWalls.delete(id)
  for (const wall of patch.walls?.upsert ?? []) existingWalls.add(wall.id)
  for (const opening of patch.openings?.upsert ?? []) {
    if (!existingWalls.has(opening.wallId))
      throw new Error(`Opening ${opening.id} references missing wall ${opening.wallId}.`)
  }
}

export function validateStyles(styles: RoomStyle[], project: ProjectDocumentV1) {
  if (!styles.length) throw new Error('At least one room style is required.')
  if (styles.length > 25) throw new Error('A style call may update at most 25 rooms.')
  const ids = styles.map((style) => style.roomId)
  if (new Set(ids).size !== ids.length) throw new Error('Room styles cannot contain duplicate room IDs.')
  const rooms = new Set(project.floor.roomMarkers.map((room) => room.id))
  for (const style of styles) {
    if (!ID_PATTERN.test(style.roomId) || !rooms.has(style.roomId))
      throw new Error(`Room style references missing room ${style.roomId}.`)
    if (style.palette.some((color) => !COLOR_PATTERN.test(color)))
      throw new Error(`Room ${style.roomId} has an invalid palette value.`)
  }
}

export function operationEntityIds(patch: LayoutPatch) {
  return Object.values(patch).flatMap((group) => [
    ...(group?.upsert?.map((item) => item.id) ?? []),
    ...(group?.remove ?? []),
  ])
}
