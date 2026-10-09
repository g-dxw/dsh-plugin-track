/** Track's small bridge contract; canonical creative artifacts remain OpenMontage JSON. */
export type OpenMontageEditor = 'map' | 'sandbox'
export interface OpenMontageShotScope {
  projectId: string; shotId: string; sceneId: string; scenePlanDigest: string
}
export interface OpenMontageSettings {
  sourceDirectory: string; pythonPath: string
}
export interface OpenMontageConnection {
  settings: OpenMontageSettings; ready: boolean; issues: string[]; pythonVersion?: string
  backlotUrl?: string; projectsDirectory: string
}
export interface OpenMontageProject {
  projectId: string; trackId: string; title: string; createdAt: string; updatedAt: string
  workspace: string; sessionId: string | null; pipeline: 'hybrid'
}
export interface OpenMontageStage {
  stage: string; status: string; digest: string | null; approved: boolean; error?: string
}
export interface OpenMontageTake {
  takeId: string; shotId: string; sceneId: string; editor: OpenMontageEditor; scenePlanDigest: string
  projectRevision: string; sha256: string; bytes: number; mime: string; width: number; height: number
  duration: number; fps?: number; createdAt: string; path: string; url: string
}
export interface OpenMontageShot {
  shotId: string; sceneId: string; editor: OpenMontageEditor; purpose: string; description: string
  startSeconds: number; endSeconds: number; requiredAssets: Array<{type: string; description: string; source: string}>
  scope: OpenMontageShotScope; takes: OpenMontageTake[]
}
export interface OpenMontageState {
  project: OpenMontageProject; boardUrl: string; board: Record<string, unknown>
  stages: OpenMontageStage[]; currentStage: string; scenePlanDigest: string | null
  canProduce: boolean; shots: OpenMontageShot[]; issues: string[]
}
export interface OpenMontageAgentWorkspace {
  path: string; sessionId: string | null; projectId: string; trackId: string
  /** Same environment used by the board, checkpoint bridge and native Agent session. */
  environment: Record<string, string>; initialPrompt: string
}
export interface OpenMontageCommitInput {
  trackId: string; projectId: string; stage: 'idea' | 'script' | 'scene_plan'
  artifact: Record<string, unknown>; expectedDigest: string | null
}
export interface OpenMontageApprovalInput {
  trackId: string; projectId: string; stage: 'idea' | 'script' | 'scene_plan'; expectedDigest: string
  humanApprovalEvidence: string
}
