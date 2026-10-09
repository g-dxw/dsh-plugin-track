/** Structural boundary for the official DSH Conversation and Session services. */
export interface TrackImageDraftInput {
  /** Append attachment ids to the unsent composer; admission may refuse while busy. */
  addAttachments(ids: readonly string[]): boolean
}

export interface TrackImageDraftAttachment {
  readonly id: string
  readonly kind: 'image' | 'file'
}

export interface TrackImageDraftService {
  readonly input: {for(scope: unknown): TrackImageDraftInput}
  createDrafts(sessionId: string, files: readonly File[]): readonly TrackImageDraftAttachment[]
  releaseDraftAttachments(drafts: readonly TrackImageDraftAttachment[]): void
}

export interface TrackImageDraftSessions {
  /** Borrow the live, retained Agent Context through the official sessions.scope API. */
  scope(sessionId: string): unknown
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Append one image to an already opened Track Session's native composer.
 * The host owns the successful draft and its preview URL. Rejected drafts are
 * released here. Text, existing attachments, and submission remain host-owned.
 */
export function addImageToTrackDraft(
  conversation: TrackImageDraftService | undefined,
  sessionId: string,
  file: File,
  sessions: TrackImageDraftSessions,
): string {
  if (!IMAGE_MEDIA_TYPES.has(file.type)) throw new Error('Agent 图片附件支持 PNG、JPEG、WebP 或 GIF，请先转换图片格式')
  if (!conversation || typeof conversation.input?.for !== 'function'
    || typeof conversation.createDrafts !== 'function' || typeof conversation.releaseDraftAttachments !== 'function') {
    throw new Error('当前 Desktop 暂不支持添加 Agent 图片附件，请更新后重试')
  }
  const scope = sessions.scope(sessionId)
  if (!scope) throw new Error('Agent 对话已关闭，请重新打开后添加图片')
  // Resolve each request against the live Session generation, without a UI-slot cache.
  const input = conversation.input.for(scope)
  const drafts = conversation.createDrafts(sessionId, [file])
  let admitted = false
  try {
    if (drafts.length !== 1 || drafts[0].kind !== 'image') throw new Error('Agent 图片附件准备失败，请重试')
    admitted = input.addAttachments(drafts.map(draft => draft.id))
    if (!admitted) throw new Error('Agent 输入框正忙，请稍后再添加图片')
    return drafts[0].id
  } finally {
    if (!admitted) conversation.releaseDraftAttachments(drafts)
  }
}
