/** Planning data for editable route films. Durations are seconds, not recorded GPS time. */
export const VIDEO_SCENE_KINDS = ['route-overview', 'terrain-overview', 'route-progress', 'elevation-profile', 'high-point', 'climb-section', 'descent-section', 'placemark', 'annotation', 'recorded-stop', 'preparation', 'surrounding-peaks', 'finish'] as const
export type VideoSceneKind = typeof VIDEO_SCENE_KINDS[number]
export const MAX_VIDEO_CANDIDATES = 48
export const MAX_VIDEO_SHOTS = 24
export const MAX_VIDEO_DURATION = 1800

export interface VideoSceneTarget {
  pointIndex?: number
  endIndex?: number
  coordinates?: [number, number]
  placemarkId?: string
}
export interface VideoSceneCandidate {
  id: string
  kind: VideoSceneKind
  title: string
  readiness: 'ready' | 'needs-info'
  facts: string[]
  evidence: string[]
  missing: string[]
  visual: string
  camera: string
  draftNarration: string
  onScreenText: string
  materials: string[]
  duration: number
  target?: VideoSceneTarget
}
export interface VideoScriptAnalysis {
  trackId: string
  trackName: string
  pointCount: number
  fingerprint: string
  summary: string[]
  limitations: string[]
  candidates: VideoSceneCandidate[]
}
export interface VideoScriptShot {
  id: string
  candidateId: string
  kind: VideoSceneKind
  title: string
  duration: number
  visual: string
  camera: string
  narration: string
  onScreenText: string
  materials: string[]
  confirmed: boolean
  target?: VideoSceneTarget
}
export interface VideoScriptDraft {
  version: 1
  trackId: string
  fingerprint: string
  title: string
  notes: string
  shots: VideoScriptShot[]
}
/** Only bounded facts and selected scene descriptions are submitted. No images or source files. */
export interface VideoScriptRequest {
  model: string
  analysis: Pick<VideoScriptAnalysis, 'trackName' | 'pointCount' | 'fingerprint' | 'summary' | 'limitations'>
  candidates: VideoSceneCandidate[]
  userNotes: string
}
export interface VideoScriptSuggestion {
  title: string
  shots: VideoScriptShot[]
}
