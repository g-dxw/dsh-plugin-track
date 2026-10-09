import {describe, expect, it} from 'vitest'
import {FEATURED_TRAVEL_TEMPLATES} from '../src/track/featured-travel-templates.ts'
import {RESOURCE_TEMPLATE_LIMITS} from '../src/track/resource-templates.ts'
import {ETUBAO_TEMPLATE_SOURCES} from '../src/client/etubao-templates.ts'
describe('packaged travel template content and attribution', () => {
  it('offers distinct reusable travel styles without masquerading as saved personal records', () => {
    expect(FEATURED_TRAVEL_TEMPLATES.length).toBe(37)
    expect(new Set(FEATURED_TRAVEL_TEMPLATES.map(item=>item.key)).size).toBe(FEATURED_TRAVEL_TEMPLATES.length)
    expect(new Set(FEATURED_TRAVEL_TEMPLATES.map(item=>item.prompt)).size).toBe(FEATURED_TRAVEL_TEMPLATES.length)
    expect(new Set(FEATURED_TRAVEL_TEMPLATES.map(item=>item.category))).toEqual(new Set(['真实照片','旅行记录','艺术转绘','旅行封面','旅行纪念','路线表达']))
    for (const template of FEATURED_TRAVEL_TEMPLATES) {
      expect(template).not.toHaveProperty('id'); expect(template).not.toHaveProperty('version')
      expect(template.name.length).toBeLessThanOrEqual(RESOURCE_TEMPLATE_LIMITS.name)
      expect(template.prompt.length).toBeLessThanOrEqual(RESOURCE_TEMPLATE_LIMITS.prompt)
      expect(template.prompt.length).toBeGreaterThan(250)
      expect(template.tags.length).toBeLessThanOrEqual(RESOURCE_TEMPLATE_LIMITS.tags)
      expect(template.tags.every(tag=>tag.length<=RESOURCE_TEMPLATE_LIMITS.tag)).toBe(true)
      expect(template.referenceAdvice.trim()).not.toBe('')
      expect(template.preview.image.trim()).not.toBe('')
      expect(template.preview.caption).toContain('原案例效果参考')
    }
  })
  it('retains complete real-case provenance from the registered e图宝 sources', () => {
    for (const template of FEATURED_TRAVEL_TEMPLATES) {
      const origin=ETUBAO_TEMPLATE_SOURCES.find(item=>item.id===template.source.sourceId)
      expect(origin).toBeDefined(); expect(template.source.homepage).toBe(origin!.homepage)
      expect(template.source.kind).toBe('etubao'); expect(template.source.caseId.trim()).not.toBe('')
      expect(template.source.sourceLabel.trim()).not.toBe('')
      const url=new URL(template.source.sourceUrl || template.source.homepage); expect(url.protocol).toBe('https:'); expect(url.username).toBe(''); expect(url.password).toBe('')
      expect(url.hostname).not.toBe('example.com'); expect(template.source.caseId).not.toBe('reference-1')
    }
  })
  it('covers all requested source cases while retaining existing equivalents and truthful attribution', () => {
    const cases = ['433','405','401','369','359','331','307','304','298','279','246','223','211','9','531','528','524','523','497','489','479','474','464','408']
    for (const caseId of cases) expect(FEATURED_TRAVEL_TEMPLATES.filter(item => item.source.sourceId === 'canghe' && item.source.caseId === caseId)).toHaveLength(1)
    for (const caseId of ['405','359','211','528','524','479']) expect(FEATURED_TRAVEL_TEMPLATES.find(item => item.source.caseId === caseId)?.mode).toBe('edit')
    const layout = FEATURED_TRAVEL_TEMPLATES.find(item => item.source.caseId === '9')!
    expect(layout.source.sourceUrl).toBe('')
    expect(layout.source.sourceLabel).toBe('小红书号z890738050')
    for (const caseId of ['369','331']) {
      const item = FEATURED_TRAVEL_TEMPLATES.find(item => item.source.caseId === caseId)!
      expect(item.referenceAdvice).toMatch(/实际地图|坐标资料/)
      expect(item.prompt).toContain('不'); expect(item.prompt).toMatch(/导航/)
    }
    expect(FEATURED_TRAVEL_TEMPLATES.find(item => item.source.caseId === '211')!.prompt).toContain('不推断')
    expect(FEATURED_TRAVEL_TEMPLATES.find(item => item.source.caseId === '304')!.description + FEATURED_TRAVEL_TEMPLATES.find(item => item.source.caseId === '304')!.prompt).toContain('幻想')
  })
  it('does not advertise photo identity preservation or photo collage without an edit-mode gate', () => {
    for (const key of ['travel-natural-photo','travel-field-notes','travel-photo-vector','travel-watercolor-card','travel-photo-scrapbook','travel-enamel-badge','travel-archive-collage'])expect(FEATURED_TRAVEL_TEMPLATES.find(item=>item.key===key)?.mode).toBe('edit')
    expect(FEATURED_TRAVEL_TEMPLATES.filter(item=>item.mode==='both').length).toBeGreaterThan(0)
  })
  it('requires actual route evidence for map styles and leaves unspecified facts and text blank', () => {
    for (const key of ['travel-miniature-map','travel-route-comic']) {
      const template=FEATURED_TRAVEL_TEMPLATES.find(item=>item.key===key)!
      expect(template.referenceAdvice).toMatch(/实际路线图/); expect(template.prompt).toMatch(/不.*导航/)
    }
    for (const template of FEATURED_TRAVEL_TEMPLATES) {
      expect(template.prompt).toContain('未提供的文字留白'); expect(template.prompt).toContain('不猜地名')
      expect(template.prompt).toContain('效果参考图只用于'); expect(template.prompt).not.toMatch(/\{\{[^}]+\}\}|\[(?:CITY|COUNTRY|DATE|DESTINATION)[^\]]*\]/u)
      expect(template.prompt).not.toMatch(/生成.*(?:19岁|金发女郎)|Ghibli-inspired|8K masterpiece/u)
    }
  })
})
