import {afterEach, describe, expect, it, vi} from 'vitest'
import {etubaoTemplateImage, loadEtubaoTemplates} from '../src/client/etubao-templates.ts'
import {FEATURED_TRAVEL_TEMPLATES} from '../src/track/featured-travel-templates.ts'

afterEach(() => vi.unstubAllGlobals())
describe('e图宝 image references through the host service', () => {
  it('routes every curated example through its registered source, preserving full remote URLs', () => {
    for (const item of FEATURED_TRAVEL_TEMPLATES) {
      expect(item.preview.image).not.toBe('')
      expect(item.preview.caption).toContain('原案例效果参考')
      const image = etubaoTemplateImage(item.source.sourceId, item.preview)!
      expect(image).toMatch(/^\/api\/dsh-imagegen\/templates\/image\//u)
      expect(decodeURIComponent(image.split('/').at(-1)!)).toBe(item.preview.image)
      if (item.source.sourceId === 'canghe') expect(item.preview.image).toMatch(new RegExp('^case' + item.source.caseId + '\\.(?:jpg|jpeg|png|webp|gif)$', 'iu'))
    }
  })
  it('keeps community image query strings when parsing a host list', async () => {
    const remote = 'https://pbs.twimg.com/media/HQZhYWCa8AAXjj2?format=jpg&name=orig'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ok: true, sourceId: 'prompt-signal', cases: [{id: 'vector-travel', title: '旅行转绘', prompt: '保留旅行风景', image: remote}]}), {headers: {'content-type': 'application/json'}}))
    vi.stubGlobal('fetch', fetchMock)
    const list = await loadEtubaoTemplates('prompt-signal')
    expect(list[0].image).toBe(remote)
    expect(etubaoTemplateImage('prompt-signal', list[0])).toBe('/api/dsh-imagegen/templates/image/prompt-signal/' + encodeURIComponent(remote))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/dsh-imagegen/templates/list')
  })
  it('rejects unknown sources and unsafe image references before creating an image request', () => {
    expect(etubaoTemplateImage('unknown', {image: 'case431.jpg'})).toBeUndefined()
    for (const image of ['../case431.jpg', 'folder/case431.jpg', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://user:password@pbs.twimg.com/a.jpg', 'https://pbs.twimg.com:8443/a.jpg', 'http://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/../a.jpg']) {
      expect(etubaoTemplateImage('prompt-signal', {image}), image).toBeUndefined()
    }
  })
})
