import type { AuthoritativeRenderCapture } from '../../domain/model'

type CaptureProvider = () => Promise<AuthoritativeRenderCapture>

let provider: CaptureProvider | null = null
const waiters = new Set<(capture: CaptureProvider) => void>()

export function registerAuthoritative3dCapture(next: CaptureProvider) {
  provider = next
  for (const resolve of waiters) resolve(next)
  waiters.clear()
  return () => {
    if (provider === next) provider = null
  }
}

export async function captureAuthoritative3d(timeoutMs = 10_000) {
  if (provider) return provider()
  const capture = await new Promise<CaptureProvider>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      waiters.delete(onReady)
      reject(new Error('The 3D scene did not become ready for capture.'))
    }, timeoutMs)
    const onReady = (next: CaptureProvider) => {
      window.clearTimeout(timeout)
      resolve(next)
    }
    waiters.add(onReady)
  })
  return capture()
}
