import type { FurnitureSymbol, Opening, PointMm, ProjectDocumentV1, Wall } from '../../domain/model'

interface Props {
  approved: ProjectDocumentV1
  project: ProjectDocumentV1
  hasDraft: boolean
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
const plantAngles = [0, 45, 90, 135, 180, 225, 270, 315]

function boundsOf(project: ProjectDocumentV1): Bounds {
  const points = project.floor.walls.flatMap((wall) => [wall.start, wall.end])
  if (!points.length) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000 }
  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

function pointAt(wall: Wall, distance: number): PointMm {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1
  return {
    x: wall.start.x + ((wall.end.x - wall.start.x) * distance) / length,
    y: wall.start.y + ((wall.end.y - wall.start.y) * distance) / length,
  }
}

function openingGeometry(wall: Wall, opening: Opening) {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) || 1
  const tangent = { x: (wall.end.x - wall.start.x) / length, y: (wall.end.y - wall.start.y) / length }
  const normal = { x: -tangent.y, y: tangent.x }
  return {
    start: pointAt(wall, opening.offsetMm),
    end: pointAt(wall, opening.offsetMm + opening.widthMm),
    tangent,
    normal,
  }
}

function metricLabel(millimetres: number) {
  return `${(millimetres / 1000).toFixed(2)} m`
}

function displayMarker(room: ProjectDocumentV1['floor']['roomMarkers'][number]) {
  if (room.name === 'DINING' || room.name === 'KITCHEN') return null
  if (room.name === 'BEDROOM') return { ...room.position, y: 4650 }
  return room.position
}

export function TechnicalPlan2D({ approved, project, hasDraft }: Props) {
  const bounds = boundsOf(project)
  const margin = Math.max(1250, Math.min(bounds.width, bounds.height) * 0.16)
  const viewBox = `${bounds.minX - margin} ${bounds.minY - margin} ${bounds.width + margin * 2} ${bounds.height + margin * 2}`
  const xBreaks = [...new Set(project.floor.walls.flatMap((wall) => [wall.start.x, wall.end.x]))]
    .filter((value) => value >= bounds.minX && value <= bounds.maxX)
    .sort((a, b) => a - b)
  const yBreaks = [...new Set(project.floor.walls.flatMap((wall) => [wall.start.y, wall.end.y]))]
    .filter((value) => value >= bounds.minY && value <= bounds.maxY)
    .sort((a, b) => a - b)

  return (
    <svg
      className="technical-plan"
      viewBox={viewBox}
      role="img"
      aria-label={`${project.name} two-dimensional floor plan`}
    >
      <title>{project.name} — technical two-dimensional floor plan</title>
      <defs>
        <marker
          id="dimension-arrow"
          viewBox="0 0 10 10"
          refX="5"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 1 5 L 9 1 L 9 9 Z" />
        </marker>
        <pattern
          id="balcony-hatch"
          width="160"
          height="160"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="160" className="hatch-line" />
        </pattern>
      </defs>

      <rect
        className="plan-paper"
        x={bounds.minX - margin}
        y={bounds.minY - margin}
        width={bounds.width + margin * 2}
        height={bounds.height + margin * 2}
      />
      <rect
        className="balcony-zone"
        x={bounds.minX}
        y={bounds.minY}
        width={Math.min(2100, bounds.width)}
        height={bounds.height}
      />

      <DimensionLine
        x1={bounds.minX}
        y1={bounds.minY - 880}
        x2={bounds.maxX}
        y2={bounds.minY - 880}
        label={metricLabel(bounds.width)}
      />
      <DimensionLine
        x1={bounds.minX - 880}
        y1={bounds.minY}
        x2={bounds.minX - 880}
        y2={bounds.maxY}
        label={metricLabel(bounds.height)}
        vertical
      />
      {xBreaks.slice(0, -1).map((value, index) => {
        const next = xBreaks[index + 1]
        if (next - value < 700) return null
        return (
          <DimensionLine
            key={`x-${value}`}
            x1={value}
            y1={bounds.minY - 430}
            x2={next}
            y2={bounds.minY - 430}
            label={metricLabel(next - value)}
            compact
          />
        )
      })}
      {yBreaks.slice(0, -1).map((value, index) => {
        const next = yBreaks[index + 1]
        if (next - value < 700) return null
        return (
          <DimensionLine
            key={`y-${value}`}
            x1={bounds.maxX + 430}
            y1={value}
            x2={bounds.maxX + 430}
            y2={next}
            label={metricLabel(next - value)}
            vertical
            compact
          />
        )
      })}

      {hasDraft && <WallLayer project={approved} className="approved-underlay" />}
      <WallLayer project={project} className="current-walls" />
      <OpeningLayer project={project} />
      <g className="furniture-layer">
        {project.floor.furniture.map((item) => (
          <Furniture key={item.id} item={item} />
        ))}
      </g>
      <g className="room-labels">
        {project.floor.roomMarkers.map((room) => {
          const position = displayMarker(room)
          return position ? (
            <text key={room.id} x={position.x} y={position.y}>
              {room.name}
            </text>
          ) : null
        })}
      </g>
      {hasDraft && (
        <g className="draft-stamp" transform={`translate(${bounds.maxX - 1540} ${bounds.maxY - 300})`}>
          <rect width="1450" height="390" rx="80" />
          <text x="725" y="250">
            CODEX DRAFT · REVIEW REQUIRED
          </text>
        </g>
      )}
    </svg>
  )
}

function DimensionLine({
  x1,
  y1,
  x2,
  y2,
  label,
  vertical = false,
  compact = false,
}: {
  x1: number
  y1: number
  x2: number
  y2: number
  label: string
  vertical?: boolean
  compact?: boolean
}) {
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  return (
    <g className={`dimension ${compact ? 'compact' : ''}`}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} markerStart="url(#dimension-arrow)" markerEnd="url(#dimension-arrow)" />
      <text x={cx} y={cy - (vertical ? 0 : 90)} transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}>
        {label}
      </text>
    </g>
  )
}

function WallLayer({ project, className }: { project: ProjectDocumentV1; className: string }) {
  return (
    <g className={className}>
      {project.floor.walls.map((wall) => (
        <line
          key={wall.id}
          x1={wall.start.x}
          y1={wall.start.y}
          x2={wall.end.x}
          y2={wall.end.y}
          strokeWidth={wall.thicknessMm}
        />
      ))}
    </g>
  )
}

function OpeningLayer({ project }: { project: ProjectDocumentV1 }) {
  const wallById = new Map(project.floor.walls.map((wall) => [wall.id, wall]))
  return (
    <g className="opening-layer">
      {project.floor.openings.map((opening) => {
        const wall = wallById.get(opening.wallId)
        if (!wall) return null
        const geometry = openingGeometry(wall, opening)
        const offset = wall.thicknessMm * 0.32
        return (
          <g key={opening.id}>
            <line
              className="opening-cut"
              x1={geometry.start.x}
              y1={geometry.start.y}
              x2={geometry.end.x}
              y2={geometry.end.y}
              strokeWidth={wall.thicknessMm + 70}
            />
            {opening.kind === 'window' ? (
              <>
                <line
                  className="window-line"
                  x1={geometry.start.x + geometry.normal.x * offset}
                  y1={geometry.start.y + geometry.normal.y * offset}
                  x2={geometry.end.x + geometry.normal.x * offset}
                  y2={geometry.end.y + geometry.normal.y * offset}
                />
                <line
                  className="window-line"
                  x1={geometry.start.x - geometry.normal.x * offset}
                  y1={geometry.start.y - geometry.normal.y * offset}
                  x2={geometry.end.x - geometry.normal.x * offset}
                  y2={geometry.end.y - geometry.normal.y * offset}
                />
              </>
            ) : opening.swing === 'sliding' ? (
              <SlidingDoor geometry={geometry} width={opening.widthMm} />
            ) : (
              <SwingDoor geometry={geometry} width={opening.widthMm} reverse={opening.swing === 'right'} />
            )}
          </g>
        )
      })}
    </g>
  )
}

function SlidingDoor({ geometry, width }: { geometry: ReturnType<typeof openingGeometry>; width: number }) {
  const inset = 55
  const mid = width * 0.5
  const half = (startAt: number, normalSign: number) => ({
    x1: geometry.start.x + geometry.tangent.x * startAt + geometry.normal.x * inset * normalSign,
    y1: geometry.start.y + geometry.tangent.y * startAt + geometry.normal.y * inset * normalSign,
    x2: geometry.start.x + geometry.tangent.x * (startAt + mid) + geometry.normal.x * inset * normalSign,
    y2: geometry.start.y + geometry.tangent.y * (startAt + mid) + geometry.normal.y * inset * normalSign,
  })
  return (
    <>
      <line className="door-leaf" {...half(0, -1)} />
      <line className="door-leaf" {...half(mid, 1)} />
    </>
  )
}

function SwingDoor({
  geometry,
  width,
  reverse,
}: {
  geometry: ReturnType<typeof openingGeometry>
  width: number
  reverse: boolean
}) {
  const direction = reverse ? -1 : 1
  const leafEnd = {
    x: geometry.start.x + geometry.normal.x * width * direction,
    y: geometry.start.y + geometry.normal.y * width * direction,
  }
  const sweepEnd = geometry.end
  return (
    <>
      <line className="door-leaf" x1={geometry.start.x} y1={geometry.start.y} x2={leafEnd.x} y2={leafEnd.y} />
      <path
        className="door-swing"
        d={`M ${leafEnd.x} ${leafEnd.y} Q ${geometry.start.x + (geometry.tangent.x + geometry.normal.x * direction) * width} ${geometry.start.y + (geometry.tangent.y + geometry.normal.y * direction) * width} ${sweepEnd.x} ${sweepEnd.y}`}
      />
    </>
  )
}

function Furniture({ item }: { item: FurnitureSymbol }) {
  const width = item.widthMm
  const depth = item.depthMm
  const transform = `translate(${item.position.x} ${item.position.y}) rotate(${item.rotationDegrees})`
  const frame = <rect x={-width / 2} y={-depth / 2} width={width} height={depth} rx={Math.min(90, depth * 0.12)} />
  const kind = item.kind.toLowerCase()
  return (
    <g className={`furniture furniture-${kind.replaceAll(' ', '-')}`} transform={transform}>
      {kind.includes('bed') ? (
        <>
          {frame}
          <line x1={-width / 2} y1={-depth * 0.18} x2={width / 2} y2={-depth * 0.18} />
          <rect x={-width * 0.39} y={-depth * 0.42} width={width * 0.34} height={depth * 0.2} rx="55" />
          <rect x={width * 0.05} y={-depth * 0.42} width={width * 0.34} height={depth * 0.2} rx="55" />
        </>
      ) : kind.includes('dining') ? (
        <>
          {frame}
          {[-0.32, 0, 0.32].map((step) => (
            <g key={step}>
              <rect x={width * step - 150} y={-depth / 2 - 260} width="300" height="210" rx="30" />
              <rect x={width * step - 150} y={depth / 2 + 50} width="300" height="210" rx="30" />
            </g>
          ))}
        </>
      ) : kind.includes('sofa') ? (
        <>
          {frame}
          <rect x={-width / 2 + 80} y={-depth / 2 + 70} width={width - 160} height={depth * 0.24} rx="45" />
          <line x1={-width / 6} y1={-depth * 0.22} x2={-width / 6} y2={depth / 2} />
          <line x1={width / 6} y1={-depth * 0.22} x2={width / 6} y2={depth / 2} />
        </>
      ) : kind.includes('coffee') ? (
        <>
          <circle cx={-width * 0.16} cy="0" r={depth * 0.45} />
          <circle cx={width * 0.24} cy="40" r={depth * 0.37} />
        </>
      ) : kind.includes('plant') ? (
        <>
          <circle r={Math.min(width, depth) * 0.42} />
          {plantAngles.map((angle) => (
            <ellipse
              key={angle}
              cx="0"
              cy={-depth * 0.25}
              rx={width * 0.1}
              ry={depth * 0.3}
              transform={`rotate(${angle})`}
            />
          ))}
        </>
      ) : kind.includes('round-table') ? (
        <>
          <circle r={Math.min(width, depth) * 0.42} />
          <rect x={-180} y={-depth * 0.78} width="360" height="220" rx="35" />
          <rect x={-180} y={depth * 0.5} width="360" height="220" rx="35" />
        </>
      ) : kind.includes('bath') ? (
        <>
          {frame}
          <rect x={-width * 0.38} y={-depth * 0.34} width={width * 0.76} height={depth * 0.68} rx={depth * 0.3} />
        </>
      ) : kind.includes('island') ? (
        <>
          {frame}
          <circle cx={-width * 0.22} cy="0" r={depth * 0.18} />
          <circle cx={width * 0.12} cy="0" r={depth * 0.12} />
          <circle cx={width * 0.3} cy="0" r={depth * 0.12} />
        </>
      ) : (
        <>
          {frame}
          <line x1={-width / 2} y1="0" x2={width / 2} y2="0" />
        </>
      )}
    </g>
  )
}
