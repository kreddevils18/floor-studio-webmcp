import { describe, expect, it, vi } from 'vitest'
import { registerWebMcpTools } from '../src/webmcp/register-tools'

describe('native WebMCP registration', () => {
  it('registers the complete floor tool surface with abort-owned lifetimes', async () => {
    const registered: Array<{ tool: Record<string, unknown>; signal: AbortSignal }> = []
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: vi.fn(async (tool, options) => { registered.push({ tool, signal: options.signal }) }) } })
    const controller = registerWebMcpTools(); await Promise.resolve(); await Promise.resolve()
    expect(registered.map((entry) => entry.tool.name)).toEqual([
      'floor.create_project', 'floor.get_state', 'floor.get_request', 'floor.set_request_status', 'floor.begin_change',
      'floor.apply_layout', 'floor.apply_style', 'floor.validate_change', 'floor.focus', 'floor.present_change',
      'floor.discard_change', 'floor.prepare_preview', 'floor.preview_begin', 'floor.preview_chunk', 'floor.preview_commit', 'floor.preview_abort',
    ])
    expect(registered.every((entry) => (entry.tool.inputSchema as { additionalProperties: boolean }).additionalProperties === false)).toBe(true)
    expect(registered.find((entry) => entry.tool.name === 'floor.get_request')?.tool.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true })
    controller.abort(); expect(registered.every((entry) => entry.signal.aborted)).toBe(true)
  })

  it('runs runtime input validation in addition to JSON Schema', async () => {
    let tool: { execute: (input: unknown) => Promise<unknown> } | undefined
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: vi.fn(async (candidate) => { if (candidate.name === 'floor.create_project') tool = candidate }) } })
    registerWebMcpTools(); await Promise.resolve(); await Promise.resolve()
    await expect(tool?.execute({ name: '', injected: true })).rejects.toThrow(/not allowed|too short/)
  })
})

