import { useEffect, useSyncExternalStore } from 'react'
import { geometry } from '../core/geometry-engine'
import { studio } from '../domain/studio-service'

export function useStudio() {
  const snapshot = useSyncExternalStore(studio.subscribe.bind(studio), studio.getSnapshot, studio.getSnapshot)
  useEffect(() => {
    if (!snapshot) void geometry.initialize().then(() => studio.initialize())
  }, [snapshot])
  return snapshot
}
