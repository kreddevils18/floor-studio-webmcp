import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, Check, ChevronDown, Columns2, Download, FileText, Hand, History, Image,
  Maximize2, MessageCircle, MousePointer2, PanelRightClose, PanelRightOpen, Ruler, Send, Sparkles,
  Undo2, Upload, X,
} from 'lucide-react'
import livingPreview from '../assets/generated/living-room-preview.png'
import floorPreview from '../assets/generated/whole-floor-axonometric.png'
import { geometry } from './core/geometry-engine'
import type { PreviewAsset, ProjectDocumentV1, StudioSnapshot } from './domain/model'
import { studio } from './domain/studio-service'
import { PlanViewport } from './components/plan-viewport'
import './styles.css'

const demoPrompts = {
  room: 'Sketch-to-render living-room perspective with warm oak, mineral plaster, courtyard daylight, and preserved circulation.',
  floor: 'Sketch-to-render whole-floor axonometric cutaway with the complete single-storey plan and courtyard.',
}

export default function App() {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null)
  const [composer, setComposer] = useState('Open the living room to the courtyard, use warm oak floors, then regenerate the preview.')
  const [railOpen, setRailOpen] = useState(() => window.innerWidth > 1180); const [compare, setCompare] = useState(false); const [message, setMessage] = useState('')
  const [tool, setTool] = useState<'select' | 'pan' | 'measure' | 'comment'>('select')

  useEffect(() => {
    const unsubscribe = studio.subscribe((value) => setSnapshot({ ...value }))
    void geometry.initialize().then(async () => {
      await studio.initialize()
      await studio.seedBundledPreviews([
        { url: livingPreview, target: { kind: 'room', roomId: 'room_living' }, prompt: demoPrompts.room },
        { url: floorPreview, target: { kind: 'floor' }, prompt: demoPrompts.floor },
      ])
    })
    return unsubscribe
  }, [])

  if (!snapshot) return <div className="loading-screen"><span>FLOOR STUDIO</span><i /></div>
  return <ReadyStudio snapshot={snapshot} composer={composer} setComposer={setComposer} railOpen={railOpen} setRailOpen={setRailOpen} compare={compare} setCompare={setCompare} message={message} setMessage={setMessage} tool={tool} setTool={setTool} />
}

function ReadyStudio({ snapshot, composer, setComposer, railOpen, setRailOpen, compare, setCompare, message, setMessage, tool, setTool }: {
  snapshot: StudioSnapshot; composer: string; setComposer: (value: string) => void; railOpen: boolean; setRailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  compare: boolean; setCompare: React.Dispatch<React.SetStateAction<boolean>>; message: string; setMessage: (value: string) => void;
  tool: 'select' | 'pan' | 'measure' | 'comment'; setTool: (value: 'select' | 'pan' | 'measure' | 'comment') => void;
}) {
  const previewUrls = usePreviewUrls(snapshot.previews)
  const staged = snapshot.draft ? studio.stagedProject() : snapshot.project
  const run = async (action: () => Promise<unknown>) => { try { setMessage(''); await action() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } }
  const queue = () => run(async () => { await studio.queueRequest(composer); setComposer('') })

  return <main className={`studio-shell ${railOpen ? '' : 'rail-closed'}`}>
    <header className="topbar">
      <div className="brand"><strong>FLOOR STUDIO</strong><span>{snapshot.project.name}</span><span>v{snapshot.project.revision}</span><span className="saved"><Check /> Local</span></div>
      <div className="view-switch" role="tablist" aria-label="Studio view">
        <button role="tab" aria-selected={snapshot.activeView === '2d'} onClick={() => studio.setView('2d')}>2D PLAN</button>
        <button role="tab" aria-selected={snapshot.activeView === '3d'} onClick={() => studio.setView('3d')}>3D PREVIEWS</button>
      </div>
      <div className="connection"><span className={hasWebMcp() ? 'online' : 'offline'} /><span>Codex (WebMCP)</span><b>{hasWebMcp() ? 'Connected' : 'Unavailable'}</b><button aria-label="Project menu"><ChevronDown /></button></div>
    </header>

    <nav className="tool-rail" aria-label="Review tools">
      <ToolButton icon={<FileText />} label="Brief" />
      <ToolButton icon={<MousePointer2 />} label="Select / pin" active={tool === 'select'} onClick={() => setTool('select')} />
      <ToolButton icon={<Hand />} label="Pan" active={tool === 'pan'} onClick={() => setTool('pan')} />
      <ToolButton icon={<Ruler />} label="Measure" active={tool === 'measure'} onClick={() => setTool('measure')} />
      <ToolButton icon={<MessageCircle />} label="Comment" active={tool === 'comment'} onClick={() => { setTool('comment'); document.querySelector<HTMLTextAreaElement>('#request')?.focus() }} />
      <ToolButton icon={<History />} label="Versions" onClick={() => document.querySelector<HTMLDialogElement>('#versions-dialog')?.showModal()} />
      <ToolButton icon={<Archive />} label="Assets" />
      <button className="rail-collapse" aria-label="Collapse navigation">«</button>
    </nav>

    <section className="workspace">
      <div className="compatibility" hidden={hasWebMcp()}><strong>Codex tools are not connected.</strong> Continue reviewing locally, then open this site in a native WebMCP-enabled browser to let Codex claim queued work.</div>
      {snapshot.activeView === '2d'
        ? <PlanViewport project={compare ? snapshot.project : staged} selectedIds={snapshot.selectedIds} proposed={!compare && Boolean(snapshot.draft?.operations.length)} mode={tool} onSelect={(ids) => studio.focus(ids)} />
        : <PreviewGallery previews={snapshot.previews} />}
      {snapshot.draft && <div className="review-strip" role="status"><span><Sparkles /> {snapshot.draft.operations.length} change{snapshot.draft.operations.length === 1 ? '' : 's'} ready</span><button onClick={() => setCompare((value) => !value)}><Columns2 /> {compare ? 'Proposed' : 'Compare'}</button><button className="primary" disabled={snapshot.draft.status !== 'presented'} onClick={() => run(() => studio.approvePresentedChange())}><Check /> Approve</button><button onClick={() => run(() => studio.discardChange())}><X /> Discard</button><button onClick={() => run(() => studio.undo())}><Undo2 /> Undo</button></div>}
      <div className="composer">
        <div className="selection-chip"><span />{snapshot.selectedIds.length ? `${snapshot.selectedIds.length} selected` : 'Whole floor'}</div>
        <label htmlFor="request">Local handoff request</label>
        <textarea id="request" value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void queue() }} placeholder="Describe the change Codex should make…" />
        <button className="send" onClick={() => void queue()} disabled={!composer.trim()} aria-label="Queue request"><Send /></button>
        <small>Queues locally · Ask Codex to process pending work</small>
      </div>
      {message && <div className="toast" role="alert">{message}<button aria-label="Dismiss message" onClick={() => setMessage('')}><X /></button></div>}
      <button className="rail-toggle" aria-label={railOpen ? 'Hide activity' : 'Show activity'} onClick={() => setRailOpen((value) => !value)}>{railOpen ? <PanelRightClose /> : <PanelRightOpen />}</button>
    </section>

    <ActivityRail snapshot={snapshot} previewUrls={previewUrls} run={run} />
    <VersionsDialog snapshot={snapshot} run={run} />
    <div className="mobile-review"><strong>Review mode</strong><span>Editing tools are available on a larger screen.</span></div>
  </main>
}

function ToolButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return <button className={active ? 'active' : ''} onClick={onClick} aria-pressed={active}>{icon}<span>{label}</span></button>
}

function ActivityRail({ snapshot, previewUrls, run }: { snapshot: StudioSnapshot; previewUrls: Record<string, string>; run: (action: () => Promise<unknown>) => Promise<void> }) {
  return <aside className="activity-rail">
    <div className="activity-title"><strong>Codex Activity</strong><span><i /> Live</span></div>
    <div className="activity-list">
      {snapshot.requests.filter((request) => request.status !== 'completed').map((request) => <article key={request.id}><div className="event-icon"><Send /></div><div><strong>{request.status === 'pending' ? 'Waiting for Codex' : 'Request claimed'}</strong><time>{formatTime(request.createdAt)}</time><p>{request.text}</p></div></article>)}
      {snapshot.activity.slice(0, 6).map((event) => <article key={event.id}><div className="event-icon"><Check /></div><div><strong>{event.kind}</strong><time>{formatTime(event.createdAt)}</time><p>{event.message}</p></div></article>)}
    </div>
    <div className="preview-card"><span>Latest preview</span><img src={previewUrls[snapshot.previews[0]?.id] ?? (snapshot.previews[0]?.target.kind === 'floor' ? floorPreview : livingPreview)} alt="Latest generated architectural preview" /><div><button onClick={() => studio.setView('3d')}><Maximize2 /> Inspect</button><button className="primary" onClick={() => downloadUrl(previewUrls[snapshot.previews[0]?.id] ?? (snapshot.previews[0]?.target.kind === 'floor' ? floorPreview : livingPreview), 'floor-studio-preview.png')}><Download /> Download</button></div></div>
    <div className="rail-footer"><button onClick={() => run(() => studio.undo())}><Undo2 /> Undo</button><span>{snapshot.versions.length} local versions</span></div>
  </aside>
}

function PreviewGallery({ previews }: { previews: PreviewAsset[] }) {
  const previewUrls = usePreviewUrls(previews)
  const cards = useMemo(() => previews.length ? previews : [], [previews])
  return <div className="preview-gallery"><div className="preview-heading"><div><span>IMAGE GEN OUTPUTS</span><h1>Rendered from the approved plan</h1></div><p>Raster previews are bound to a source revision. They support design review; the metric plan remains the source of truth.</p></div><div className="preview-grid">
    {(cards.length ? cards : [{ id: 'room', target: { kind: 'room' } }, { id: 'floor', target: { kind: 'floor' } }] as unknown as PreviewAsset[]).slice(0, 2).map((asset) => {
      const floor = asset.target.kind === 'floor'; const src = previewUrls[asset.id] ?? (floor ? floorPreview : livingPreview)
      return <figure key={asset.id}><img src={src} data-bundled-source={floor ? floorPreview : livingPreview} alt={floor ? 'Whole-floor axonometric cutaway preview' : 'Living-room perspective preview'} /><figcaption><div><strong>{floor ? 'Whole-floor cutaway' : 'Living room perspective'}</strong><span>Revision {asset.sourcePlanRevision ?? 3} · Image Gen</span></div><button onClick={() => downloadUrl(src, floor ? 'whole-floor-axonometric.png' : 'living-room-preview.png')}><Download /> Download</button></figcaption></figure>
    })}
  </div></div>
}

function usePreviewUrls(previews: PreviewAsset[]) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const cache = useRef<Record<string, string>>({})
  useEffect(() => {
    let active = true
    void Promise.all(previews.filter((asset) => !cache.current[asset.id]).map(async (asset) => {
      const blob = await studio.previewBlob(asset); if (!blob) return null
      return [asset.id, URL.createObjectURL(blob)] as const
    })).then((entries) => {
      if (!active) { entries.forEach((entry) => { if (entry) URL.revokeObjectURL(entry[1]) }); return }
      for (const entry of entries) if (entry) cache.current[entry[0]] = entry[1]
      setUrls({ ...cache.current })
    })
    return () => { active = false }
  }, [previews])
  useEffect(() => () => { Object.values(cache.current).forEach((url) => URL.revokeObjectURL(url)) }, [])
  return urls
}

function VersionsDialog({ snapshot, run }: { snapshot: StudioSnapshot; run: (action: () => Promise<unknown>) => Promise<void> }) {
  return <dialog id="versions-dialog"><header><div><span>LOCAL HISTORY</span><h2>Versions</h2></div><button aria-label="Close versions" onClick={() => document.querySelector<HTMLDialogElement>('#versions-dialog')?.close()}><X /></button></header>{snapshot.versions.map((version) => <div className="version-row" key={version.id}><div><strong>Revision {version.revision}</strong><span>{new Date(version.createdAt).toLocaleString()}</span></div><button disabled={version.revision === snapshot.project.revision} onClick={() => run(() => studio.restoreRevision(version.revision))}>Restore</button></div>)}<footer><label className="import-control"><Upload /> Import JSON<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(async () => { await studio.importProject(await file.text()); document.querySelector<HTMLDialogElement>('#versions-dialog')?.close() }) }} /></label><button onClick={() => downloadText(studio.exportProject(), `${snapshot.project.name.toLowerCase().replaceAll(' ', '-')}.floor.json`)}><Download /> Export JSON</button><button onClick={() => exportSvg(snapshot.project)}><Image /> Export SVG</button><button onClick={() => exportPng(snapshot.project)}><Image /> Export PNG</button></footer></dialog>
}

function formatTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function hasWebMcp() { return 'modelContext' in document && typeof (document as Document & { modelContext?: { registerTool?: unknown } }).modelContext?.registerTool === 'function' }
function downloadText(text: string, name: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); downloadUrl(url, name); URL.revokeObjectURL(url) }
function downloadUrl(url: string, name: string) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click() }
function exportSvg(project: ProjectDocumentV1) {
  const walls = project.floor.walls.map((wall) => `<line x1="${wall.start.x}" y1="${wall.start.y}" x2="${wall.end.x}" y2="${wall.end.y}" stroke="#1b1c19" stroke-width="${wall.thicknessMm}"/>`).join('')
  const labels = project.floor.roomMarkers.map((room) => `<text x="${room.position.x}" y="${room.position.y}" text-anchor="middle" font-family="sans-serif" font-size="180">${room.name.replace(/[<>&]/g, '')}</text>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1000 13800 9600"><rect x="-1000" y="-1000" width="13800" height="9600" fill="#f7f6f2"/>${walls}${labels}</svg>`
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); downloadUrl(url, `${project.name.toLowerCase().replaceAll(' ', '-')}.svg`); URL.revokeObjectURL(url)
}
function exportPng(project: ProjectDocumentV1) {
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1100
  const context = canvas.getContext('2d'); if (!context) return
  context.fillStyle = '#f7f6f2'; context.fillRect(0, 0, canvas.width, canvas.height); const scale = Math.min(1400 / 11800, 900 / 7600); context.translate(100, 100); context.scale(scale, scale)
  context.strokeStyle = '#1b1c19'; context.lineCap = 'square'
  for (const wall of project.floor.walls) { context.lineWidth = wall.thicknessMm; context.beginPath(); context.moveTo(wall.start.x, wall.start.y); context.lineTo(wall.end.x, wall.end.y); context.stroke() }
  context.fillStyle = '#1b1c19'; context.textAlign = 'center'; context.font = '600 150px sans-serif'
  for (const room of project.floor.roomMarkers) context.fillText(room.name, room.position.x, room.position.y)
  canvas.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob); downloadUrl(url, `${project.name.toLowerCase().replaceAll(' ', '-')}.png`); URL.revokeObjectURL(url) }, 'image/png')
}
