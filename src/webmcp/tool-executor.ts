import { geometry } from '../core/geometry-engine'
import { studio } from '../domain/studio-service'
import { validateSchema } from './schemas'
import type { FloorTool } from './tool-catalog'

const sessionId = `session_${crypto.randomUUID()}`

export class ToolExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ToolExecutionError'
  }
}

async function ensureReady() {
  if (geometry.status === 'loading') await geometry.initialize()
  try {
    void studio.snapshot
  } catch {
    await studio.initialize()
  }
  if (geometry.status !== 'ready')
    throw new ToolExecutionError('GEOMETRY_UNAVAILABLE', 'Rust geometry is unavailable; floor tools cannot run safely.')
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted)
    throw new ToolExecutionError('CANCELLED', 'Tool execution was cancelled before committing changes.')
}

function concise(value: unknown, max = 240) {
  const sanitized = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : value
  if (sanitized && typeof sanitized === 'object' && 'base64' in sanitized)
    (sanitized as Record<string, unknown>).base64 = '[chunk omitted]'
  const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function codeFor(error: unknown) {
  if (error instanceof ToolExecutionError) return error.code
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('stale')) return 'STALE_REVISION'
  if (message.includes('cancel')) return 'CANCELLED'
  if (message.includes('not found') || message.includes('missing')) return 'NOT_FOUND'
  if (message.includes('already') || message.includes('lease')) return 'CONFLICT'
  if (
    message.includes('invalid') ||
    message.includes('must') ||
    message.includes('cannot') ||
    message.includes('required') ||
    message.includes('no-op')
  )
    return 'VALIDATION_ERROR'
  return 'INTERNAL_ERROR'
}

export async function executeTool(tool: FloorTool, input: unknown, signal?: AbortSignal) {
  validateSchema(tool.inputSchema, input)
  await ensureReady()
  const executionSignal = signal ?? new AbortController().signal
  const record = input as Record<string, unknown>
  const event = await studio.startTimeline({
    sessionId,
    callId: `call_${crypto.randomUUID()}`,
    toolName: tool.name,
    inputSummary: concise(record),
    baseRevision: typeof record.baseRevision === 'number' ? record.baseRevision : studio.snapshot.project.revision,
    changeId: typeof record.changeId === 'string' ? record.changeId : studio.snapshot.draft?.id,
    entityIds: Array.isArray(record.entityIds) ? (record.entityIds as string[]) : undefined,
  })
  try {
    throwIfAborted(executionSignal)
    const output = await tool.run(record, { signal: executionSignal })
    throwIfAborted(executionSignal)
    const value = output as Record<string, unknown> | undefined
    await studio.finishTimeline(event.id, tool.name === 'floor.present_change' ? 'awaiting-human' : 'succeeded', {
      outputSummary: concise(output),
      resultRevision:
        typeof value?.resultRevision === 'number' ? value.resultRevision : studio.snapshot.project.revision,
      changeId: typeof value?.changeId === 'string' ? value.changeId : event.changeId,
      entityIds: Array.isArray(value?.entityIds) ? (value.entityIds as string[]) : event.entityIds,
    })
    return output
  } catch (error) {
    const code = codeFor(error)
    const message = error instanceof Error ? error.message : 'Tool execution failed.'
    await studio.finishTimeline(event.id, 'failed', { errorCode: code, outputSummary: concise(message) })
    throw error instanceof ToolExecutionError ? error : new ToolExecutionError(code, message)
  }
}
