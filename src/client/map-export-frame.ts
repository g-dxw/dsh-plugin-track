import type {Map as MapLibreMap} from 'maplibre-gl'

/** Capture after a complete current-view frame, with bounded wait and listener cleanup. */
export function waitForMapCaptureFrame(map: MapLibreMap, signal: AbortSignal, timeout = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      map.off('render', rendered)
      signal.removeEventListener('abort', canceled)
      if (error) reject(error); else resolve()
    }
    const canceled = () => finish(signal.reason ?? new Error('地图视图已变化，请重新导出'))
    const rendered = () => {
      try {
        if (map.isStyleLoaded() && map.areTilesLoaded() && !map.isMoving()) finish()
      } catch { finish(new Error('地图暂时无法读取，请重新导出')) }
    }
    if (signal.aborted) {canceled(); return}
    map.on('render', rendered)
    signal.addEventListener('abort', canceled, {once: true})
    timer = setTimeout(() => finish(new Error('地图仍在加载，请等待加载完成后重新导出')), timeout)
    try { map.triggerRepaint() } catch { finish(new Error('地图暂时无法读取，请重新导出')) }
  })
}
