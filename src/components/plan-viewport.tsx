import { useEffect, useMemo, useRef, useState } from 'react'
import { Focus, Hand, Minus, Plus } from 'lucide-react'
import { geometry } from '../core/geometry-engine'
import type { ProjectDocumentV1 } from '../domain/model'
import { type Camera, WebGpuPlanRenderer } from '../render/webgpu-plan'

interface Props { project: ProjectDocumentV1; selectedIds: string[]; proposed: boolean; mode: 'select' | 'pan' | 'measure' | 'comment'; onSelect: (ids: string[]) => void }

export function PlanViewport({ project, selectedIds, proposed, mode, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null); const shellRef = useRef<HTMLDivElement>(null); const rendererRef = useRef(new WebGpuPlanRenderer())
  const [camera, setCamera] = useState<Camera>({ zoom: 0.066, offsetX: 90, offsetY: 54 }); const [size, setSize] = useState({ width: 1000, height: 700 })
  const [measure, setMeasure] = useState<{ start: { x: number; y: number }; end?: { x: number; y: number } } | null>(null)
  const dragRef = useRef<{ x: number; y: number; camera: Camera } | null>(null)
  const [gpuStatus, setGpuStatus] = useState<'loading' | 'ready' | 'unsupported'>('loading')
  const rooms = useMemo(() => geometry.status === 'ready' ? geometry.deriveRooms(project.floor) : [], [project])

  useEffect(() => {
    const element = shellRef.current; if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: entry.contentRect.width, height: entry.contentRect.height }; setSize(next)
      const zoom = Math.min((next.width - 150) / 11800, (next.height - 180) / 7600)
      setCamera({ zoom, offsetX: (next.width - 11800 * zoom) / 2, offsetY: (next.height - 7600 * zoom) / 2 - 12 })
    })
    observer.observe(element); return () => observer.disconnect()
  }, [])
  useEffect(() => { if (canvasRef.current) void rendererRef.current.initialize(canvasRef.current, () => setGpuStatus('unsupported')).then(setGpuStatus) }, [])
  useEffect(() => { if (canvasRef.current && gpuStatus === 'ready') rendererRef.current.render(canvasRef.current, project.floor, camera, selectedIds, proposed) }, [project, camera, selectedIds, proposed, gpuStatus, size])

  const fit = () => setCamera({ zoom: Math.min((size.width - 180) / 11800, (size.height - 140) / 7600), offsetX: 90, offsetY: 70 })
  const pointFor = (event: React.PointerEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect(); const point = { x: Math.round((event.clientX - bounds.left - camera.offsetX) / camera.zoom), y: Math.round((event.clientY - bounds.top - camera.offsetY) / camera.zoom) }
    return point
  }
  const pick = (event: React.PointerEvent) => {
    if (mode === 'pan') { dragRef.current = { x: event.clientX, y: event.clientY, camera }; event.currentTarget.setPointerCapture(event.pointerId); return }
    const point = pointFor(event)
    if (mode === 'measure') { setMeasure((value) => !value || value.end ? { start: point } : { ...value, end: point }); return }
    const room = rooms.find((entry) => pointInPolygon(point, entry.polygon)); const wall = geometry.hitTestWall(project.floor, point, 180)
    onSelect(room ? [room.id] : wall ? [wall] : [])
  }
  const move = (event: React.PointerEvent) => { const drag = dragRef.current; if (!drag) return; setCamera({ ...drag.camera, offsetX: drag.camera.offsetX + event.clientX - drag.x, offsetY: drag.camera.offsetY + event.clientY - drag.y }) }
  const release = () => { dragRef.current = null }
  const keyboard = (event: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [24, 0], ArrowRight: [-24, 0], ArrowUp: [0, 24], ArrowDown: [0, -24] }
    if (moves[event.key]) { event.preventDefault(); const [x, y] = moves[event.key]; setCamera((value) => ({ ...value, offsetX: value.offsetX + x, offsetY: value.offsetY + y })) }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); setCamera((value) => ({ ...value, zoom: value.zoom * 1.12 })) }
    if (event.key === '-') { event.preventDefault(); setCamera((value) => ({ ...value, zoom: value.zoom / 1.12 })) }
    if (event.key === 'Escape') onSelect([])
  }
  const t = `translate(${camera.offsetX} ${camera.offsetY}) scale(${camera.zoom})`
  return <div className={`viewport-shell mode-${mode}`} ref={shellRef} tabIndex={0} role="application" aria-label="Interactive metric floor plan. Use arrow keys to pan, plus or minus to zoom, and Escape to clear selection." onKeyDown={keyboard} onPointerDown={pick} onPointerMove={move} onPointerUp={release} onPointerCancel={release} data-testid="plan-viewport">
    <canvas ref={canvasRef} aria-hidden="true" />
    {gpuStatus === 'unsupported' && <div className="gpu-notice" role="status">WebGPU is unavailable. The synchronized SVG review layer remains active.</div>}
    <svg className="plan-overlay" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={`${project.name} floor plan`}>
      {gpuStatus !== 'ready' && <g transform={t} className="fallback-walls">{project.floor.walls.map((wall) => <line key={wall.id} x1={wall.start.x} y1={wall.start.y} x2={wall.end.x} y2={wall.end.y} strokeWidth={wall.thicknessMm} />)}</g>}
      <g transform={t}>
        {project.floor.openings.map((opening) => {
          const wall = project.floor.walls.find((entry) => entry.id === opening.wallId); if (!wall) return null
          const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y); const unitX = (wall.end.x - wall.start.x) / length; const unitY = (wall.end.y - wall.start.y) / length
          const x1 = wall.start.x + unitX * opening.offsetMm; const y1 = wall.start.y + unitY * opening.offsetMm; const x2 = x1 + unitX * opening.widthMm; const y2 = y1 + unitY * opening.widthMm
          return <g key={opening.id} className={`opening ${opening.kind}`}><line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={wall.thicknessMm + 40} /><line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={34} /></g>
        })}
        {project.floor.furniture.map((item) => <g key={item.id} className="furniture" transform={`translate(${item.position.x} ${item.position.y}) rotate(${item.rotationDegrees})`}>
          <rect x={-item.widthMm / 2} y={-item.depthMm / 2} width={item.widthMm} height={item.depthMm} rx={90} />
          <text y={20}>{item.kind.toUpperCase()}</text>
        </g>)}
        {rooms.map((room) => { const marker = project.floor.roomMarkers.find((entry) => entry.id === room.id); if (!marker) return null
          return <g key={room.id} className={`room-label ${selectedIds.includes(room.id) ? 'selected' : ''}`} transform={`translate(${marker.position.x} ${marker.position.y})`}><text textAnchor="middle" y={-80}>{room.name}</text><text className="area" textAnchor="middle" y={170}>{room.areaSquareMetres.toFixed(1)} m²</text><circle r={selectedIds.includes(room.id) ? 150 : 0} /></g> })}
        {project.floor.dimensions.map((dimension) => <g key={dimension.id} className="dimension"><line x1={dimension.start.x} y1={dimension.start.y} x2={dimension.end.x} y2={dimension.end.y} /><text x={(dimension.start.x + dimension.end.x) / 2} y={(dimension.start.y + dimension.end.y) / 2 - 100} textAnchor="middle">{dimension.label ?? `${Math.round(Math.hypot(dimension.end.x - dimension.start.x, dimension.end.y - dimension.start.y))}`}</text></g>)}
        {project.floor.annotations.map((annotation) => <g key={annotation.id} className="annotation" transform={`translate(${annotation.position.x} ${annotation.position.y})`}><circle r={130} /><text textAnchor="middle" y={45}>!</text></g>)}
        {measure?.end && <g className="dimension active-measure"><line x1={measure.start.x} y1={measure.start.y} x2={measure.end.x} y2={measure.end.y} /><text x={(measure.start.x + measure.end.x) / 2} y={(measure.start.y + measure.end.y) / 2 - 100} textAnchor="middle">{Math.round(Math.hypot(measure.end.x - measure.start.x, measure.end.y - measure.start.y))} mm</text></g>}
      </g>
    </svg>
    <div className="viewport-tools" onPointerDown={(event) => event.stopPropagation()}><button aria-label="Pan"><Hand /></button><button aria-label="Zoom in" onClick={() => setCamera((value) => ({ ...value, zoom: value.zoom * 1.12 }))}><Plus /></button><button aria-label="Zoom out" onClick={() => setCamera((value) => ({ ...value, zoom: value.zoom / 1.12 }))}><Minus /></button><button aria-label="Fit plan" onClick={fit}><Focus /></button></div>
    <div className="scale-bar"><span style={{ width: 3000 * camera.zoom }} /> 0&nbsp;&nbsp;&nbsp;1&nbsp;&nbsp;&nbsp;2&nbsp;&nbsp;&nbsp;3 m</div>
    <div className="sr-only" aria-label="Floor plan objects">{rooms.map((room) => <button key={room.id} onClick={() => onSelect([room.id])}>{room.name}, {room.areaSquareMetres.toFixed(1)} square metres</button>)}{project.floor.walls.map((wall) => <button key={wall.id} onClick={() => onSelect([wall.id])}>Wall {wall.id}</button>)}</div>
  </div>
}

function pointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
