import type { PreviewAsset, PreviewTicket } from './model'
import { newId, nowIso } from './model'
import type { StudioService } from './studio-service'

export const PREVIEW_CHUNK_BYTES = 256 * 1024
export const PREVIEW_MAX_BYTES = 12 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])

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
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('Chunk is not valid base64.')
  const raw = atob(encoded); const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  if (bytes.byteLength > PREVIEW_CHUNK_BYTES) throw new Error('Decoded chunks cannot exceed 256 KiB.')
  return bytes
}

async function sha256(bytes: Uint8Array) {
  const buffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class PreviewUploadService {
  private sessions = new Map<string, UploadSession>()
  constructor(private readonly studio: StudioService) {}

  async prepare(target: PreviewTicket['target']) {
    const { project } = this.studio.snapshot
    if (target.kind === 'room' && !project.floor.roomMarkers.some((room) => room.id === target.roomId)) throw new Error('Preview room was not found.')
    const subject = target.kind === 'floor'
      ? `a whole-floor axonometric cutaway of ${project.name}`
      : `a natural eye-level interior perspective of ${project.floor.roomMarkers.find((room) => room.id === target.roomId)?.name}`
    const prompt = [
      'Use case: sketch-to-render', 'Asset type: Floor Studio design preview', `Primary request: Transform the prepared plan into ${subject}.`,
      'Style/medium: polished architectural visualization, editorial realism', 'Lighting/mood: warm indirect daylight, calm residential atmosphere',
      'Materials/textures: follow the room material schedule and preserve wall/opening placement',
      'Constraints: single residential floor; preserve plan proportions and circulation; no people; no text; no watermark',
    ].join('\n')
    const ticket: PreviewTicket = { id: newId('render'), projectId: project.id, target, sourcePlanRevision: project.revision, prompt, status: 'prepared', createdAt: nowIso() }
    await this.studio.saveTicket(ticket); this.studio.focus(target.kind === 'room' ? [target.roomId] : [], '2d')
    return ticket
  }

  async begin(ticket: PreviewTicket, mimeType: string, checksum: string, expectedBytes: number) {
    if (!ALLOWED_MIME.has(mimeType)) throw new Error('Only PNG, JPEG, and WebP previews are accepted.')
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('A hexadecimal SHA-256 checksum is required.')
    if (!Number.isInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > PREVIEW_MAX_BYTES) throw new Error('Preview size must be between 1 byte and 12 MB.')
    if (this.sessions.has(ticket.id)) throw new Error('An upload already exists for this ticket.')
    const ownerId = newId('upload'); const leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    const claimed = await this.studio.claimPreviewTicket(ticket.id, ownerId, leaseExpiresAt)
    this.sessions.set(ticket.id, { ticket: claimed, ownerId, mimeType: mimeType as PreviewAsset['mimeType'], checksum: checksum.toLowerCase(), expectedBytes, chunks: [], receivedBytes: 0, appending: false })
    return { ticketId: ticket.id, chunkBytes: PREVIEW_CHUNK_BYTES, maxBytes: PREVIEW_MAX_BYTES }
  }

  async append(ticketId: string, index: number, encoded: string) {
    const session = this.sessions.get(ticketId)
    if (!session) throw new Error('Upload session not found.')
    if (session.appending) throw new Error('Another chunk is currently being appended.')
    if (index !== session.chunks.length) throw new Error(`Expected chunk ${session.chunks.length}, received ${index}.`)
    const bytes = decodeChunk(encoded)
    if (session.receivedBytes + bytes.byteLength > session.expectedBytes || session.receivedBytes + bytes.byteLength > PREVIEW_MAX_BYTES) throw new Error('Upload exceeds its declared or maximum size.')
    session.appending = true
    try {
      session.ticket = await this.studio.renewPreviewTicketLease(ticketId, session.ownerId, new Date(Date.now() + 15 * 60_000).toISOString())
      session.chunks.push(bytes); session.receivedBytes += bytes.byteLength
      return { nextIndex: session.chunks.length, receivedBytes: session.receivedBytes }
    } finally { session.appending = false }
  }

  async commit(ticketId: string) {
    const session = this.sessions.get(ticketId)
    if (!session) throw new Error('Upload session not found.')
    if (session.receivedBytes !== session.expectedBytes) throw new Error(`Upload is incomplete: ${session.receivedBytes} of ${session.expectedBytes} bytes.`)
    const bytes = new Uint8Array(session.receivedBytes); let offset = 0
    for (const chunk of session.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const actual = await sha256(bytes)
    if (actual !== session.checksum) throw new Error('Preview checksum does not match.')
    const signature = [...bytes.slice(0, 12)]
    const valid = session.mimeType === 'image/png' ? signature.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
      : session.mimeType === 'image/jpeg' ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255
        : String.fromCharCode(...signature.slice(0, 4)) === 'RIFF' && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP'
    if (!valid) throw new Error('Preview bytes do not match the declared raster type.')
    const blobRef = newId('blob'); const blob = new Blob([bytes], { type: session.mimeType })
    const asset: PreviewAsset = { id: newId('preview'), ticketId, projectId: session.ticket.projectId, target: session.ticket.target, sourcePlanRevision: session.ticket.sourcePlanRevision, prompt: session.ticket.prompt, mimeType: session.mimeType, checksum: actual, blobRef, createdAt: nowIso() }
    try {
      await this.studio.commitPreviewAsset(session.ticket, session.ownerId, asset, blob)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        await this.studio.failPreviewTicket(ticketId, session.ownerId); this.sessions.delete(ticketId)
        throw new Error('Browser storage quota was exceeded while saving the preview.')
      }
      throw error
    }
    this.sessions.delete(ticketId); this.studio.focus([], '3d'); return asset
  }

  async abort(ticketId: string) {
    const session = this.sessions.get(ticketId)
    if (!session) throw new Error('Upload session not found.')
    await this.studio.failPreviewTicket(ticketId, session.ownerId); this.sessions.delete(ticketId)
    return { ticketId, status: 'failed' as const }
  }
}
