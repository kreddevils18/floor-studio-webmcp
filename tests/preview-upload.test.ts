import { beforeEach, describe, expect, it, vi } from 'vitest'
import { geometry } from '../src/core/geometry-engine'
import { clearDatabaseForTests } from '../src/data/database'
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, PreviewUploadService } from '../src/domain/preview-upload'
import { StudioService } from '../src/domain/studio-service'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('preview upload bridge', () => {
  let service: StudioService
  let upload: PreviewUploadService
  beforeEach(async () => {
    await clearDatabaseForTests(); vi.spyOn(geometry, 'initialize').mockResolvedValue('ready'); vi.spyOn(geometry, 'validate').mockReturnValue([])
    service = new StudioService(); await service.initialize(); upload = new PreviewUploadService(service)
  })

  it('verifies and persists an ordered PNG upload', async () => {
    const ticket = await upload.prepare({ kind: 'room', roomId: 'room_living' }); await upload.begin(ticket, 'image/png', await hex(png), png.byteLength)
    await expect(upload.append(ticket.id, 0, encoded(png))).resolves.toEqual({ nextIndex: 1, receivedBytes: png.byteLength })
    const asset = await upload.commit(ticket.id)
    expect(asset.mimeType).toBe('image/png'); expect(asset.blobRef).toMatch(/^blob_/); expect(service.snapshot.previews[0].id).toBe(asset.id)
  })

  it('rejects wrong order, checksums, unsupported formats, and limits', async () => {
    const ticket = await upload.prepare({ kind: 'floor' })
    await expect(upload.begin(ticket, 'image/svg+xml', '0'.repeat(64), 10)).rejects.toThrow('Only PNG')
    await expect(upload.begin(ticket, 'image/png', '0'.repeat(64), PREVIEW_MAX_BYTES + 1)).rejects.toThrow('12 MB')
    await upload.begin(ticket, 'image/png', '0'.repeat(64), png.byteLength)
    await expect(upload.append(ticket.id, 1, encoded(png))).rejects.toThrow('Expected chunk 0')
    await upload.append(ticket.id, 0, encoded(png)); await expect(upload.commit(ticket.id)).rejects.toThrow('checksum')
  })

  it('enforces the decoded chunk boundary and aborts incomplete sessions', async () => {
    const ticket = await upload.prepare({ kind: 'floor' }); const large = new Uint8Array(PREVIEW_CHUNK_BYTES + 1)
    await upload.begin(ticket, 'image/png', '0'.repeat(64), large.byteLength)
    await expect(upload.append(ticket.id, 0, encoded(large))).rejects.toThrow('256 KiB')
    await expect(upload.abort(ticket.id)).resolves.toEqual({ ticketId: ticket.id, status: 'failed' })
  })

  it('reports browser quota failures and prevents ticket reuse', async () => {
    const ticket = await upload.prepare({ kind: 'floor' }); await upload.begin(ticket, 'image/png', await hex(png), png.byteLength); await upload.append(ticket.id, 0, encoded(png))
    vi.spyOn(service, 'commitPreviewAsset').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
    await expect(upload.commit(ticket.id)).rejects.toThrow('storage quota')
    await expect(upload.begin(ticket, 'image/png', await hex(png), png.byteLength)).rejects.toThrow('not available')
  })

  it('atomically grants one upload lease and does not reset a live lease on reload', async () => {
    const ticket = await upload.prepare({ kind: 'floor' }); const other = new PreviewUploadService(service)
    const attempts = await Promise.allSettled([
      upload.begin(ticket, 'image/png', await hex(png), png.byteLength),
      other.begin(ticket, 'image/png', await hex(png), png.byteLength),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const reloaded = new StudioService(); await reloaded.initialize()
    expect((await reloaded.getTicket(ticket.id))?.status).toBe('uploading')
  })
})
