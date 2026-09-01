import { beforeEach, describe, expect, it, vi } from 'vitest'
import { geometry } from '../src/core/geometry-engine'
import { clearDatabaseForTests, database } from '../src/data/database'
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, PreviewUploadService } from '../src/domain/preview-upload'
import { StudioService } from '../src/domain/studio-service'

const decoded = (base64: string) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
const png = decoded(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQMAAADOtka5AAAAA1BMVEXWtIxK2dDvAAAANklEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8G4IAAAFjdVCkAAAAAElFTkSuQmCC',
)
const tinyPng = decoded('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
const authoritativePng = decoded(
  'iVBORw0KGgoAAAANSUhEUgAABgAAAAQAAQMAAAAdvwABAAAAA1BMVEX49fNR0qnsAAAA1ElEQVR42u3BAQEAAACAkP6v7ggKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABqBC0AAUx+/FkAAAAASUVORK5CYII=',
)
const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('preview upload bridge', () => {
  let service: StudioService
  let upload: PreviewUploadService
  beforeEach(async () => {
    await clearDatabaseForTests()
    vi.spyOn(geometry, 'initialize').mockResolvedValue('ready')
    vi.spyOn(geometry, 'validate').mockReturnValue([])
    service = new StudioService()
    await service.initialize()
    upload = new PreviewUploadService(service)
  })

  it('verifies and persists an ordered PNG upload', async () => {
    const ticket = await upload.prepare('2d')
    await service.claimRenderJob(ticket.id)
    await upload.begin(ticket, 'image/png', await hex(png), png.byteLength)
    await expect(upload.append(ticket.id, 0, encoded(png))).resolves.toEqual({
      nextIndex: 1,
      receivedBytes: png.byteLength,
    })
    const asset = await upload.commit(ticket.id)
    expect(asset.mimeType).toBe('image/png')
    expect(asset.artifactKind).toBe('concept')
    expect(asset.blobRef).toMatch(/^blob_/)
    expect(service.snapshot.previews[0].id).toBe(asset.id)
  })

  it('rejects concept rasters that are too small to be meaningful previews', async () => {
    const ticket = await upload.prepare('2d')
    await service.claimRenderJob(ticket.id)
    const tiny = tinyPng
    await upload.begin(ticket, 'image/png', await hex(tiny), tiny.byteLength)
    await upload.append(ticket.id, 0, encoded(tiny))
    await expect(upload.commit(ticket.id)).rejects.toThrow('at least 512 × 512')
  })

  it('persists an authoritative Three.js capture with project and source provenance', async () => {
    const projectBytes = new TextEncoder().encode(JSON.stringify(service.snapshot.project))
    const blob = new Blob([authoritativePng], { type: 'image/png' })
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => authoritativePng.buffer })
    const asset = await service.saveAuthoritative3dPreview({
      blob,
      manifest: {
        documentHash: await hex(projectBytes),
        sourceHash: await hex(authoritativePng),
        width: 1536,
        height: 1024,
        renderer: 'three.js',
        rendererVersion: 'test',
        capturedAt: new Date().toISOString(),
        camera: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], projectionMatrix: Array(16).fill(0) },
      },
    })
    expect(asset).toMatchObject({
      artifactKind: 'authoritative',
      renderMode: '3d',
      sourcePlanRevision: service.snapshot.project.revision,
    })
    expect(service.snapshot.tickets[0]).toMatchObject({ status: 'ready', artifactKind: 'authoritative' })
  })

  it('rejects wrong order, checksums, unsupported formats, and limits', async () => {
    const ticket = await upload.prepare('2d')
    expect(ticket.prompt).toContain('top-down furnished 2D floor plan')
    await service.claimRenderJob(ticket.id)
    await expect(upload.begin(ticket, 'image/svg+xml', '0'.repeat(64), 10)).rejects.toThrow('Only PNG')
    await expect(upload.begin(ticket, 'image/png', '0'.repeat(64), PREVIEW_MAX_BYTES + 1)).rejects.toThrow('12 MB')
    await upload.begin(ticket, 'image/png', '0'.repeat(64), png.byteLength)
    await expect(upload.append(ticket.id, 1, encoded(png))).rejects.toThrow('Expected chunk 0')
    await upload.append(ticket.id, 0, encoded(png))
    await expect(upload.commit(ticket.id)).rejects.toThrow('checksum')
  })

  it('enforces the decoded chunk boundary and aborts incomplete sessions', async () => {
    const ticket = await upload.prepare('2d')
    await service.claimRenderJob(ticket.id)
    const large = new Uint8Array(PREVIEW_CHUNK_BYTES + 1)
    await upload.begin(ticket, 'image/png', '0'.repeat(64), large.byteLength)
    await expect(upload.append(ticket.id, 0, encoded(large))).rejects.toThrow('256 KiB')
    await expect(upload.abort(ticket.id)).resolves.toEqual({ ticketId: ticket.id, status: 'failed' })
  })

  it('reports browser quota failures and prevents ticket reuse', async () => {
    const ticket = await upload.prepare('2d')
    await service.claimRenderJob(ticket.id)
    await upload.begin(ticket, 'image/png', await hex(png), png.byteLength)
    await upload.append(ticket.id, 0, encoded(png))
    vi.spyOn(service, 'commitPreviewAsset').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    await expect(upload.commit(ticket.id)).rejects.toThrow('storage quota')
    await expect(upload.begin(ticket, 'image/png', await hex(png), png.byteLength)).rejects.toThrow('not available')
  })

  it('atomically grants one upload lease and does not reset a live lease on reload', async () => {
    const ticket = await upload.prepare('3d')
    await service.claimRenderJob(ticket.id)
    const other = new PreviewUploadService(service)
    const attempts = await Promise.allSettled([
      upload.begin(ticket, 'image/png', await hex(png), png.byteLength),
      other.begin(ticket, 'image/png', await hex(png), png.byteLength),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const reloaded = new StudioService()
    await reloaded.initialize()
    expect((await reloaded.getTicket(ticket.id))?.status).toBe('rendering')
  })

  it('deduplicates active jobs and binds mode and revision through commit', async () => {
    const first = await upload.prepare('3d')
    const duplicate = await upload.prepare('2d')
    expect(duplicate.id).toBe(first.id)
    expect(service.snapshot.tickets).toHaveLength(1)
    expect(first).toMatchObject({
      renderMode: '3d',
      sourcePlanRevision: service.snapshot.project.revision,
      status: 'queued',
    })
    await service.claimRenderJob(first.id)
    expect(service.snapshot.tickets[0].status).toBe('rendering')
    await upload.begin(first, 'image/png', await hex(png), png.byteLength)
    await upload.append(first.id, 0, encoded(png))
    const asset = await upload.commit(first.id)
    expect(asset).toMatchObject({ renderMode: '3d', sourcePlanRevision: service.snapshot.project.revision })
    expect(service.snapshot.tickets[0].status).toBe('ready')
  })

  it('requeues an expired render lease without reloading the service', async () => {
    const ticket = await upload.prepare('2d')
    const claimed = await service.claimRenderJob(ticket.id)
    await (await database()).put('tickets', {
      ...claimed,
      renderLeaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    await expect(service.queuedRenderJob()).resolves.toMatchObject({ id: ticket.id, status: 'queued' })
    await expect(service.getTicket(ticket.id)).resolves.toMatchObject({ status: 'rendering' })
    await expect(service.claimRenderJob(ticket.id)).resolves.toMatchObject({ id: ticket.id, status: 'rendering' })
  })

  it('rejects an expired upload owner and allows a new claimant', async () => {
    const ticket = await upload.prepare('3d')
    await service.claimRenderJob(ticket.id)
    await upload.begin(ticket, 'image/png', await hex(png), png.byteLength)
    await upload.append(ticket.id, 0, encoded(png))
    const persisted = await service.getTicket(ticket.id)
    expect(persisted).toBeDefined()
    if (!persisted) throw new Error('Ticket fixture is missing.')
    await (await database()).put('tickets', {
      ...persisted,
      uploadLeaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    await expect(service.queuedRenderJob()).resolves.toMatchObject({ id: ticket.id, status: 'queued' })
    await service.claimRenderJob(ticket.id)
    await expect(upload.commit(ticket.id)).rejects.toThrow('lease')
    const retry = new PreviewUploadService(service)
    await expect(retry.begin(ticket, 'image/png', await hex(png), png.byteLength)).resolves.toMatchObject({
      ticketId: ticket.id,
    })
  })

  it('cleans up cancellation after claiming and can fail a render before upload begins', async () => {
    const ticket = await upload.prepare('2d')
    await service.claimRenderJob(ticket.id)
    const controller = new AbortController()
    const originalClaim = service.claimPreviewTicket.bind(service)
    vi.spyOn(service, 'claimPreviewTicket').mockImplementation(async (...arguments_) => {
      const claimed = await originalClaim(...arguments_)
      controller.abort()
      return claimed
    })
    await expect(upload.begin(ticket, 'image/png', await hex(png), png.byteLength, controller.signal)).rejects.toThrow(
      'cancelled',
    )
    expect(await service.getTicket(ticket.id)).toMatchObject({ status: 'failed' })

    const next = await upload.prepare('3d')
    await service.claimRenderJob(next.id)
    await expect(upload.abort(next.id)).resolves.toEqual({ ticketId: next.id, status: 'failed' })
  })

  it('keeps bundled preview assets linked to their own persisted ready ticket', async () => {
    const active = await upload.prepare('2d')
    const blob = new Blob([png], { type: 'image/png' })
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => png.buffer })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, blob: async () => blob } as Response)
    await service.seedBundledPreviews([{ url: '/seed.png', target: { kind: 'floor' }, prompt: 'Seed preview' }])
    const asset = service.snapshot.previews[0]
    expect(asset.ticketId).not.toBe(active.id)
    await expect(service.getTicket(asset.ticketId)).resolves.toMatchObject({ status: 'ready' })
  })

  it('rejects an upload commit after the active project changes', async () => {
    const ticket = await upload.prepare('2d')
    await service.claimRenderJob(ticket.id)
    await upload.begin(ticket, 'image/png', await hex(png), png.byteLength)
    await upload.append(ticket.id, 0, encoded(png))
    const claimed = await service.getTicket(ticket.id)
    expect(claimed?.uploadOwnerId).toBeDefined()
    await service.createProject('Another project')
    await expect(
      service.renewPreviewTicketLease(
        ticket.id,
        claimed?.uploadOwnerId ?? '',
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).rejects.toThrow('lease')
    await expect(upload.abort(ticket.id)).rejects.toThrow('lease')
    await expect(upload.commit(ticket.id)).rejects.toThrow('lease')
    expect(service.snapshot.previews).toHaveLength(0)
    expect(service.snapshot.tickets).toHaveLength(0)
    expect(service.snapshot.project.name).toBe('Another project')
  })
})
