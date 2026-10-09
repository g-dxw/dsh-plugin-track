/**
 * Small display formatters.
 *
 * `formatTimeHHMM` is the one the elevation profile needs; upstream kept it in
 * `$lib/util/format_util`. The distance / elevation / duration helpers are the
 * panel's own, so the map, the chart and the stat cards all round the same way.
 */

export function formatTimeHHMM(seconds?: number): string {
  if (seconds == null || isNaN(seconds)) return '-'
  const totalMinutes = Math.floor(seconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)
  return (h < 10 ? '0' : '') + h + 'h ' + (m < 10 ? '0' : '') + m + 'm'
}

/** Metres → `1.24 km` / `840 m`. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '-'
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`
}

/**
 * Metres of climb → `+412 m`.
 *
 * `null` is accepted alongside `undefined` because that is how a track says "no
 * elevation in this file" — the two mean the same thing here and both belong on
 * the same dash.
 */
export function formatElevation(meters?: number | null): string {
  if (meters == null || !Number.isFinite(meters)) return '-'
  return `${meters > 0 ? '+' : ''}${Math.round(meters)} m`
}

/** Milliseconds → `1 小时 24 分 06 秒` / `24 分 06 秒`. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '-'
  const total = Math.round(milliseconds / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours} 小时 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  if (minutes) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  return `${seconds} 秒`
}

/** Consistent with the displayed route length and elapsed time; unknown time stays unknown. */
export function formatAverageSpeed(distance: number, duration: number): string {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(duration) || duration <= 0) return '-'
  return `${(distance / duration * 3600).toFixed(2)} km/h`
}

/** Local `YYYY-MM-DD HH:mm`, for the track list. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return '-'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `1234567` → `1.2 MB`. */
export function formatBytes(bytes: number): string {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}
