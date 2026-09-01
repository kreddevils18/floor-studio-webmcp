import { lazy, Suspense, useMemo } from 'react'
import { geometry } from '../../core/geometry-engine'
import type { ChangeSet, ProjectDocumentV1 } from '../../domain/model'
import { TechnicalPlan2D } from './technical-plan-2d'

const SpatialScene = lazy(() => import('./spatial-scene'))

interface Props {
  approved: ProjectDocumentV1
  staged: ProjectDocumentV1
  draft: ChangeSet | null
  selectedIds: string[]
  mode: '2d' | '3d'
}

export function SpatialView(props: Props) {
  const webgl = useMemo(() => {
    try {
      const canvas = document.createElement('canvas')
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
    } catch {
      return false
    }
  }, [])
  const draftIds = useMemo(
    () =>
      props.draft?.operations.flatMap((operation) =>
        operation.kind === 'style'
          ? operation.styles.map((style) => style.roomId)
          : Object.values(operation.patch).flatMap((group) => [
              ...(group?.upsert?.map((item) => item.id) ?? []),
              ...(group?.remove ?? []),
            ]),
      ) ?? [],
    [props.draft],
  )
  const rooms = geometry.deriveRooms(props.staged.floor)
  return (
    <section
      className={`spatial-view ${props.mode === '2d' ? 'plan-view' : 'isometric-view'}`}
      data-capture-target={props.mode === '2d' ? 'plan-2d' : 'scene-3d'}
      aria-label="Metric spatial plan"
    >
      {props.mode === '2d' ? (
        <TechnicalPlan2D approved={props.approved} project={props.staged} hasDraft={Boolean(props.draft)} />
      ) : webgl ? (
        <Suspense fallback={<output className="scene-skeleton">Loading spatial scene…</output>}>
          <SpatialScene {...props} mode="3d" draftIds={draftIds} />
        </Suspense>
      ) : (
        <SvgFallback project={props.staged} rooms={rooms} draftIds={draftIds} />
      )}
      <div className="spatial-semantic sr-only">
        {rooms.map((room) => (
          <span key={room.id}>
            {room.name}, {room.areaSquareMetres.toFixed(1)} square metres.
          </span>
        ))}
      </div>
    </section>
  )
}

function SvgFallback({
  project,
  rooms,
  draftIds,
}: {
  project: ProjectDocumentV1
  rooms: ReturnType<typeof geometry.deriveRooms>
  draftIds: string[]
}) {
  const points = project.floor.walls.flatMap((wall) => [wall.start, wall.end])
  const minX = Math.min(...points.map((point) => point.x)) - 500
  const minY = Math.min(...points.map((point) => point.y)) - 500
  const maxX = Math.max(...points.map((point) => point.x)) + 500
  const maxY = Math.max(...points.map((point) => point.y)) + 500
  return (
    <svg
      className="spatial-fallback"
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      role="img"
      aria-label={`${project.name} accessible floor plan`}
    >
      {rooms.map((room) => (
        <polygon
          key={room.id}
          points={room.polygon.map((point) => `${point.x},${point.y}`).join(' ')}
          className={draftIds.includes(room.id) ? 'draft-room' : ''}
        />
      ))}
      {project.floor.walls.map((wall) => (
        <line
          key={wall.id}
          x1={wall.start.x}
          y1={wall.start.y}
          x2={wall.end.x}
          y2={wall.end.y}
          strokeWidth={wall.thicknessMm}
          className={draftIds.includes(wall.id) ? 'draft-wall' : ''}
        />
      ))}
      {project.floor.roomMarkers.map((room) => (
        <text key={room.id} x={room.position.x} y={room.position.y}>
          {room.name}
        </text>
      ))}
    </svg>
  )
}
