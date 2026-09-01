export interface RegistrationHealth {
  supported: boolean
  expected: number
  registered: number
  failed: string[]
  tools: Array<{ name: string; description?: string }>
}

let state: RegistrationHealth = { supported: false, expected: 0, registered: 0, failed: [], tools: [] }
const listeners = new Set<() => void>()

export const registrationState = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  set(next: RegistrationHealth) {
    state = next
    listeners.forEach((listener) => {
      listener()
    })
  },
}
