import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabaseForTests, database } from '../src/data/database'
import { geometry } from '../src/core/geometry-engine'
import { applyOperations, StudioService } from '../src/domain/studio-service'
import { createSampleProject } from '../src/domain/sample-project'

describe('studio project and revisions', () => {
  beforeEach(async () => {
    await clearDatabaseForTests()
    vi.spyOn(geometry, 'initialize').mockResolvedValue('ready')
    vi.spyOn(geometry, 'validate').mockReturnValue([])
  })

  it('creates every versioned IndexedDB store', async () => {
    const db = await database()
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['settings', 'projects', 'revisions', 'drafts', 'requests', 'activity', 'tickets', 'previews', 'blobs']))
  })

  it('applies a layout patch without mutating the base document', () => {
    const project = createSampleProject()
    const changed = applyOperations(project, [{ kind: 'layout', patch: { walls: { remove: ['w_left_split'] } } }])
    expect(changed.floor.walls).toHaveLength(project.floor.walls.length - 1)
    expect(project.floor.walls.some((wall) => wall.id === 'w_left_split')).toBe(true)
  })

  it('rejects stale changes and reserves approval for a presented draft', async () => {
    const service = new StudioService(); await service.initialize()
    await expect(service.beginChange(service.snapshot.project.revision - 1)).rejects.toThrow('Stale')
    await service.beginChange(service.snapshot.project.revision)
    await service.applyStyle([{ roomId: 'room_living', floorMaterial: 'oak', wallFinish: 'plaster', ceilingHeightMm: 2900, palette: ['#aaa'], renderStyle: 'editorial' }])
    await expect(service.approvePresentedChange()).rejects.toThrow('presented')
    await service.presentChange(); const approved = await service.approvePresentedChange()
    expect(approved.revision).toBe(4)
    expect(service.snapshot.versions[0].revision).toBe(4)
  })

  it('queues and claims the oldest request with its selection', async () => {
    const service = new StudioService(); await service.initialize(); service.focus(['room_living'])
    const first = await service.queueRequest('Refine the living room')
    await service.queueRequest('Review the kitchen')
    expect(service.oldestPendingRequest()?.id).toBe(first.id)
    const claimed = await service.setRequestStatus(first.id, 'claimed')
    expect(claimed.selection).toEqual(['room_living'])
    expect(service.snapshot.activity.some((event) => event.kind === 'request')).toBe(true)
  })

  it('exports and imports ProjectDocumentV1 without changing coordinates', async () => {
    const service = new StudioService(); await service.initialize(); const originalId = service.snapshot.project.id; const json = service.exportProject()
    const restored = await service.importProject(json)
    expect(restored.schemaVersion).toBe(1)
    expect(restored.id).not.toBe(originalId)
    expect(restored.revision).toBe(0)
    expect(restored.floor.walls[0].start).toEqual(JSON.parse(json).floor.walls[0].start)
    await expect(service.importProject('{"schemaVersion":2}')).rejects.toThrow('ProjectDocumentV1')
  })

  it('rejects malformed, duplicate, and oversized imports before persistence', async () => {
    const service = new StudioService(); await service.initialize(); const activeId = service.snapshot.project.id
    const malformed = JSON.parse(service.exportProject()); malformed.floor.walls[0].start = null
    await expect(service.importProject(JSON.stringify(malformed))).rejects.toThrow('must be an object')
    const duplicate = JSON.parse(service.exportProject()); duplicate.floor.openings[0].id = duplicate.floor.walls[0].id
    await expect(service.importProject(JSON.stringify(duplicate))).rejects.toThrow('duplicate entity IDs')
    await expect(service.importProject(' '.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MB')
    await expect((await database()).get('settings', 'activeProjectId')).resolves.toBe(activeId)
  })

  it('restores the active project after creating a second project', async () => {
    const service = new StudioService(); await service.initialize(); const created = await service.createProject('Second house')
    const reloaded = new StudioService(); await reloaded.initialize()
    expect(reloaded.snapshot.project.id).toBe(created.id)
  })

  it('serializes parallel draft creation and rejects a stale second service', async () => {
    const first = new StudioService(); await first.initialize(); const revision = first.snapshot.project.revision
    const attempts = await Promise.allSettled([first.beginChange(revision), first.beginChange(revision)])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await first.applyStyle([{ roomId: 'room_living', floorMaterial: 'oak', wallFinish: 'plaster', ceilingHeightMm: 2800, palette: [], renderStyle: 'calm' }]); await first.presentChange()
    const stale = new StudioService(); await stale.initialize(); await first.approvePresentedChange()
    await expect(stale.approvePresentedChange()).rejects.toThrow('stale or superseded')
  })

  it('serializes concurrent revision restores into one atomic next revision', async () => {
    const author = new StudioService(); await author.initialize(); await author.beginChange(author.snapshot.project.revision)
    await author.applyStyle([{ roomId: 'room_living', floorMaterial: 'oak', wallFinish: 'plaster', ceilingHeightMm: 2800, palette: [], renderStyle: 'calm' }]); await author.presentChange(); await author.approvePresentedChange()
    const first = new StudioService(); const second = new StudioService(); await Promise.all([first.initialize(), second.initialize()])
    const attempts = await Promise.allSettled([first.restoreRevision(3), second.restoreRevision(3)])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const db = await database(); const persisted = await db.get('projects', first.snapshot.project.id)
    const revisionFive = await db.get('revisions', `${first.snapshot.project.id}:5`)
    expect(persisted?.revision).toBe(5); expect(revisionFive?.document.revision).toBe(5)
  })

  it('rejects orphan room styles and duplicate IDs before staging', async () => {
    const service = new StudioService(); await service.initialize(); await service.beginChange(service.snapshot.project.revision)
    await expect(service.applyStyle([{ roomId: 'missing', floorMaterial: 'oak', wallFinish: 'paint', ceilingHeightMm: 2800, palette: [], renderStyle: 'calm' }])).rejects.toThrow('style references')
    const duplicate = service.snapshot.project.floor.walls[0]
    await expect(service.applyLayout({ walls: { upsert: [duplicate, { ...duplicate }] } })).rejects.toThrow('duplicate')
  })
})
