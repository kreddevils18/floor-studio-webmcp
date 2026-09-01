import { beforeEach, describe, expect, it, vi } from 'vitest'
import { geometry } from '../src/core/geometry-engine'
import { clearDatabaseForTests, database } from '../src/data/database'
import { PreviewUploadService } from '../src/domain/preview-upload'
import { createSampleProject } from '../src/domain/sample-project'
import { applyOperations, StudioService } from '../src/domain/studio-service'

describe('studio project and revisions', () => {
  beforeEach(async () => {
    await clearDatabaseForTests()
    vi.spyOn(geometry, 'initialize').mockResolvedValue('ready')
    vi.spyOn(geometry, 'validate').mockReturnValue([])
  })

  it('creates every versioned IndexedDB store', async () => {
    const db = await database()
    expect([...db.objectStoreNames]).toEqual(
      expect.arrayContaining([
        'settings',
        'projects',
        'revisions',
        'drafts',
        'timeline',
        'tickets',
        'previews',
        'blobs',
      ]),
    )
    expect([...db.objectStoreNames]).not.toEqual(expect.arrayContaining(['requests', 'activity']))
  })

  it('applies a layout patch without mutating the base document', () => {
    const project = createSampleProject()
    const changed = applyOperations(project, [{ kind: 'layout', patch: { walls: { remove: ['plan_bath_right'] } } }])
    expect(changed.floor.walls).toHaveLength(project.floor.walls.length - 1)
    expect(project.floor.walls.some((wall) => wall.id === 'plan_bath_right')).toBe(true)
  })

  it('rejects stale changes and reserves approval for a presented draft', async () => {
    const service = new StudioService()
    await service.initialize()
    await expect(service.beginChange(service.snapshot.project.revision - 1)).rejects.toThrow('Stale')
    const change = await service.beginChange(service.snapshot.project.revision)
    await service.applyStyle([
      {
        roomId: 'room_living',
        floorMaterial: 'oak',
        wallFinish: 'plaster',
        ceilingHeightMm: 2900,
        palette: ['#aaa'],
        renderStyle: 'editorial',
      },
    ])
    await expect(service.approvePresentedChange()).rejects.toThrow('presented')
    await service.presentChange()
    const approved = await service.approvePresentedChange()
    expect(approved.revision).toBe(4)
    expect(service.snapshot.versions[0].revision).toBe(4)
    expect(service.snapshot.projectState).toBe('saved')
    expect(await service.getChangeStatus(change.id)).toMatchObject({ status: 'saved', resultRevision: 4 })
  })

  it('previews historical versions without writing or leaving a draft on history', async () => {
    const service = new StudioService()
    await service.initialize()
    await service.beginChange(service.snapshot.project.revision)
    await service.applyStyle([
      {
        roomId: 'room_living',
        floorMaterial: 'walnut',
        wallFinish: 'limewash',
        ceilingHeightMm: 2850,
        palette: [],
        renderStyle: 'quiet',
      },
    ])
    await service.presentChange()
    await service.approvePresentedChange()
    const latestRevision = service.snapshot.project.revision
    const historical = service.snapshot.versions.find((version) => version.revision < latestRevision)
    expect(historical).toBeDefined()
    if (!historical) throw new Error('Historical fixture is missing.')
    service.selectRevision(historical.revision)
    expect(service.displayedProject().revision).toBe(historical.revision)
    expect((await database()).get('projects', service.snapshot.project.id)).resolves.toMatchObject({
      revision: latestRevision,
    })
    await service.beginChange(latestRevision)
    expect(service.snapshot.selectedRevision).toBe(latestRevision)
    expect(() => service.selectRevision(historical.revision)).toThrow('active draft')
  })

  it('records durable started and terminal timeline states', async () => {
    const service = new StudioService()
    await service.initialize()
    const started = await service.startTimeline({
      sessionId: 'session_test',
      callId: 'call_test',
      toolName: 'floor.get_context',
      inputSummary: '{}',
    })
    expect(service.snapshot.timeline[0].phase).toBe('started')
    const completed = await service.finishTimeline(started.id, 'succeeded', { outputSummary: '{"revision":3}' })
    expect(completed.phase).toBe('succeeded')
    expect((await database()).get('timeline', started.id)).resolves.toMatchObject({ phase: 'succeeded', sequence: 1 })
  })

  it('exports and imports ProjectDocumentV1 without changing coordinates', async () => {
    const service = new StudioService()
    await service.initialize()
    const originalId = service.snapshot.project.id
    const json = service.exportProject()
    const restored = await service.importProject(json)
    expect(restored.schemaVersion).toBe(1)
    expect(restored.id).not.toBe(originalId)
    expect(restored.revision).toBe(0)
    expect(restored.floor.walls[0].start).toEqual(JSON.parse(json).floor.walls[0].start)
    await expect(service.importProject('{"schemaVersion":2}')).rejects.toThrow('ProjectDocumentV1')
  })

  it('rejects malformed, duplicate, and oversized imports before persistence', async () => {
    const service = new StudioService()
    await service.initialize()
    const activeId = service.snapshot.project.id
    const malformed = JSON.parse(service.exportProject())
    malformed.floor.walls[0].start = null
    await expect(service.importProject(JSON.stringify(malformed))).rejects.toThrow('must be an object')
    const duplicate = JSON.parse(service.exportProject())
    duplicate.floor.openings[0].id = duplicate.floor.walls[0].id
    await expect(service.importProject(JSON.stringify(duplicate))).rejects.toThrow('duplicate entity IDs')
    await expect(service.importProject(' '.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MB')
    await expect((await database()).get('settings', 'activeProjectId')).resolves.toBe(activeId)
  })

  it('restores the active project after creating a second project', async () => {
    const service = new StudioService()
    await service.initialize()
    const created = await service.createProject('Second house')
    const reloaded = new StudioService()
    await reloaded.initialize()
    expect(reloaded.snapshot.project.id).toBe(created.id)
  })

  it('serializes parallel draft creation and rejects a stale second service', async () => {
    const first = new StudioService()
    await first.initialize()
    const revision = first.snapshot.project.revision
    const attempts = await Promise.allSettled([first.beginChange(revision), first.beginChange(revision)])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await first.applyStyle([
      {
        roomId: 'room_living',
        floorMaterial: 'oak',
        wallFinish: 'plaster',
        ceilingHeightMm: 2800,
        palette: [],
        renderStyle: 'calm',
      },
    ])
    await first.presentChange()
    const stale = new StudioService()
    await stale.initialize()
    await first.approvePresentedChange()
    await expect(stale.approvePresentedChange()).rejects.toThrow('stale or superseded')
  })

  it('serializes concurrent revision restores into one atomic next revision', async () => {
    const author = new StudioService()
    await author.initialize()
    await author.beginChange(author.snapshot.project.revision)
    await author.applyStyle([
      {
        roomId: 'room_living',
        floorMaterial: 'oak',
        wallFinish: 'plaster',
        ceilingHeightMm: 2800,
        palette: [],
        renderStyle: 'calm',
      },
    ])
    await author.presentChange()
    await author.approvePresentedChange()
    const first = new StudioService()
    const second = new StudioService()
    await Promise.all([first.initialize(), second.initialize()])
    const attempts = await Promise.allSettled([first.restoreRevision(3), second.restoreRevision(3)])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const db = await database()
    const persisted = await db.get('projects', first.snapshot.project.id)
    const revisionFive = await db.get('revisions', `${first.snapshot.project.id}:5`)
    expect(persisted?.revision).toBe(5)
    expect(revisionFive?.document.revision).toBe(5)
  })

  it('rejects orphan room styles and duplicate IDs before staging', async () => {
    const service = new StudioService()
    await service.initialize()
    await service.beginChange(service.snapshot.project.revision)
    await expect(
      service.applyStyle([
        {
          roomId: 'missing',
          floorMaterial: 'oak',
          wallFinish: 'paint',
          ceilingHeightMm: 2800,
          palette: [],
          renderStyle: 'calm',
        },
      ]),
    ).rejects.toThrow('style references')
    const duplicate = service.snapshot.project.floor.walls[0]
    await expect(service.applyLayout({ walls: { upsert: [duplicate, { ...duplicate }] } })).rejects.toThrow('duplicate')
  })

  it('keeps validation pure and persists only the final presentation snapshot', async () => {
    const service = new StudioService()
    await service.initialize()
    await service.beginChange(service.snapshot.project.revision)
    await service.applyStyle([
      {
        roomId: 'room_living',
        floorMaterial: 'oak',
        wallFinish: 'plaster',
        ceilingHeightMm: 2800,
        palette: ['#aaa'],
        renderStyle: 'calm',
      },
    ])
    vi.mocked(geometry.validate).mockReturnValue([
      { code: 'circulation', severity: 'warning', message: 'Check circulation.' },
    ])
    const issues = await service.validateChange()
    const draftId = service.snapshot.draft?.id
    expect(draftId).toBeDefined()
    expect(issues).toHaveLength(1)
    expect((await database()).get('drafts', draftId ?? '')).resolves.toMatchObject({
      validationResults: [],
    })
    await service.presentChange()
    expect((await database()).get('drafts', draftId ?? '')).resolves.toMatchObject({
      validationResults: issues,
      status: 'presented',
    })
  })

  it('rejects empty, conflicting, and no-op operations', async () => {
    const service = new StudioService()
    await service.initialize()
    await service.beginChange(service.snapshot.project.revision)
    await expect(service.applyLayout({})).rejects.toThrow('at least one mutation')
    const wall = service.snapshot.project.floor.walls[0]
    await expect(service.applyLayout({ walls: { upsert: [wall], remove: [wall.id] } })).rejects.toThrow(
      'both upserted and removed',
    )
    const style = service.snapshot.project.floor.roomStyles.find((item) => item.roomId === 'room_living')
    expect(style).toBeDefined()
    if (!style) throw new Error('Fixture is missing the living-room style.')
    await expect(service.applyStyle([style])).rejects.toThrow('does not modify')
  })

  it('invalidates stale active render jobs when approval advances the revision', async () => {
    const service = new StudioService()
    await service.initialize()
    const upload = new PreviewUploadService(service)
    const stale = await upload.prepare('2d')
    await service.beginChange(service.snapshot.project.revision)
    await service.applyStyle([
      {
        roomId: 'room_living',
        floorMaterial: 'walnut',
        wallFinish: 'limewash',
        ceilingHeightMm: 2850,
        palette: [],
        renderStyle: 'quiet',
      },
    ])
    await service.presentChange()
    await service.approvePresentedChange()
    expect(await service.getTicket(stale.id)).toMatchObject({ status: 'failed' })
    const current = await upload.prepare('3d')
    expect(current.id).not.toBe(stale.id)
    expect(current.sourcePlanRevision).toBe(service.snapshot.project.revision)
  })

  it('single-flights concurrent initialization and migrates approved changes to saved', async () => {
    const service = new StudioService()
    const [first, second] = await Promise.all([service.initialize(), service.initialize()])
    expect(first.project.id).toBe(second.project.id)
    const change = await service.beginChange(service.snapshot.project.revision)
    const db = await database()
    await db.put('drafts', { ...change, status: 'approved' as never })
    const reloaded = new StudioService()
    await reloaded.initialize()
    expect(await reloaded.getChangeStatus(change.id)).toMatchObject({
      status: 'saved',
      resultRevision: change.baseRevision + 1,
    })
    expect(reloaded.snapshot.projectState).toBe('saved')
  })
})
