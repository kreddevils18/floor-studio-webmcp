import { beforeEach, describe, expect, it, vi } from 'vitest'
import { geometry } from '../src/core/geometry-engine'
import { clearDatabaseForTests } from '../src/data/database'
import { PreviewUploadService } from '../src/domain/preview-upload'
import { studio } from '../src/domain/studio-service'
import { registerWebMcpTools } from '../src/webmcp/register-tools'
import { toolCatalog } from '../src/webmcp/tool-catalog'

type RegisteredTool = {
  name: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }
  execute: (input: unknown, execution?: { signal?: AbortSignal }) => Promise<unknown>
}

describe('native WebMCP registration', () => {
  beforeEach(async () => {
    await clearDatabaseForTests()
    vi.spyOn(geometry, 'initialize').mockResolvedValue('ready')
    vi.spyOn(geometry, 'status', 'get').mockReturnValue('ready')
    vi.spyOn(geometry, 'validate').mockReturnValue([])
    await studio.initialize()
  })

  it('registers the exact catalog with abort-owned lifetimes and no approval tool', async () => {
    const registered: Array<{ tool: RegisteredTool; signal: AbortSignal }> = []
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool, options) => {
          registered.push({ tool, signal: options.signal })
        }),
      },
    })
    const controller = registerWebMcpTools()
    await Promise.resolve()
    await Promise.resolve()
    expect(registered.map((entry) => entry.tool.name)).toEqual(toolCatalog.map((tool) => tool.name))
    expect(registered.map((entry) => entry.tool.name)).not.toContain('floor.approve_change')
    expect(registered.map((entry) => entry.tool.name)).not.toContain('floor.get_request')
    expect(registered.every((entry) => entry.tool.inputSchema.additionalProperties === false)).toBe(true)
    expect(registered.find((entry) => entry.tool.name === 'floor.validate_change')?.tool.annotations.readOnlyHint).toBe(
      true,
    )
    expect(
      registered.find((entry) => entry.tool.name === 'floor.claim_render_job')?.tool.annotations.untrustedContentHint,
    ).toBe(true)
    controller.abort()
    expect(registered.every((entry) => entry.signal.aborted)).toBe(true)
  })

  it('rejects unexpected properties and enforces minItems at runtime', async () => {
    const tools: Record<string, RegisteredTool> = {}
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool: RegisteredTool) => {
          tools[tool.name] = tool
        }),
      },
    })
    registerWebMcpTools()
    await Promise.resolve()
    await Promise.resolve()
    await expect(tools['floor.create_project'].execute({ name: '', injected: true })).rejects.toThrow(
      /not allowed|too short/,
    )
    await expect(tools['floor.apply_style'].execute({ styles: [] })).rejects.toThrow('too few items')
  })

  it('records started and terminal events for every executed tool', async () => {
    const tools: Record<string, RegisteredTool> = {}
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool: RegisteredTool) => {
          tools[tool.name] = tool
        }),
      },
    })
    registerWebMcpTools()
    await Promise.resolve()
    await Promise.resolve()
    const context = await tools['floor.get_context'].execute({})
    expect(context).toMatchObject({ revision: 3 })
    expect(studio.snapshot.timeline).toHaveLength(1)
    expect(studio.snapshot.timeline[0]).toMatchObject({ toolName: 'floor.get_context', phase: 'succeeded' })
  })

  it('propagates cancellation and returns a stable machine-readable error code', async () => {
    const tools: Record<string, RegisteredTool> = {}
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool: RegisteredTool) => {
          tools[tool.name] = tool
        }),
      },
    })
    registerWebMcpTools()
    await Promise.resolve()
    await Promise.resolve()
    const controller = new AbortController()
    controller.abort()
    const error = await tools['floor.get_context'].execute({}, { signal: controller.signal }).catch((value) => value)
    expect(error).toMatchObject({ code: 'CANCELLED' })
    expect(studio.snapshot.timeline[0]).toMatchObject({
      toolName: 'floor.get_context',
      phase: 'failed',
      errorCode: 'CANCELLED',
    })
  })

  it('executes the task-oriented catalog through presentation, preview upload, and creation', async () => {
    const tools: Record<string, RegisteredTool> = {}
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool: RegisteredTool) => {
          tools[tool.name] = tool
        }),
      },
    })
    registerWebMcpTools()
    await Promise.resolve()
    await Promise.resolve()
    await expect(tools['floor.list_entities'].execute({ kind: 'walls', limit: 1 })).resolves.toMatchObject({
      nextCursor: 1,
    })
    await expect(tools['floor.focus'].execute({ entityIds: ['room_living'], mode: '2d' })).resolves.toMatchObject({
      mode: '2d',
    })
    const begun = (await tools['floor.begin_change'].execute({ baseRevision: 3 })) as { changeId: string }
    await tools['floor.apply_layout'].execute({
      patch: {
        furniture: {
          upsert: [
            {
              id: 'f_agent',
              kind: 'chair',
              label: 'Reading chair',
              position: { x: 8400, y: 5000 },
              widthMm: 700,
              depthMm: 700,
              rotationDegrees: 0,
            },
          ],
        },
      },
    })
    await tools['floor.apply_style'].execute({
      styles: [
        {
          roomId: 'room_living',
          floorMaterial: 'warm oak',
          wallFinish: 'mineral plaster',
          ceilingHeightMm: 2900,
          palette: ['#d6b48c'],
          renderStyle: 'calm',
        },
      ],
    })
    await expect(tools['floor.validate_change'].execute({})).resolves.toMatchObject({ valid: true })
    await expect(tools['floor.present_change'].execute({})).resolves.toMatchObject({ approval: 'human_required' })
    await expect(tools['floor.get_change_status'].execute({ changeId: begun.changeId })).resolves.toMatchObject({
      status: 'presented',
    })
    await expect(tools['floor.discard_change'].execute({})).resolves.toMatchObject({ status: 'discarded' })

    const requested = await new PreviewUploadService(studio).prepare('2d')
    await expect(tools['floor.get_render_job'].execute({})).resolves.toMatchObject({
      ticketId: requested.id,
      renderMode: '2d',
      status: 'queued',
    })
    const render = (await tools['floor.claim_render_job'].execute({ ticketId: requested.id })) as {
      ticketId: string
    }
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQMAAADOtka5AAAAA1BMVEXWtIxK2dDvAAAANklEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8G4IAAAFjdVCkAAAAAElFTkSuQmCC',
      ),
      (character) => character.charCodeAt(0),
    )
    const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    await tools['floor.preview_begin'].execute({
      ticketId: render.ticketId,
      mimeType: 'image/png',
      checksum,
      expectedBytes: bytes.length,
    })
    await tools['floor.preview_chunk'].execute({
      ticketId: render.ticketId,
      index: 0,
      base64: btoa(String.fromCharCode(...bytes)),
    })
    await expect(tools['floor.preview_commit'].execute({ ticketId: render.ticketId })).resolves.toMatchObject({
      sourcePlanRevision: 3,
    })
    await expect(tools['floor.create_project'].execute({ name: 'Agent house' })).resolves.toMatchObject({ revision: 0 })
  })
})
