import type {OpenMontageEditorScope} from '../track/shot-project-scope.ts'
import {shotProjectKey} from '../track/shot-project-scope.ts'
import type {ShotEditorProjectInput} from '../track/shot-editor-project-types.ts'
import type {ShotResultIdentity, ShotUploadState} from './shot-result-bridge.tsx'

export interface ScopedShotCapture {blob: Blob; filename: string; identity: ShotResultIdentity; saved?: ShotEditorProjectInput; uploadState?: ShotUploadState}
export interface ShotCaptureStore {
  get(trackId: string, scope: OpenMontageEditorScope, editor: 'map' | 'sandbox'): ScopedShotCapture | undefined
  set(capture: ScopedShotCapture): void
  updateUpload(identity: ShotResultIdentity, state: ShotUploadState): void
  clear(): void
}
/** Workspace-owned bytes outlive keyed editors. Object URLs are renderer-owned
 * and are always recreated on restore, then released by that editor's cleanup. */
export function createShotCaptureStore(): ShotCaptureStore {
  const captures = new Map<string, ScopedShotCapture>()
  const key = (trackId: string, scope: OpenMontageEditorScope, editor: string) => `${shotProjectKey(trackId, scope)}:${editor}`
  return {
    get: (trackId, scope, editor) => captures.get(key(trackId, scope, editor)),
    set: capture => {captures.set(key(capture.identity.trackId, capture.identity.scope, capture.identity.editor), capture)},
    updateUpload: (identity, state) => {
      const captureKey = key(identity.trackId, identity.scope, identity.editor), capture = captures.get(captureKey)
      if (capture?.identity.takeId === identity.takeId) captures.set(captureKey, {...capture, uploadState: {...state}})
    },
    clear: () => captures.clear(),
  }
}
