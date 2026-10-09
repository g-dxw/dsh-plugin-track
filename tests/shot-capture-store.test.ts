import {describe, expect, it} from 'vitest'
import {createShotCaptureStore} from '../src/client/shot-capture-store.ts'
import {freezeShotResult} from '../src/client/shot-result-bridge.tsx'

const scope = {projectId: 'project-a', shotId: 'shot-a', sceneId: 'SC03', scenePlanDigest: 'digest-a'}
describe('workspace owned captured video bytes', () => {
  it('keeps exact Blob and frozen identity across scopes without retaining object URLs', () => {
    const cache = createShotCaptureStore(), blob = new Blob(['actual frames']), identity = freezeShotResult('track-a', scope, 'revision-a', 'map')!
    cache.set({blob, identity, filename: 'map.webm'}); cache.updateUpload(identity, {status: '工程冲突，视频已保留', complete: false})
    expect(cache.get('track-a', scope, 'map')).toMatchObject({blob, identity, uploadState: {status: '工程冲突，视频已保留', complete: false}})
    expect(cache.get('track-a', {...scope, scenePlanDigest: 'new-digest'}, 'map')!.blob).toBe(blob)
    for (const different of [{trackId: 'track-b', scope}, {trackId: 'track-a', scope: {...scope, shotId: 'shot-b'}}, {trackId: 'track-a', scope: {...scope, projectId: 'project-b'}}]) expect(cache.get(different.trackId, different.scope, 'map')).toBeUndefined()
    expect(cache.get('track-a', scope, 'sandbox')).toBeUndefined(); expect(cache.get('track-a', scope, 'map')).not.toHaveProperty('url')
  })
  it('ignores stale result callbacks after a replacement capture and clears all Blob references on workspace exit', () => {
    const cache = createShotCaptureStore(), first = freezeShotResult('track-a', scope, 'revision-a', 'map')!, second = freezeShotResult('track-a', scope, 'revision-a', 'map')!
    cache.set({blob: new Blob(['first']), identity: first, filename: 'first.webm'})
    const blob = new Blob(['replacement']); cache.set({blob, identity: second, filename: 'second.webm'})
    cache.updateUpload(first, {status: '旧请求的错误', complete: false})
    expect(cache.get('track-a', scope, 'map')!.identity.takeId).toBe(second.takeId); expect(cache.get('track-a', scope, 'map')!.uploadState).toBeUndefined()
    cache.clear(); cache.updateUpload(second, {status: '迟到的结果', complete: true}); expect(cache.get('track-a', scope, 'map')).toBeUndefined()
  })
})
