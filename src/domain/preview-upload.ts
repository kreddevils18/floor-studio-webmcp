import type { PreviewAsset, PreviewTicket, RenderMode } from './model'
import { newId, nowIso } from './model'
import { validateRasterBlob } from './raster-validation'
import type { StudioService } from './studio-service'

export const PREVIEW_CHUNK_BYTES = 256 * 1024
export const PREVIEW_MAX_BYTES = 12 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const PREVIEW_MIN_EDGE = 512

interface UploadSession {
  ticket: PreviewTicket
  ownerId: string
  mimeType: PreviewAsset['mimeType']
  checksum: string
  expectedBytes: number
  chunks: Uint8Array[]
  receivedBytes: number
  appending: boolean
}

function decodeChunk(encoded: string) {
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new Error('Chunk is not valid base64.')
  const raw = atob(encoded)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  if (bytes.byteLength > PREVIEW_CHUNK_BYTES) throw new Error('Decoded chunks cannot exceed 256 KiB.')
  return bytes
}

async function sha256(bytes: Uint8Array) {
  const buffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Preview operation was cancelled.', 'AbortError')
}

export class PreviewUploadService {
  private sessions = new Map<string, UploadSession>()
  constructor(private readonly studio: StudioService) {}

  async prepare(renderMode: RenderMode, signal?: AbortSignal) {
    throwIfAborted(signal)
    const { project } = this.studio.snapshot
    if (this.studio.snapshot.draft) throw new Error('Save or reject the active draft before rendering.')
    if (this.studio.snapshot.selectedRevision !== project.revision)
      throw new Error('Return to the latest saved version before rendering.')
    const subject =
      renderMode === '2d'
        ? `a presentation-ready top-down furnished 2D floor plan of ${project.name}`
        : `a presentation-ready furnished isometric whole-floor visualization of ${project.name}`
    const prompt = [
      'Use case: sketch-to-render',
      'Asset type: Floor Studio design preview',
      `Primary request: Transform the prepared plan into ${subject}.`,
      renderMode === '2d'
        ? 'Style/medium: polished top-down architectural floor-plan rendering with realistic furniture and crisp plan geometry'
        : 'Style/medium: polished axonometric architectural visualization, editorial realism, visible room volumes',
      renderMode === '2d'
        ? 'Lighting/mood: even neutral presentation lighting, clean white background'
        : 'Lighting/mood: warm indirect daylight, calm residential atmosphere',
      'Materials/textures: follow the room material schedule and preserve wall/opening placement',
      'Constraints: single residential floor; preserve plan proportions, walls, openings, furniture placement, and circulation exactly; no people; no text; no watermark',
    ].join('\n')
    const ticket: PreviewTicket = {
      id: newId('render'),
      projectId: project.id,
      target: { kind: 'floor' },
      sourcePlanRevision: project.revision,
      renderMode,
      artifactKind: 'concept',
      prompt,
      status: 'queued',
      createdAt: nowIso(),
    }
    throwIfAborted(signal)
    const saved = await this.studio.saveTicket(ticket)
    this.studio.focus([], saved.renderMode)
    return saved
  }

  async begin(ticket: PreviewTicket, mimeType: string, checksum: string, expectedBytes: number, signal?: AbortSignal) {
    throwIfAborted(signal)
    if (!ALLOWED_MIME.has(mimeType)) throw new Error('Only PNG, JPEG, and WebP previews are accepted.')
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('A hexadecimal SHA-256 checksum is required.')
    if (!Number.isInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > PREVIEW_MAX_BYTES)
      throw new Error('Preview size must be between 1 byte and 12 MB.')
    if (this.sessions.has(ticket.id)) throw new Error('An upload already exists for this ticket.')
    const ownerId = newId('upload')
    const leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    const claimed = await this.studio.claimPreviewTicket(ticket.id, ownerId, leaseExpiresAt)
    if (signal?.aborted) {
      await this.studio.failPreviewTicket(ticket.id, ownerId)
      throwIfAborted(signal)
    }
    this.sessions.set(ticket.id, {
      ticket: claimed,
      ownerId,
      mimeType: mimeType as PreviewAsset['mimeType'],
      checksum: checksum.toLowerCase(),
      expectedBytes,
      chunks: [],
      receivedBytes: 0,
      appending: false,
    })
    return { ticketId: ticket.id, chunkBytes: PREVIEW_CHUNK_BYTES, maxBytes: PREVIEW_MAX_BYTES }
  }

  async append(ticketId: string, index: number, encoded: string, signal?: AbortSignal) {
    throwIfAborted(signal)
    const session = this.sessions.get(ticketId)
    if (!session) throw new Error('Upload session not found.')
    if (session.appending) throw new Error('Another chunk is currently being appended.')
    if (index !== session.chunks.length) throw new Error(`Expected chunk ${session.chunks.length}, received ${index}.`)
    const bytes = decodeChunk(encoded)
    if (
      session.receivedBytes + bytes.byteLength > session.expectedBytes ||
      session.receivedBytes + bytes.byteLength > PREVIEW_MAX_BYTES
    )
      throw new Error('Upload exceeds its declared or maximum size.')
    session.appending = true
    try {
      session.ticket = await this.studio.renewPreviewTicketLease(
        ticketId,
        session.ownerId,
        new Date(Date.now() + 15 * 60_000).toISOString(),
      )
      throwIfAborted(signal)
      session.chunks.push(bytes)
      session.receivedBytes += bytes.byteLength
      return { nextIndex: session.chunks.length, receivedBytes: session.receivedBytes }
    } finally {
      session.appending = false
    }
  }

  async commit(ticketId: string, signal?: AbortSignal) {
    throwIfAborted(signal)
    const session = this.sessions.get(ticketId)
    if (!session) throw new Error('Upload session not found.')
    if (session.receivedBytes !== session.expectedBytes)
      throw new Error(`Upload is incomplete: ${session.receivedBytes} of ${session.expectedBytes} bytes.`)
    const bytes = new Uint8Array(session.receivedBytes)
    let offset = 0
    for (const chunk of session.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const actual = await sha256(bytes)
    throwIfAborted(signal)
    if (actual !== session.checksum) throw new Error('Preview checksum does not match.')
    const signature = [...bytes.slice(0, 12)]
    const valid =
      session.mimeType === 'image/png'
        ? signature.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
        : session.mimeType === 'image/jpeg'
          ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255
          : String.fromCharCode(...signature.slice(0, 4)) === 'RIFF' &&
            String.fromCharCode(...signature.slice(8, 12)) === 'WEBP'
    if (!valid) throw new Error('Preview bytes do not match the declared raster type.')
    const blobRef = newId('blob')
    const blob = new Blob([bytes], { type: session.mimeType })
    try {
      await validateRasterBlob(blob, { minWidth: PREVIEW_MIN_EDGE, minHeight: PREVIEW_MIN_EDGE })
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.startsWith('The raster must be at least')
          ? `Concept previews must be at least ${PREVIEW_MIN_EDGE} × ${PREVIEW_MIN_EDGE} pixels.`
          : 'Concept preview raster could not be decoded.',
      )
    }
    const asset: PreviewAsset = {
      id: newId('preview'),
      ticketId,
      projectId: session.ticket.projectId,
      target: session.ticket.target,
      sourcePlanRevision: session.ticket.sourcePlanRevision,
      renderMode: session.ticket.renderMode,
      artifactKind: 'concept',
      prompt: session.ticket.prompt,
      mimeType: session.mimeType,
      checksum: actual,
      blobRef,
      createdAt: nowIso(),
    }
    try {
      throwIfAborted(signal)
      await this.studio.commitPreviewAsset(session.ticket, session.ownerId, asset, blob)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        await this.studio.failPreviewTicket(ticketId, session.ownerId)
        this.sessions.delete(ticketId)
        throw new Error('Browser storage quota was exceeded while saving the preview.')
      }
      throw error
    }
    this.sessions.delete(ticketId)
    this.studio.focus([], 'render')
    return asset
  }

  async abort(ticketId: string) {
    const session = this.sessions.get(ticketId)
    if (!session) {
      const failed = await this.studio.failRenderJob(ticketId)
      return { ticketId, status: failed.status }
    }
    await this.studio.failPreviewTicket(ticketId, session.ownerId)
    this.sessions.delete(ticketId)
    return { ticketId, status: 'failed' as const }
  }
}
