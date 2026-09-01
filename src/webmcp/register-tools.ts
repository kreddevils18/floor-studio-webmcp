import { registrationState } from './registration-state'
import { toolCatalog } from './tool-catalog'
import { executeTool } from './tool-executor'

type ModelContextLike = {
  registerTool?: (tool: unknown, options: { signal: AbortSignal }) => Promise<void>
  getTools?: () =>
    | Promise<Array<{ name: string; description?: string }>>
    | Array<{ name: string; description?: string }>
  addEventListener?: (type: string, listener: EventListener) => void
  removeEventListener?: (type: string, listener: EventListener) => void
}

function modelContext() {
  return (document as Document & { modelContext?: ModelContextLike }).modelContext
}

export async function refreshRegistrationHealth(failed: string[] = registrationState.getSnapshot().failed) {
  const context = modelContext()
  if (!context?.registerTool) {
    registrationState.set({ supported: false, expected: toolCatalog.length, registered: 0, failed: [], tools: [] })
    return
  }
  let tools: Array<{ name: string; description?: string }> = []
  const canList = typeof context.getTools === 'function'
  if (canList) {
    try {
      tools = (await context.getTools?.()) ?? []
    } catch {
      tools = []
    }
  }
  const registeredNames = new Set(tools.map((tool) => tool.name))
  registrationState.set({
    supported: true,
    expected: toolCatalog.length,
    registered: canList
      ? toolCatalog.filter((tool) => registeredNames.has(tool.name)).length
      : toolCatalog.length - failed.length,
    failed,
    tools: canList
      ? tools
      : toolCatalog
          .filter((tool) => !failed.includes(tool.name))
          .map(({ name, description }) => ({ name, description })),
  })
}

export function registerWebMcpTools() {
  const controller = new AbortController()
  const context = modelContext()
  if (!context?.registerTool) {
    void refreshRegistrationHealth()
    return controller
  }

  const failed: string[] = []
  const registrations = toolCatalog.map(async (tool) => {
    try {
      await context.registerTool?.(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          execute: (input: unknown, execution?: { signal?: AbortSignal }) =>
            executeTool(tool, input, execution?.signal),
        },
        { signal: controller.signal },
      )
    } catch (error) {
      failed.push(tool.name)
      console.error(`Failed to register ${tool.name}`, error)
    }
  })

  const refresh = () => {
    void refreshRegistrationHealth(failed)
  }
  context.addEventListener?.('toolchange', refresh as EventListener)
  document.addEventListener('toolchange', refresh)
  void Promise.allSettled(registrations).then(refresh)
  controller.signal.addEventListener(
    'abort',
    () => {
      context.removeEventListener?.('toolchange', refresh as EventListener)
      document.removeEventListener('toolchange', refresh)
    },
    { once: true },
  )
  return controller
}
