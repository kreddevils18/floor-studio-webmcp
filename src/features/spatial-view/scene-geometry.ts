import type { Floor, Opening, PointMm, ProjectDocumentV1, Wall } from '../../domain/model'

export interface PlanBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
  centerX: number
  centerY: number
}
export interface WallBlock {
  id: string
  center: [number, number, number]
  size: [number, number, number]
  rotation: number
}

export function planBounds(project: ProjectDocumentV1): PlanBounds {
  const points = project.floor.walls.flatMap((wall) => [wall.start, wall.end])
  if (!points.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1, width: 2, height: 2, centerX: 0, centerY: 0 }
  const minX = Math.min(...points.map((point) => point.x)) / 1000
  const minY = Math.min(...points.map((point) => point.y)) / 1000
  const maxX = Math.max(...points.map((point) => point.x)) / 1000
  const maxY = Math.max(...points.map((point) => point.y)) / 1000
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  }
}

function pointAt(wall: Wall, distanceMm: number): PointMm {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1
  return {
    x: wall.start.x + ((wall.end.x - wall.start.x) * distanceMm) / length,
    y: wall.start.y + ((wall.end.y - wall.start.y) * distanceMm) / length,
  }
}

function blockFor(wall: Wall, from: number, to: number, bottom: number, top: number, suffix: string): WallBlock | null {
  if (to - from < 1 || top - bottom < 0.01) return null
  const a = pointAt(wall, from)
  const b = pointAt(wall, to)
  return {
    id: `${wall.id}:${suffix}`,
    center: [(a.x + b.x) / 2000, (bottom + top) / 2, (a.y + b.y) / 2000],
    size: [Math.hypot(b.x - a.x, b.y - a.y) / 1000, top - bottom, wall.thicknessMm / 1000],
    rotation: -Math.atan2(b.y - a.y, b.x - a.x),
  }
}

export function wallBlocks(floor: Floor, wall: Wall, ceilingHeightMm = 2800): WallBlock[] {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y)
  const height = ceilingHeightMm / 1000
  const openings = floor.openings
    .filter((opening) => opening.wallId === wall.id)
    .sort((a, b) => a.offsetMm - b.offsetMm)
  const blocks: WallBlock[] = []
  let cursor = 0
  for (const opening of openings) {
    const full = blockFor(wall, cursor, opening.offsetMm, 0, height, `${cursor}-full`)
    if (full) blocks.push(full)
    addOpeningBlocks(blocks, wall, opening, height)
    cursor = opening.offsetMm + opening.widthMm
  }
  const tail = blockFor(wall, cursor, length, 0, height, `${cursor}-full`)
  if (tail) blocks.push(tail)
  return blocks
}

function addOpeningBlocks(blocks: WallBlock[], wall: Wall, opening: Opening, height: number) {
  const from = opening.offsetMm
  const to = opening.offsetMm + opening.widthMm
  if (opening.kind === 'window') {
    const sill = blockFor(wall, from, to, 0, Math.min(0.9, height), `${opening.id}-sill`)
    if (sill) blocks.push(sill)
  }
  const head = opening.kind === 'door' ? 2.1 : 2.0
  const lintel = blockFor(wall, from, to, Math.min(head, height), height, `${opening.id}-lintel`)
  if (lintel) blocks.push(lintel)
}
