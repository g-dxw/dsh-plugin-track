import {describe, expect, it, vi} from 'vitest'
import {addImageToTrackDraft, type TrackImageDraftAttachment, type TrackImageDraftService} from '../src/client/image-agent-draft.ts'

function fixture() {
  const scope = {sessionId: 'track-agent'}, other = {sessionId: 'other-agent'}
  const state = {draft: '已有问题和引用', attachmentIds: ['existing-image']}
  const input = {
    addAttachments: vi.fn((ids: readonly string[]) => {
      state.attachmentIds.push(...ids)
      return true
    }),
    setDraft: vi.fn(), submit: vi.fn(),
  }
  const attachment: TrackImageDraftAttachment = {kind: 'image', id: 'new-image'}
  const conversation: TrackImageDraftService = {
    input: {for: vi.fn((context: unknown) => {
      if (context !== scope) throw new Error('wrong session scope')
      return input
    })},
    createDrafts: vi.fn(() => [attachment]),
    releaseDraftAttachments: vi.fn(),
  }
  const sessions = {scope: vi.fn((id: string): unknown => id === 'track-agent' ? scope : other)}
  const file = new File(['image-bytes'], '线路图片.png', {type: 'image/png'})
  return {scope, state, input, attachment, conversation, sessions, file}
}

describe('Track native Agent image draft', () => {
  it('appends an image to the requested Session while preserving its text and existing attachments', () => {
    const f = fixture()
    expect(addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)).toBe('new-image')
    expect(f.sessions.scope).toHaveBeenCalledWith('track-agent')
    expect(f.conversation.input.for).toHaveBeenCalledWith(f.scope)
    expect(f.conversation.createDrafts).toHaveBeenCalledWith('track-agent', [f.file])
    expect(f.state).toEqual({draft: '已有问题和引用', attachmentIds: ['existing-image', 'new-image']})
    expect(f.input.setDraft).not.toHaveBeenCalled()
    expect(f.input.submit).not.toHaveBeenCalled()
    expect(f.conversation.releaseDraftAttachments).not.toHaveBeenCalled()
  })

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('admits the official image attachment type %s', type => {
    const f = fixture()
    addImageToTrackDraft(f.conversation, 'track-agent', new File(['bytes'], 'photo', {type}), f.sessions)
    expect(f.input.addAttachments).toHaveBeenCalledWith(['new-image'])
  })

  it.each(['image/avif', 'image/svg+xml', 'application/octet-stream', ''])('rejects %s before registering a file draft', type => {
    const f = fixture()
    expect(() => addImageToTrackDraft(f.conversation, 'track-agent', new File(['bytes'], 'photo', {type}), f.sessions)).toThrow('支持 PNG')
    expect(f.conversation.createDrafts).not.toHaveBeenCalled()
    expect(f.input.addAttachments).not.toHaveBeenCalled()
  })

  it('releases only the new runtime draft when the composer refuses admission', () => {
    const f = fixture()
    f.input.addAttachments.mockReturnValue(false)
    expect(() => addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)).toThrow('输入框正忙')
    expect(f.conversation.releaseDraftAttachments).toHaveBeenCalledExactlyOnceWith([f.attachment])
    expect(f.state).toEqual({draft: '已有问题和引用', attachmentIds: ['existing-image']})
  })

  it('releases the prepared image when the input operation throws', () => {
    const f = fixture()
    f.input.addAttachments.mockImplementation(() => {throw new Error('Session ended')})
    expect(() => addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)).toThrow('Session ended')
    expect(f.conversation.releaseDraftAttachments).toHaveBeenCalledExactlyOnceWith([f.attachment])
    expect(f.state.attachmentIds).toEqual(['existing-image'])
  })

  it('refuses an ended Session before allocating a preview URL', () => {
    const f = fixture()
    f.sessions.scope.mockReturnValue(undefined)
    expect(() => addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)).toThrow('对话已关闭')
    expect(f.conversation.input.for).not.toHaveBeenCalled()
    expect(f.conversation.createDrafts).not.toHaveBeenCalled()
  })

  it('does not cache a scope from a previous Session generation', () => {
    const f = fixture(), currentScope = {sessionId: 'track-agent', generation: 2}
    f.sessions.scope.mockReturnValue(currentScope)
    const resolve = vi.fn(() => f.input)
    f.conversation.input.for = resolve
    addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(currentScope)
  })

  it('does not allocate drafts if the retained scope is rejected by the official resolver', () => {
    const f = fixture()
    vi.mocked(f.conversation.input.for).mockImplementation(() => {throw new Error('retained Session scope required')})
    expect(() => addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)).toThrow('retained Session scope required')
    expect(f.conversation.createDrafts).not.toHaveBeenCalled()
  })

  it('rejects an unavailable Conversation service without touching the Session', () => {
    const f = fixture()
    expect(() => addImageToTrackDraft(undefined, 'track-agent', f.file, f.sessions)).toThrow('暂不支持')
    expect(f.sessions.scope).not.toHaveBeenCalled()
    expect(f.input.addAttachments).not.toHaveBeenCalled()
  })

  it('cleans up an unexpected non-image descriptor instead of adding a file reference', () => {
    const f = fixture(), fileDraft: TrackImageDraftAttachment = {kind: 'file', id: 'unexpected-file'}
    vi.mocked(f.conversation.createDrafts).mockReturnValue([fileDraft])
    expect(() => addImageToTrackDraft(f.conversation, 'track-agent', f.file, f.sessions)).toThrow('图片附件准备失败')
    expect(f.input.addAttachments).not.toHaveBeenCalled()
    expect(f.conversation.releaseDraftAttachments).toHaveBeenCalledExactlyOnceWith([fileDraft])
  })
})
