export const GEOMOTION_PROJECT_SCHEMA = 'cqai-track-geomotion@1' as const
export const GEOMOTION_PROJECT_MAX_BYTES = 16 * 1024 * 1024

/** The document stays independent from imported GPX/KML and placemark sidecars. */
export interface GeoMotionProjectInput {
  trackId: string
  sourceFingerprint: string
  document: Record<string, unknown>
}

export interface GeoMotionProjectEnvelope extends GeoMotionProjectInput {
  schema: typeof GEOMOTION_PROJECT_SCHEMA
  revision: string
  updatedAt: string
}
