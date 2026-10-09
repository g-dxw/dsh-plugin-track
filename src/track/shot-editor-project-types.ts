import type {MapSettings} from './map-settings.ts'
import type {ShotEditorPlan} from './shot-editor.ts'

export const SHOT_EDITOR_PROJECT_SCHEMA = 'cqai-track-shot-editor@1' as const
export const SHOT_EDITOR_PROJECT_MAX_BYTES = 2_000_000

export type ShotEditorAppearance = Pick<MapSettings, 'lighting' | 'sandboxColors' | 'sandboxBackground'>
export interface ShotEditorProjectInput {
  schema: typeof SHOT_EDITOR_PROJECT_SCHEMA
  plan: ShotEditorPlan
  appearance: ShotEditorAppearance
}
export interface ShotEditorProjectEnvelope extends ShotEditorProjectInput {
  revision: string
  updatedAt: string
}
