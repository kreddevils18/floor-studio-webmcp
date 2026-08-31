import {
  BedDouble,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Info,
  LoaderCircle,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStudio } from './app/use-studio'
import { operationEntityIds } from './domain/change-set'
import type { AgentTimelineEvent, ChangeSet, PreviewAsset, PreviewTicket, RenderMode } from './domain/model'
import { PreviewUploadService } from './domain/preview-upload'
import { studio } from './domain/studio-service'
import { SpatialView } from './features/spatial-view/spatial-view'
import { registrationState } from './webmcp/registration-state'
import { toolByName, toolCatalog } from './webmcp/tool-catalog'
import './styles.css'

const previewUpload = new PreviewUploadService(studio)

const examplePrompt = `Open the living room to the courtyard with a 1.8 m sliding door.
Keep a clear 900 mm circulation path from the entry to the kitchen.
Apply warm oak flooring and mineral plaster.
Validate the plan and present the diff for my approval.`

export default function App() {
  const snapshot = useStudio()
  const health = useSyncExternalStore(
    registrationState.subscribe,
    registrationState.getSnapshot,
    registrationState.getSnapshot,
  )
  const [infoOpen, setInfoOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(() => window.innerWidth > 1120)
  const [message, setMessage] = useState('')
  if (!snapshot)
    return (
      <div className="loading-screen">
        <strong>FLOOR STUDIO</strong>
        <span>Restoring the deterministic metric model…</span>
        <i />
      </div>
    )

  const displayProject = studio.displayedProject()
  const latestSelected = snapshot.selectedRevision === snapshot.project.revision
  const staged = latestSelected ? studio.stagedProject() : displayProject
  const displayedDraft = latestSelected ? snapshot.draft : null
  const currentPreview = snapshot.previews.find(
    (preview) => preview.sourcePlanRevision === snapshot.selectedRevision && preview.renderMode === snapshot.renderMode,
  )
  const activeTicket = snapshot.tickets.find((ticket) => ticket.status === 'queued' || ticket.status === 'rendering')
  const failedTicket = snapshot.tickets.find(
    (ticket) =>
      ticket.sourcePlanRevision === snapshot.selectedRevision &&
      ticket.renderMode === snapshot.renderMode &&
      ticket.status === 'failed',
  )
  const renderStatus = activeTicket?.status ?? (currentPreview ? 'ready' : failedTicket ? 'failed' : 'empty')
  const modeTicket =
    activeTicket?.renderMode === snapshot.renderMode && activeTicket.sourcePlanRevision === snapshot.selectedRevision
      ? activeTicket
      : undefined
  const modeStatus = currentPreview ? 'ready' : (modeTicket?.status ?? (failedTicket ? 'failed' : 'empty'))
  const canRender = latestSelected && !snapshot.draft && !activeTicket

  const run = async (action: () => Promise<unknown>) => {
    try {
      setMessage('')
      await action()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const exportPreview = () =>
    run(async () => {
      if (!currentPreview) {
        studio.setView('render')
        throw new Error('No ready render exists for this version and mode.')
      }
      const blob = await studio.previewBlob(currentPreview)
      if (!blob) throw new Error('The generated image blob is unavailable in local storage.')
      const url = URL.createObjectURL(blob)
      downloadUrl(
        url,
        `${displayProject.name.toLowerCase().replaceAll(' ', '-')}-v${snapshot.selectedRevision}-${snapshot.renderMode}.${currentPreview.mimeType.split('/')[1]}`,
      )
      setTimeout(() => URL.revokeObjectURL(url), 0)
    })

  return (
    <main className={`studio-shell ${timelineOpen ? '' : 'timeline-closed'}`}>
      <Header
        health={health}
        onInfo={() => setInfoOpen(true)}
        onTimeline={() => setTimelineOpen((open) => !open)}
        timelineOpen={timelineOpen}
        previewReady={Boolean(currentPreview)}
        renderStatus={renderStatus}
        activeTicket={activeTicket}
        canRender={canRender}
        onRender={() =>
          run(async () => {
            await previewUpload.prepare(snapshot.renderMode)
            studio.setView('render')
          })
        }
        onExport={exportPreview}
      />

      <section className="workspace">
        {snapshot.activeView === 'render' ? (
          <RenderOutput
            asset={currentPreview}
            revision={snapshot.selectedRevision}
            mode={snapshot.renderMode}
            status={modeStatus}
            ticket={modeTicket}
            onModeChange={(mode) => studio.setRenderMode(mode)}
          />
        ) : (
          <>
            <SpatialView
              approved={displayProject}
              staged={staged}
              draft={displayedDraft}
              selectedIds={snapshot.selectedIds}
              mode={snapshot.activeView}
            />
            {!latestSelected && (
              <div className="history-banner">
                <strong>Viewing v{snapshot.selectedRevision}</strong>
                <span>Read-only history</span>
                <button onClick={() => studio.selectRevision(snapshot.project.revision)}>Return to latest</button>
              </div>
            )}
            <ComponentRail project={staged} />
          </>
        )}
        {message && (
          <div className="toast" role="alert">
            <CircleAlert />
            {message}
            <button aria-label="Dismiss message" onClick={() => setMessage('')}>
              <X />
            </button>
          </div>
        )}
      </section>

      <TimelineRail
        events={snapshot.timeline}
        draft={snapshot.draft}
        projectState={snapshot.projectState}
        onApprove={() => run(() => studio.approvePresentedChange())}
        onReject={() => run(() => studio.rejectPresentedChange())}
      />
      {infoOpen && <InfoDrawer health={health} onClose={() => setInfoOpen(false)} />}
    </main>
  )
}

function Header({
  health,
  onInfo,
  onTimeline,
  timelineOpen,
  previewReady,
  renderStatus,
  activeTicket,
  canRender,
  onRender,
  onExport,
}: {
  health: ReturnType<typeof registrationState.getSnapshot>
  onInfo: () => void
  onTimeline: () => void
  timelineOpen: boolean
  previewReady: boolean
  renderStatus: PreviewTicket['status'] | 'empty'
  activeTicket?: PreviewTicket
  canRender: boolean
  onRender: () => void
  onExport: () => void
}) {
  const snapshot = studio.snapshot
  const state = !health.supported
    ? 'Unsupported'
    : health.failed.length || health.registered !== health.expected
      ? 'Partial'
      : 'Connected'
  const renderLabel =
    renderStatus === 'queued'
      ? `Queued · ${activeTicket?.renderMode.toUpperCase()}`
      : renderStatus === 'rendering'
        ? `Rendering · ${activeTicket?.renderMode.toUpperCase()}`
        : renderStatus === 'ready'
          ? 'Ready'
          : renderStatus === 'failed'
            ? 'Failed'
            : 'Not rendered'

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <HomeMark />
        </span>
        <div>
          <strong>FLOOR STUDIO</strong>
          <small>Agent-native spatial design</small>
        </div>
      </div>

      <label className={`version-select ${snapshot.draft ? 'disabled' : ''}`}>
        <span className="sr-only">Project version</span>
        <select
          value={snapshot.selectedRevision}
          disabled={Boolean(snapshot.draft)}
          onChange={(event) => studio.selectRevision(Number(event.target.value))}
        >
          {snapshot.versions.map((version, index) => (
            <option key={version.id} value={version.revision}>
              {snapshot.project.name} · v{version.revision}
              {index === 0 ? ' · Latest' : ''}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" />
        <i className={`project-state state-${snapshot.projectState}`}>{snapshot.projectState}</i>
      </label>

      <div className="view-switch" role="tablist" aria-label="Studio view">
        {(['2d', '3d', 'render'] as const).map((view) => (
          <button
            key={view}
            role="tab"
            aria-selected={snapshot.activeView === view}
            onClick={() => studio.setView(view)}
          >
            {view}
          </button>
        ))}
      </div>

      <div className={`connection ${state.toLowerCase()}`}>
        <i />
        <div>
          <strong>WEBMCP</strong>
          <span>{state === 'Unsupported' ? 'Unavailable' : `${health.registered}/${health.expected} · ${state}`}</span>
        </div>
      </div>
      <button className="icon-button" onClick={onInfo} aria-label="How to use Floor Studio">
        <Info />
      </button>
      <output className={`render-state render-${renderStatus}`} aria-live="polite">
        {(renderStatus === 'queued' || renderStatus === 'rendering') && <LoaderCircle />}
        {renderLabel}
      </output>
      <button className="render-button" onClick={onRender} disabled={!canRender}>
        Render
      </button>
      <button
        className={`export-button ${previewReady ? 'ready' : 'waiting'}`}
        onClick={onExport}
        aria-label="Export current rendered image"
      >
        Export <Download />
      </button>
      <button
        className="timeline-toggle icon-button"
        onClick={onTimeline}
        aria-label={timelineOpen ? 'Hide Codex timeline' : 'Show Codex timeline'}
      >
        {timelineOpen ? <PanelRightClose /> : <PanelRightOpen />}
      </button>
    </header>
  )
}

function ComponentRail({ project }: { project: ReturnType<typeof studio.displayedProject> }) {
  const items = [
    { label: 'Round Table', aliases: ['coffee', 'round table'] },
    { label: 'Dining Table', aliases: ['dining'] },
    { label: 'Sofa', aliases: ['sofa'] },
    { label: 'Armchair', aliases: ['chair', 'armchair'] },
    { label: 'Bed', aliases: ['bed'] },
    { label: 'Wardrobe', aliases: ['wardrobe', 'closet'] },
    { label: 'Kitchen Island', aliases: ['island', 'kitchen'] },
    { label: 'Plant', aliases: ['plant'] },
  ]
  return (
    <nav className="component-rail" aria-label="2D component library">
      {items.map((item) => {
        const ids = project.floor.furniture
          .filter((entity) => item.aliases.some((alias) => entity.kind.toLowerCase().includes(alias)))
          .map((entity) => entity.id)
        return (
          <button
            key={item.label}
            aria-pressed={ids.length > 0 && ids.every((id) => studio.snapshot.selectedIds.includes(id))}
            onClick={() => studio.focus(ids, studio.snapshot.activeView === '2d' ? '2d' : '3d')}
          >
            <ComponentSymbol label={item.label} />
            <span>{item.label}</span>
            <small>{ids.length || '—'}</small>
          </button>
        )
      })}
    </nav>
  )
}

function ComponentSymbol({ label }: { label: string }) {
  if (label === 'Round Table')
    return (
      <svg viewBox="0 0 64 48" aria-hidden="true">
        <circle cx="32" cy="24" r="15" />
      </svg>
    )
  if (label === 'Dining Table')
    return (
      <svg viewBox="0 0 64 48" aria-hidden="true">
        <rect x="17" y="10" width="30" height="28" rx="2" />
        <path d="M12 15h5M12 24h5M12 33h5M47 15h5M47 24h5M47 33h5" />
      </svg>
    )
  if (label === 'Bed') return <BedDouble aria-hidden="true" />
  if (label === 'Plant')
    return (
      <svg viewBox="0 0 64 48" aria-hidden="true">
        <circle cx="32" cy="24" r="4" />
        <path d="M32 20V6M32 28v14M28 21 18 11M36 21l10-10M28 27 17 36M36 27l17 9" />
      </svg>
    )
  return (
    <svg viewBox="0 0 64 48" aria-hidden="true">
      <rect x="12" y="10" width="40" height="28" rx="4" />
      {label === 'Sofa' && <path d="M20 10v28M44 10v28" />}
      {label === 'Wardrobe' && <path d="M32 10v28M28 24h1M35 24h1" />}
      {label === 'Kitchen Island' && (
        <>
          <circle cx="24" cy="24" r="3" />
          <circle cx="40" cy="24" r="3" />
        </>
      )}
    </svg>
  )
}

function RenderOutput({
  asset,
  revision,
  mode,
  status,
  ticket,
  onModeChange,
}: {
  asset?: PreviewAsset
  revision: number
  mode: RenderMode
  status: PreviewTicket['status'] | 'empty'
  ticket?: PreviewTicket
  onModeChange: (mode: RenderMode) => void
}) {
  const assets = useMemo(() => (asset ? [asset] : []), [asset])
  const urls = usePreviewUrls(assets)
  return (
    <section className="render-output" aria-label="Rendered image output">
      <header>
        <div>
          <span>RENDER PREVIEW</span>
          <h1>{mode === '2d' ? 'Top-down floor render' : 'Isometric floor render'}</h1>
        </div>
        <fieldset className="render-mode-switch">
          <legend className="sr-only">Render mode</legend>
          {(['2d', '3d'] as const).map((item) => (
            <button key={item} aria-pressed={mode === item} onClick={() => onModeChange(item)}>
              {item.toUpperCase()}
            </button>
          ))}
        </fieldset>
      </header>
      <div className={`render-frame state-${status}`}>
        {asset && urls[asset.id] ? (
          <img src={urls[asset.id]} alt={`${mode.toUpperCase()} whole-floor architectural render`} />
        ) : (
          <div className="render-placeholder">
            {(status === 'queued' || status === 'rendering') && <LoaderCircle />}
            <strong>
              {status === 'queued'
                ? 'Queued for Codex'
                : status === 'rendering'
                  ? 'Generating image…'
                  : status === 'failed'
                    ? 'Render failed'
                    : 'No render yet'}
            </strong>
            <p>
              {status === 'queued'
                ? 'Codex can now claim this revision-bound job through WebMCP.'
                : status === 'rendering'
                  ? 'Image Gen output will appear here after its verified upload completes.'
                  : 'Choose 2D or 3D, then use Render to create a revision-bound job.'}
            </p>
          </div>
        )}
      </div>
      <footer>
        <div>
          <span>Source</span>
          <strong>{mode === '2d' ? '2D plan' : '3D isometric'}</strong>
        </div>
        <div>
          <span>Revision</span>
          <strong>v{revision}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{status === 'empty' ? 'Not rendered' : status}</strong>
        </div>
        <div>
          <span>Requested</span>
          <strong>{ticket ? new Date(ticket.createdAt).toLocaleTimeString() : '—'}</strong>
        </div>
        {asset && (
          <div className="render-checksum">
            <span>SHA-256</span>
            <strong>{asset.checksum.slice(0, 12)}…</strong>
          </div>
        )}
      </footer>
    </section>
  )
}

function TimelineRail({
  events,
  draft,
  projectState,
  onApprove,
  onReject,
}: {
  events: AgentTimelineEvent[]
  draft: ChangeSet | null
  projectState: 'draft' | 'saved'
  onApprove: () => void
  onReject: () => void
}) {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  return (
    <aside className="timeline-rail" aria-label="Codex timeline">
      <div className="timeline-title">
        <strong>CODEX TIMELINE</strong>
        <span className={`timeline-state state-${projectState}`}>
          <i /> {projectState}
        </span>
      </div>
      <div className="timeline-list">
        {ordered.length ? (
          ordered.map((event) => <TimelineItem key={event.id} event={event} />)
        ) : (
          <div className="timeline-empty">
            <Menu />
            <strong>Waiting for tool calls</strong>
            <p>Open this app with Codex, then use the information button for the exact workflow.</p>
          </div>
        )}
      </div>
      {draft?.status === 'presented' && (
        <section className="checkpoint" aria-label="Human approval checkpoint">
          <span>HUMAN CHECKPOINT</span>
          <h2>
            Review {draft.operations.length} proposed change{draft.operations.length === 1 ? '' : 's'}
          </h2>
          <p>
            {draft.validationResults.length
              ? `${draft.validationResults.length} validation note${draft.validationResults.length === 1 ? '' : 's'}`
              : 'Geometry validation passed'}{' '}
            · Base revision {draft.baseRevision}
          </p>
          <AffectedEntities draft={draft} />
          <small>The agent may present this draft, but only you can save it.</small>
          <div>
            <button onClick={onReject}>Reject</button>
            <button className="primary" onClick={onApprove}>
              Approve
            </button>
          </div>
        </section>
      )}
    </aside>
  )
}

function TimelineItem({ event }: { event: AgentTimelineEvent }) {
  const tool = toolByName.get(event.toolName)
  return (
    <article className={`timeline-item phase-${event.phase}`}>
      <div className="event-marker">
        {event.phase === 'succeeded' ? <Check /> : event.phase === 'failed' ? <X /> : <i />}
      </div>
      <div>
        <strong>{tool?.label ?? event.toolName}</strong>
        <span className="tool-name">{event.toolName}</span>
        <p>{event.outputSummary ?? event.inputSummary ?? 'Execution started.'}</p>
        <small>
          #{event.sequence}
          {event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ''}
          {event.baseRevision !== undefined ? ` · base v${event.baseRevision}` : ''}
          {event.errorCode ? ` · ${event.errorCode}` : ''}
        </small>
      </div>
    </article>
  )
}

function AffectedEntities({ draft }: { draft: ChangeSet }) {
  const ids = useMemo(
    () => [
      ...new Set(
        draft.operations.flatMap((operation) =>
          operation.kind === 'style'
            ? operation.styles.map((style) => style.roomId)
            : operationEntityIds(operation.patch),
        ),
      ),
    ],
    [draft],
  )
  return ids.length ? (
    <p className="affected">
      Affected: {ids.slice(0, 4).join(', ')}
      {ids.length > 4 ? ` +${ids.length - 4}` : ''}
    </p>
  ) : null
}

function InfoDrawer({
  health,
  onClose,
}: {
  health: ReturnType<typeof registrationState.getSnapshot>
  onClose: () => void
}) {
  const tools = health.tools.length ? health.tools : toolCatalog.map(({ name, description }) => ({ name, description }))
  return (
    <div className="drawer-backdrop">
      <aside className="info-drawer" aria-label="How to use Floor Studio">
        <header>
          <div>
            <span>AGENT WORKFLOW</span>
            <h2>Design through Codex</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close information">
            <X />
          </button>
        </header>
        <section>
          <p>
            Describe the home change in Codex. Codex reads the metric project, stages WebMCP mutations, validates them,
            and presents a structured draft. You approve or reject locally. Use Render to queue a revision-bound 2D or
            3D Image Gen job for Codex.
          </p>
          <h3>Example prompt</h3>
          <pre>{examplePrompt}</pre>
        </section>
        <section>
          <div className="health-row">
            <h3>Registration health</h3>
            <strong>{health.supported ? `${health.registered}/${health.expected}` : 'Unsupported'}</strong>
          </div>
          {health.failed.length > 0 && <p className="registration-error">Failed: {health.failed.join(', ')}</p>}
          <div className="tool-inventory">
            {tools.map((registered) => {
              const catalog = toolByName.get(registered.name)
              return (
                <article key={registered.name}>
                  <div>
                    <strong>{registered.name}</strong>
                    <span>{catalog?.annotations.readOnlyHint ? 'Read-only' : 'Mutating'}</span>
                  </div>
                  <p>{registered.description ?? catalog?.description ?? 'Registered browser tool'}</p>
                </article>
              )
            })}
          </div>
        </section>
      </aside>
    </div>
  )
}

function HomeMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 11.2 12 4l8 7.2V20H4Z" />
    </svg>
  )
}

function usePreviewUrls(previews: PreviewAsset[]) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const cache = useRef<Record<string, string>>({})
  useEffect(() => {
    let active = true
    void Promise.all(
      previews
        .filter((asset) => !cache.current[asset.id])
        .map(async (asset) => {
          const blob = await studio.previewBlob(asset)
          return blob ? ([asset.id, URL.createObjectURL(blob)] as const) : null
        }),
    ).then((entries) => {
      if (!active) return
      for (const entry of entries) if (entry) cache.current[entry[0]] = entry[1]
      setUrls({ ...cache.current })
    })
    return () => {
      active = false
    }
  }, [previews])
  useEffect(() => () => Object.values(cache.current).forEach(URL.revokeObjectURL), [])
  return urls
}

function downloadUrl(url: string, name: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
}
