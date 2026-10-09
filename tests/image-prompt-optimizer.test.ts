// @vitest-environment jsdom
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ImagePromptOptimizer, type ImagePromptOptimizerProps} from '../src/client/ImagePromptOptimizer.tsx'
import {imagePromptContextFingerprint, type ImagePromptContext} from '../src/client/image-prompt-context.ts'
import {loadImagePromptModels, optimizeImagePrompt} from '../src/client/image-prompt-ai.ts'
vi.mock('../src/client/image-prompt-ai.ts', () => ({loadImagePromptModels: vi.fn(), optimizeImagePrompt: vi.fn()}))
let node: HTMLDivElement, root: Root, context: ImagePromptContext
const onClose = vi.fn(), onApply = vi.fn()
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
function button(text: string) {const value = [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!value) throw new Error(`Missing button ${text}`); return value}
async function click(text: string) {await act(async () => button(text).click())}
async function edit(label: string, value: string) {await act(async () => {const field = node.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', {bubbles: true}))})}
async function choose(value: string) {await act(async () => {const field = node.querySelector<HTMLSelectElement>('[aria-label="提示词优化模型"]')!; field.value = value; field.dispatchEvent(new Event('change', {bubbles: true}))})}
async function render(props: Partial<ImagePromptOptimizerProps> = {}) {await act(async () => root.render(createElement(ImagePromptOptimizer, {context, initialPrompt: '原模板原文', kind: 'template', onClose, onApply, ...props})))}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  context = {trackId: 'track-1', trackName: '山间旅程', prompt: '已有完整草稿', references: [{assetId: 'photo-2', role: 'subject', name: '背包', status: 'ready', updatedAt: '1'}, {assetId: 'photo-1', role: 'subject', name: '山景', status: 'ready', updatedAt: '1'}, {assetId: 'effect', role: 'effect', name: '色彩样图', status: 'ready', updatedAt: '1'}]}
  vi.mocked(loadImagePromptModels).mockResolvedValue({available: true, defaultModel: 'vision', models: [{id: 'text', label: '普通文本', supportsVision: false}, {id: 'vision', label: '已支持识图', supportsVision: true}]})
  vi.mocked(optimizeImagePrompt).mockResolvedValue({prompt: '结合山景与背包自然改善光线', changes: ['保留主体与场景', '只借鉴效果图的光影']})
  onApply.mockReturnValue(true); node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.useRealTimers()})
describe('explicit prompt optimization preview', () => {
  it('reads all current references with ordered roles, then applies only the manually accepted edited preview', async () => {
    const attribution = {name: '旅行模板', templateId: 'mine', templateVersion: 3}
    await render({attribution}); expect(optimizeImagePrompt).not.toHaveBeenCalled(); expect([...node.querySelectorAll('option')].map(item => item.textContent)).not.toContain('普通文本')
    await edit('提示词调整要求', '保持实际山脊，不新增建筑'); await click('优化提示词')
    expect(optimizeImagePrompt).toHaveBeenCalledWith('track-1', {model: 'vision', prompt: '原模板原文', requirements: '保持实际山脊，不新增建筑', references: [{assetId: 'photo-2', role: 'subject'}, {assetId: 'photo-1', role: 'subject'}, {assetId: 'effect', role: 'effect'}]}, expect.any(AbortSignal))
    expect(onApply).not.toHaveBeenCalled(); expect(node.textContent).toContain('只借鉴效果图的光影'); await edit('优化后的提示词', '  用户最后确认的文本\n  '); await click('应用到提示词')
    expect(onApply).toHaveBeenCalledWith('  用户最后确认的文本\n  ', imagePromptContextFingerprint(context), {...attribution, adapted: true}); expect(onClose).toHaveBeenCalledOnce()
  })
  it('requires explicit vision selection when the host default is a text-only model', async () => {
    vi.mocked(loadImagePromptModels).mockResolvedValue({available: true, defaultModel: 'text', models: [{id: 'text', label: '普通文本', supportsVision: false}, {id: 'vision', label: '已支持识图', supportsVision: true}]})
    await render(); expect(node.querySelector<HTMLSelectElement>('select')!.value).toBe(''); expect(button('优化提示词').disabled).toBe(true); await choose('vision'); expect(button('优化提示词').disabled).toBe(false); expect(optimizeImagePrompt).not.toHaveBeenCalled()
  })
  it('permits ordinary text models with no images and never silently drops missing or over-limit images', async () => {
    context.references = []; await render(); await choose('text'); await click('优化提示词'); expect(optimizeImagePrompt).toHaveBeenLastCalledWith('track-1', expect.objectContaining({model: 'text', references: []}), expect.any(AbortSignal))
    context = {...context, references: [{assetId: 'missing', role: 'effect', name: '已删除', status: 'missing'}]}; await render(); expect(button('重新优化').disabled).toBe(true); expect(node.textContent).toContain('已缺失或不可读取')
    context = {...context, references: Array.from({length: 6}, (_, index) => ({assetId: `image-${index}`, role: 'subject' as const, name: '图', status: 'ready' as const}))}; await render(); expect(node.textContent).toContain('不会自动省略图片'); expect(optimizeImagePrompt).toHaveBeenCalledOnce()
  })
  it('cancels pending requests and ignores a late success even when the transport ignores abort', async () => {
    const pending = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValue(pending.promise)
    await render(); await click('优化提示词'); const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!; await click('取消优化'); expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve({prompt: '迟到结果', changes: []})); expect(node.querySelector('[aria-label="优化后的提示词"]')).toBeNull(); expect(onApply).not.toHaveBeenCalled(); expect(button('应用到提示词').disabled).toBe(true)
  })
  it('aborts pending work when references change and never applies the old context result', async () => {
    const pending = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValue(pending.promise); await render(); await click('优化提示词')
    const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!; context = {...context, references: [...context.references].reverse()}; await render(); expect(signal.aborted).toBe(true); await act(async () => pending.resolve({prompt: '旧顺序结果', changes: []})); expect(button('应用到提示词').disabled).toBe(true); expect(onApply).not.toHaveBeenCalled()
  })
  it('marks a preview stale after prompt, reference role/name/status or requirements changes', async () => {
    await render(); await click('优化提示词'); context = {...context, prompt: '更新草稿', references: context.references.map((item, index) => index ? item : {...item, name: '新名称', role: 'effect'})}; await render(); expect(button('应用到提示词').disabled).toBe(true)
    await click('使用当前草稿与素材'); await click('优化提示词'); expect(button('应用到提示词').disabled).toBe(false); await edit('提示词调整要求', '新的要求'); expect(button('应用到提示词').disabled).toBe(true)
  })
  it('refreshes refinement from the current draft instead of silently using an old prompt', async () => {
    await render({kind: 'refine', initialPrompt: context.prompt}); context = {...context, prompt: '后来的提示词'}; await render({kind: 'refine', initialPrompt: '已有完整草稿'}); expect(button('优化提示词').disabled).toBe(true)
    await click('使用当前草稿与素材'); await click('优化提示词'); expect(optimizeImagePrompt).toHaveBeenLastCalledWith('track-1', expect.objectContaining({prompt: '后来的提示词'}), expect.any(AbortSignal))
  })
  it('retains the original on errors/canceled application and guards oversized edited output', async () => {
    vi.mocked(optimizeImagePrompt).mockRejectedValueOnce(new Error('模型服务错误')); await render(); await click('优化提示词'); expect(node.textContent).toContain('模型服务错误'); expect(onApply).not.toHaveBeenCalled()
    await click('优化提示词'); onApply.mockReturnValue(false); await click('应用到提示词'); expect(onClose).not.toHaveBeenCalled(); await edit('优化后的提示词', 'a'.repeat(20001)); expect(button('应用到提示词').disabled).toBe(true); expect(node.querySelector<HTMLTextAreaElement>('[aria-label="提示词调整要求"]')!.maxLength).toBe(4000)
  })
  it('aborts on unmount and supports Escape plus keyboard focus containment without application', async () => {
    const pending = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValue(pending.promise); await render(); await click('优化提示词'); const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!
    const dialog = node.querySelector<HTMLElement>('[role="dialog"]')!, last = button('取消优化'); last.focus(); await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true}))); expect(document.activeElement).toBe(button('关闭优化'))
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))); expect(onClose).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(true); expect(onApply).not.toHaveBeenCalled()
    await act(async () => root.render(null)); await act(async () => pending.resolve({prompt: '卸载后结果', changes: []})); expect(onApply).not.toHaveBeenCalled()
  })
})


describe('honest waiting feedback for slow prompt models', () => {
  const waiting = () => node.querySelector<HTMLElement>('[aria-label="提示词优化等待状态"]')
  async function advance(ms: number) {await act(async () => vi.advanceTimersByTimeAsync(ms))}
  it('continues beyond 60 seconds with actual elapsed time and accepts a 65-second response only after confirmation', async () => {
    vi.useFakeTimers(); const slow = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValue(slow.promise)
    await render(); await click('优化提示词'); const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!
    expect(waiting()?.textContent).toContain('已等待 0 秒'); expect(waiting()?.textContent).toContain('最多等待 5 分钟'); await advance(0); expect(vi.getTimerCount()).toBe(1)
    await advance(59_000); expect(waiting()?.textContent).toContain('已等待 59 秒'); expect(waiting()?.textContent).not.toContain('提示词优化仍在进行')
    await advance(6_000); expect(waiting()?.textContent).toContain('提示词优化仍在进行'); expect(waiting()?.textContent).toContain('已等待 1 分 5 秒'); expect(waiting()?.textContent).toContain('可随时取消，原提示词保留')
    expect(signal.aborted).toBe(false); expect(button('取消优化').disabled).toBe(false); expect(button('应用到提示词').disabled).toBe(true); expect(onApply).not.toHaveBeenCalled()
    await act(async () => slow.resolve({prompt: '65 秒后的完整建议', changes: ['完整读取全部参考图']}))
    expect(waiting()).toBeNull(); expect(vi.getTimerCount()).toBe(0); expect(node.querySelector('[aria-label="优化前提示词"]')?.textContent).toBe('原模板原文'); expect(onApply).not.toHaveBeenCalled()
    await click('应用到提示词'); expect(onApply).toHaveBeenCalledWith('65 秒后的完整建议', imagePromptContextFingerprint(context), undefined)
  })
  it('cancels a slow request, resets elapsed time for a retry and ignores its late result without clearing the new timer', async () => {
    vi.useFakeTimers(); const first = deferred<{prompt: string; changes: string[]}>(), second = deferred<{prompt: string; changes: string[]}>()
    vi.mocked(optimizeImagePrompt).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await render(); await click('优化提示词'); await advance(65_000); const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!
    await click('取消优化'); expect(signal.aborted).toBe(true); expect(waiting()).toBeNull(); expect(vi.getTimerCount()).toBe(0); expect(node.textContent).toContain('当前提示词未改动')
    await click('优化提示词'); expect(waiting()?.textContent).toContain('已等待 0 秒'); await advance(2_000)
    await act(async () => first.resolve({prompt: '已取消请求的迟到建议', changes: []})); expect(node.querySelector('[aria-label="优化后的提示词"]')).toBeNull(); expect(onApply).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1); expect(waiting()?.textContent).toContain('已等待 2 秒')
    await advance(1_000); expect(waiting()?.textContent).toContain('已等待 3 秒'); await act(async () => second.resolve({prompt: '本次有效建议', changes: []}))
    expect(vi.getTimerCount()).toBe(0); expect(node.querySelector<HTMLTextAreaElement>('[aria-label="优化后的提示词"]')?.value).toBe('本次有效建议'); await click('应用到提示词'); expect(onApply).toHaveBeenCalledWith('本次有效建议', imagePromptContextFingerprint(context), undefined)
  })
  it('shows waiting feedback while re-optimizing an existing preview and clears its timer on failure', async () => {
    vi.useFakeTimers(); await render(); await click('优化提示词'); const original = node.querySelector<HTMLTextAreaElement>('[aria-label="优化后的提示词"]')!.value
    const slow = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValueOnce(slow.promise); await click('重新优化')
    expect(waiting()?.textContent).toContain('已等待 0 秒'); expect(node.querySelector<HTMLTextAreaElement>('[aria-label="优化后的提示词"]')?.value).toBe(original); expect(node.querySelector<HTMLTextAreaElement>('[aria-label="优化后的提示词"]')?.disabled).toBe(true)
    await advance(65_000); expect(waiting()?.textContent).toContain('提示词优化仍在进行'); expect(waiting()?.textContent).toContain('已等待 1 分 5 秒'); expect(button('取消优化').disabled).toBe(false)
    await act(async () => slow.reject(new Error('模型服务错误'))); expect(waiting()).toBeNull(); expect(vi.getTimerCount()).toBe(0); expect(node.textContent).toContain('模型服务错误'); expect(node.querySelector<HTMLTextAreaElement>('[aria-label="优化后的提示词"]')?.value).toBe(original); expect(onApply).not.toHaveBeenCalled()
  })
  it('clears the stopwatch and aborts the request on unmount, ignoring a later transport success', async () => {
    vi.useFakeTimers(); const slow = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValue(slow.promise)
    await render(); await click('优化提示词'); await advance(29_000); const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!
    expect(waiting()?.textContent).toContain('已等待 29 秒'); await act(async () => root.render(null)); expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0)
    await advance(65_000); await act(async () => slow.resolve({prompt: '卸载后的迟到建议', changes: []})); expect(node.textContent).toBe(''); expect(onApply).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('clears the stopwatch when the source material changes and does not accept the old-context result', async () => {
    vi.useFakeTimers(); const slow = deferred<{prompt: string; changes: string[]}>(); vi.mocked(optimizeImagePrompt).mockReturnValue(slow.promise)
    await render(); await click('优化提示词'); await advance(65_000); const signal = vi.mocked(optimizeImagePrompt).mock.calls[0][2]!
    context = {...context, references: [...context.references].reverse()}; await render(); expect(signal.aborted).toBe(true); expect(waiting()).toBeNull(); expect(vi.getTimerCount()).toBe(0)
    await act(async () => slow.resolve({prompt: '旧素材结果', changes: []})); expect(node.querySelector('[aria-label="优化后的提示词"]')).toBeNull(); expect(onApply).not.toHaveBeenCalled()
  })
})
