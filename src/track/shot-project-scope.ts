import type {OpenMontageShotScope} from './openmontage.ts'
/** A planning project and native scene own a separate editor sidecar. */
export interface ShotProjectScope {projectId: string; shotId: string}
/** The confirmed scene-plan identity is frozen when a capture starts. */
export type OpenMontageEditorScope = OpenMontageShotScope
export function shotProjectKey(trackId: string, scope?: ShotProjectScope): string {
  return JSON.stringify([trackId, scope?.projectId ?? null, scope?.shotId ?? null])
}
export function shotScopeQuery(scope?: ShotProjectScope): string {
  return scope ? `&projectId=${encodeURIComponent(scope.projectId)}&shotId=${encodeURIComponent(scope.shotId)}` : ''
}
