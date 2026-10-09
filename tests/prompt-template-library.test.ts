// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/resource-templates.ts', () => ({loadResourceTemplates: vi.fn(), saveResourceTemplate: vi.fn(), deleteResourceTemplate: vi.fn()}))
vi.mock('../src/client/etubao-templates.ts', async importOriginal => ({...await importOriginal<typeof import('../src/client/etubao-templates.ts')>(), loadEtubaoTemplates: vi.fn()}))
vi.mock('../src/track/featured-travel-templates.ts', () => ({FEATURED_TRAVEL_TEMPLATES: [
  {key: 'natural-travel', name: '旅行自然调色', prompt: '完整提示词：保留真实地点与人物，自然修复光线，不创造新的山峰。', category: '照片修复', tags: ['自然', '旅行'], mode: 'edit', description: '保留旅途景物与人物，调整曝光和色彩。', referenceAdvice: '上传真实照片作为主体参考图，可添加色调效果图。', preview: {image: 'travel-reference.png', caption: '原案例有纸页版式，这里只参考原照自然色彩。'}, source: {kind: 'etubao', sourceId: 'vibeui', caseId: 'travel-source', sourceLabel: '自然旅行原始案例', sourceUrl: 'https://example.com/travel-source', homepage: 'https://example.com/templates'}},
  {key: 'travel-poster', name: '旅行海报', prompt: '根据用户提供的地点与文字制作海报，不虚构路线信息。', category: '旅行设计', tags: ['海报'], mode: 'both', description: '把旅行素材组织为竖版海报。', referenceAdvice: '提供主体照片和可选版式效果图。', preview: {image: 'poster-reference.png', caption: '旅行海报原案例的文字与景物布局参考。'}, source: {kind: 'etubao', sourceId: 'vibeui', caseId: 'poster-source', sourceLabel: '海报原始案例', sourceUrl: 'https://example.com/poster-source', homepage: 'https://example.com/templates'}},
]}))
import { FEATURED_TRAVEL_TEMPLATES } from '../src/track/featured-travel-templates.ts'
import { PromptTemplateLibrary, type PromptTemplateLibraryProps } from '../src/client/PromptTemplateLibrary.tsx'
import { loadResourceTemplates, saveResourceTemplate } from '../src/client/resource-templates.ts'
import { loadEtubaoTemplates } from '../src/client/etubao-templates.ts'
import type { ResourcePromptTemplate } from '../src/track/resource-templates.ts'

let root: Root, node: HTMLDivElement
const onUse = vi.fn(), onClose = vi.fn()
const template: ResourcePromptTemplate = {id: 'personal', name: '照片修复', prompt: '保留地点与人物，自然修复曝光', category: '旅行', tags: [], mode: 'edit', version: 1, createdAt: '2026-10-05', updatedAt: '2026-10-05'}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks()
  vi.mocked(loadResourceTemplates).mockResolvedValue([])
  vi.mocked(loadEtubaoTemplates).mockResolvedValue([])
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals()})
async function render(props: Partial<PromptTemplateLibraryProps> = {}) {await act(async () => {root.render(createElement(PromptTemplateLibrary, {onUse, onClose, ...props}))})}
function button(text: string) {return [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!}
async function click(text: string) {await act(async () => button(text).click())}
const onOptimize = vi.fn()
describe('personal prompt templates and explicit reference browsing', () => {
  it('opens an empty library and does not fetch e图宝 until the reference tab is selected', async () => {
    await render({initialPrompt: '当前照片美化要求'})
    expect(node.textContent).toContain('还没有自己的模板')
    expect(loadEtubaoTemplates).not.toHaveBeenCalled()
    await click('保存当前提示词')
    expect(node.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('当前照片美化要求')
    expect(saveResourceTemplate).not.toHaveBeenCalled()
    await click('取消'); await click('参考 e图宝')
    expect(loadEtubaoTemplates).toHaveBeenCalledOnce()
    expect(loadEtubaoTemplates).toHaveBeenCalledWith('vibeui')
  })
  it('opens save-as with the current prompt while management remains a library list', async () => {
    await render({initialPrompt: '保留真实景色', initialCreate: true, currentMode: 'text'})
    expect(node.querySelector('form')).not.toBeNull()
    expect(node.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留真实景色')
    expect(node.querySelector<HTMLSelectElement>('select')!.value).toBe('text')
    expect(saveResourceTemplate).not.toHaveBeenCalled()
  })
  it('passes a saved template snapshot without changing the caller generation mode or reference photo', async () => {
    vi.mocked(loadResourceTemplates).mockResolvedValue([template])
    await render({currentMode: 'edit'})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-card')!.click())
    await click('填入提示词')
    expect(onUse).toHaveBeenCalledWith(template.prompt, template)
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('keeps the library open when the caller cancels replacing its draft', async () => {
    vi.mocked(loadResourceTemplates).mockResolvedValue([template])
    const rejectUse = vi.fn(() => false)
    await render({currentMode: 'edit', onUse: rejectUse})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-card')!.click())
    await click('填入提示词')
    expect(rejectUse).toHaveBeenCalledWith(template.prompt, template)
    expect(onClose).not.toHaveBeenCalled()
  })
  it('hands a personal template snapshot to optimization without applying or saving it', async () => {
    vi.mocked(loadResourceTemplates).mockResolvedValue([template]); await render({currentMode: 'text', onOptimizeUse: onOptimize}); await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-card')!.click()); await click('优化后使用')
    expect(onOptimize).toHaveBeenCalledWith(template.prompt, template, undefined); expect(onUse).not.toHaveBeenCalled(); expect(saveResourceTemplate).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce()
  })
  it('passes e图宝 text and author attribution for optimization, excluding the example image', async () => {
    vi.mocked(loadEtubaoTemplates).mockResolvedValue([{id: 'case', title: '自然旅行', prompt: '案例提示词', category: 'travel', categoryZh: '旅行', styles: [], scenes: [], sourceLabel: '作者案例', sourceUrl: 'https://example.com/author', image: 'sample.png'}]); await render({initialTab: 'reference', onOptimizeUse: onOptimize}); await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-card')!.click()); await click('优化后使用')
    expect(onOptimize).toHaveBeenCalledWith('案例提示词', undefined, expect.objectContaining({name: '自然旅行', source: expect.objectContaining({caseId: 'case', sourceUrl: 'https://example.com/author'})})); expect(JSON.stringify(onOptimize.mock.calls[0])).not.toContain('sample.png'); expect(onUse).not.toHaveBeenCalled(); expect(saveResourceTemplate).not.toHaveBeenCalled()
  })
  it('does not apply an edit-only template to text mode implicitly', async () => {
    vi.mocked(loadResourceTemplates).mockResolvedValue([template])
    await render({currentMode: 'text'})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-card')!.click())
    expect(button('填入提示词').disabled).toBe(true)
    expect(node.textContent).toContain('按当前素材优化后使用')
    expect(onUse).not.toHaveBeenCalled()
  })
})


describe('packaged featured travel templates', () => {
  it('offers offline curated content without loading or populating a personal library', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    await render({initialTab: 'featured'})
    expect([...node.querySelectorAll('[role=tab]')].map(item => item.textContent)).toEqual(['精选模板', '我的模板', '参考 e图宝'])
    expect(node.textContent).toContain('旅行自然调色')
    expect(node.textContent).toContain('旅行海报')
    expect(loadResourceTemplates).not.toHaveBeenCalled()
    expect(loadEtubaoTemplates).not.toHaveBeenCalled()
    expect(saveResourceTemplate).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    await click('我的模板')
    expect(loadResourceTemplates).toHaveBeenCalledOnce()
    expect(node.textContent).toContain('还没有自己的模板')
    await click('精选模板')
    expect(loadResourceTemplates).toHaveBeenCalledOnce()
    expect(loadEtubaoTemplates).not.toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
  })
  it('shows static case thumbnails and a complete selected reference without loading the remote gallery', async () => {
    const featured = FEATURED_TRAVEL_TEMPLATES[0]
    await render({initialTab: 'featured'})
    const thumbnails = node.querySelectorAll<HTMLImageElement>('.trk-template-featured-thumbnail')
    expect(thumbnails).toHaveLength(2)
    expect(thumbnails[0].getAttribute('src')).toBe('/api/dsh-imagegen/templates/image/vibeui/travel-reference.png')
    expect(thumbnails[0].getAttribute('loading')).toBe('lazy')
    expect(thumbnails[0].alt).toContain('原案例效果参考')
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-featured-card')!.click())
    const figure = node.querySelector<HTMLElement>('.trk-template-featured-preview')!
    expect(figure.textContent).toContain(featured.preview.caption)
    expect(figure.textContent).toContain('不会自动添加到主体或效果参考图')
    const largeLink = figure.querySelector<HTMLAnchorElement>('a')!
    expect(largeLink.textContent).toBe('查看大图')
    expect(largeLink.getAttribute('href')).toBe('/api/dsh-imagegen/templates/image/vibeui/travel-reference.png')
    expect(largeLink.target).toBe('_blank')
    expect(node.querySelector('.trk-template-featured-card button')).toBeNull()
    expect(node.querySelector('.trk-template-featured-card a')).toBeNull()
    expect(loadEtubaoTemplates).not.toHaveBeenCalled()
    expect(loadResourceTemplates).not.toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
    expect(saveResourceTemplate).not.toHaveBeenCalled()
  })
  it('offers nonblocking fallback and detail retry, then resets failure when switching selections', async () => {
    await render({initialTab: 'featured', currentMode: 'edit'})
    const cards = node.querySelectorAll<HTMLButtonElement>('.trk-template-featured-card')
    await act(async () => cards[0].querySelector('img')!.dispatchEvent(new Event('error')))
    expect(cards[0].textContent).toContain('参考图未能加载，提示词仍可使用')
    expect(cards[0].querySelector('button')).toBeNull()
    await act(async () => cards[0].click())
    const firstSrc = node.querySelector<HTMLImageElement>('.trk-template-featured-large')!.getAttribute('src')!
    await act(async () => node.querySelector('.trk-template-featured-large')!.dispatchEvent(new Event('error')))
    expect(node.querySelector('.trk-template-featured-preview')!.textContent).toContain('参考图未能加载，提示词仍可使用')
    expect(button('填入提示词').disabled).toBe(false)
    await click('重试参考图')
    expect(node.querySelector<HTMLImageElement>('.trk-template-featured-large')!.getAttribute('src')).toBe(firstSrc + '?retry=1')
    await act(async () => node.querySelector('.trk-template-featured-large')!.dispatchEvent(new Event('error')))
    await act(async () => cards[1].click())
    expect(node.querySelector<HTMLImageElement>('.trk-template-featured-large')!.getAttribute('src')).toContain('poster-reference.png')
    await act(async () => cards[0].click())
    expect(node.querySelector<HTMLImageElement>('.trk-template-featured-large')!.getAttribute('src')).toBe(firstSrc)
    expect([...node.querySelectorAll('button')].some(item => item.textContent === '重试参考图')).toBe(false)
  })
  it('shows the complete rewritten prompt and source before passing id-free attribution on fill', async () => {
    const featured = FEATURED_TRAVEL_TEMPLATES[0]
    await render({initialTab: 'featured', currentMode: 'edit'})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-featured-card')!.click())
    expect(node.querySelector('pre')!.textContent).toBe(featured.prompt)
    expect(node.textContent).toContain(featured.referenceAdvice)
    expect(node.textContent).toContain('提示词已作调整')
    expect(node.querySelector<HTMLAnchorElement>('.trk-template-attribution a')!.href).toBe(featured.source.sourceUrl)
    await click('填入提示词')
    expect(onUse).toHaveBeenCalledWith(featured.prompt, undefined, {name: featured.name, source: featured.source})
    expect(onClose).toHaveBeenCalledOnce()
    expect(saveResourceTemplate).not.toHaveBeenCalled()
    expect(loadResourceTemplates).not.toHaveBeenCalled()
  })
  it('gates incompatible direct fill while allowing explicit adaptation with source attribution', async () => {
    const featured = FEATURED_TRAVEL_TEMPLATES[0]
    await render({initialTab: 'featured', currentMode: 'text', onOptimizeUse: onOptimize})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-featured-card')!.click())
    expect(button('填入提示词').disabled).toBe(true)
    expect(button('优化后使用').disabled).toBe(false)
    await click('优化后使用')
    expect(onOptimize).toHaveBeenCalledWith(featured.prompt, undefined, {name: featured.name, source: featured.source})
    expect(JSON.stringify(onOptimize.mock.calls)).not.toContain(featured.preview.image)
    expect(onUse).not.toHaveBeenCalled()
    expect(saveResourceTemplate).not.toHaveBeenCalled()
    expect(loadResourceTemplates).not.toHaveBeenCalled()
  })
  it('requires a subject photo for direct use of photo templates even when effect references select edit mode', async () => {
    const featured = FEATURED_TRAVEL_TEMPLATES[0]
    await render({initialTab: 'featured', currentMode: 'edit', currentSubjectCount: 0, onOptimizeUse: onOptimize})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-featured-card')!.click())
    expect(button('填入提示词').disabled).toBe(true)
    expect(node.textContent).toContain('请添加主体参考图')
    expect(node.textContent).toContain('效果参考图不能代替主体照片')
    expect(node.textContent).toContain('转换为文字创作要求')
    expect(button('优化后使用').disabled).toBe(false)
    await click('优化后使用')
    expect(onOptimize).toHaveBeenCalledWith(featured.prompt, undefined, {name: featured.name, source: featured.source})
    expect(onUse).not.toHaveBeenCalled()
    await render({initialTab: 'featured', currentMode: 'edit', currentSubjectCount: 1, onOptimizeUse: onOptimize})
    expect(button('填入提示词').disabled).toBe(false)
    await click('填入提示词')
    expect(onUse).toHaveBeenCalledWith(featured.prompt, undefined, {name: featured.name, source: featured.source})
  })
  it('opens an id-free save-as editor and retains the original source without saving automatically', async () => {
    const featured = FEATURED_TRAVEL_TEMPLATES[0]
    await render({initialTab: 'featured'})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-featured-card')!.click())
    await click('修改并另存')
    expect(node.textContent).toContain('修改并另存为我的模板')
    expect(node.querySelector<HTMLInputElement>('input')!.value).toBe(featured.name)
    expect(node.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(featured.prompt)
    expect(node.querySelector<HTMLAnchorElement>('.trk-template-attribution a')!.href).toBe(featured.source.sourceUrl)
    expect(saveResourceTemplate).not.toHaveBeenCalled()
    expect(loadResourceTemplates).not.toHaveBeenCalled()
    await click('取消')
    expect(node.querySelectorAll('.trk-template-featured-card')).toHaveLength(2)
  })
  it('saves a curated copy as a new personal template without overwriting existing templates', async () => {
    const featured = FEATURED_TRAVEL_TEMPLATES[0]
    const saved: ResourcePromptTemplate = {...template, id: 'saved-featured', name: featured.name, prompt: featured.prompt, category: featured.category, tags: [...featured.tags], mode: featured.mode, source: featured.source}
    vi.mocked(saveResourceTemplate).mockResolvedValue(saved)
    vi.mocked(loadResourceTemplates).mockResolvedValue([template, saved])
    await render({initialTab: 'featured'})
    await act(async () => node.querySelector<HTMLButtonElement>('.trk-template-featured-card')!.click())
    await click('修改并另存')
    await act(async () => node.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})))
    expect(saveResourceTemplate).toHaveBeenCalledWith({name: featured.name, prompt: featured.prompt, category: featured.category, tags: [...featured.tags], mode: featured.mode, source: featured.source})
    expect(JSON.stringify(vi.mocked(saveResourceTemplate).mock.calls)).not.toContain(featured.preview.image)
    expect(vi.mocked(saveResourceTemplate).mock.calls[0][0]).not.toHaveProperty('id')
    expect(loadResourceTemplates).toHaveBeenCalledOnce()
    expect(node.querySelectorAll('.trk-template-card')).toHaveLength(2)
    expect(node.querySelector('[role=tab][aria-selected=true]')!.textContent).toBe('我的模板 · 2')
    expect(onUse).not.toHaveBeenCalled()
    await click('精选模板')
    expect(node.querySelectorAll('.trk-template-featured-card')).toHaveLength(2)
  })
  it('finds a rewritten template by wording from its original example caption', async () => {
    await render({initialTab: 'featured'})
    const search = node.querySelector<HTMLInputElement>('.trk-template-search input')!
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '纸页版式'); search.dispatchEvent(new Event('input', {bubbles: true}))})
    expect(node.querySelectorAll('.trk-template-featured-card')).toHaveLength(1)
    expect(node.querySelector('.trk-template-featured-card')!.textContent).toContain('旅行自然调色')
    expect(loadEtubaoTemplates).not.toHaveBeenCalled()
    expect(loadResourceTemplates).not.toHaveBeenCalled()
  })
  it('searches and filters curated categories without loading remote case collections', async () => {
    await render({initialTab: 'featured'})
    const search = node.querySelector<HTMLInputElement>('.trk-template-search input')!
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '海报'); search.dispatchEvent(new Event('input', {bubbles: true}))})
    expect(node.querySelectorAll('.trk-template-featured-card')).toHaveLength(1)
    expect(node.querySelector('.trk-template-featured-card')!.textContent).toContain('旅行海报')
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, ''); search.dispatchEvent(new Event('input', {bubbles: true}))})
    const category = node.querySelector<HTMLSelectElement>('select[aria-label="分类"]')!
    expect(category).not.toBeNull()
    await act(async () => {category.value = '照片修复'; category.dispatchEvent(new Event('change', {bubbles: true}))})
    expect(node.querySelectorAll('.trk-template-featured-card')).toHaveLength(1)
    expect(node.querySelector('.trk-template-featured-card')!.textContent).toContain('旅行自然调色')
    expect(loadEtubaoTemplates).not.toHaveBeenCalled()
    expect(loadResourceTemplates).not.toHaveBeenCalled()
  })
})
