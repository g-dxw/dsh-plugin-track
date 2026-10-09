// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createPlacemarkDetails, createPlacemarkGroupDetails, type PlacemarkDetailsOptions, type PlacemarkGroupDetailsOptions} from '../src/client/placemark-details.ts'
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
import {formatPlacemarkTime} from '../src/track/placemark-format.ts'
import type {PlacemarkGroup, TrackPlacemark} from '../src/protocol.ts'

const POINT: TrackPlacemark = {
  id: 'kml-1', name: '牧场', coordinates: [120, 30], description: '沿路的草地\n可停留看风景',
  images: ['https://example.com/one.jpg', 'http://example.com/two.jpg'],
}
const mounted: HTMLDivElement[] = []
function mount(point = POINT, close = vi.fn(), options: PlacemarkDetailsOptions = {}) {
  const details = createPlacemarkDetails(point, close, options)
  document.body.append(details)
  mounted.push(details)
  return details
}
function loadImage(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperties(image, {naturalWidth: {configurable: true, value: width}, naturalHeight: {configurable: true, value: height}})
  image.dispatchEvent(new Event('load'))
}

afterEach(() => {for (const details of mounted.splice(0)) details.remove()})

const GROUP:PlacemarkGroup={id:'group-11111111-1111-4111-8111-111111111111',name:'沿线风景',description:'组描述',coordinates:[121,31],memberIds:[POINT.id,'kml-2']}
const SECOND:TrackPlacemark={id:'kml-2',name:'山口',description:'山口说明',coordinates:[122,32],images:[POINT.images[0]],type:['营地'],elevation:200,time:1700000000000}
function mountGroup(points=[POINT,SECOND],options:PlacemarkGroupDetailsOptions={},group=GROUP) {
  const details=createPlacemarkGroupDetails(group,points,vi.fn(),options);document.body.append(details);mounted.push(details);return details
}
describe('group photo details',()=>{
  it('shows a shared location once while retaining the image and source child metadata',()=>{
    const location='位置：木马坳附近。',group={...GROUP,description:location}
    const point={...POINT,name:'木马坳',description:location,images:[POINT.images[0]],elevation:1456,time:1700000000000}
    const points=[point,SECOND],original=JSON.stringify({group,points})
    const details=mountGroup(points,{},group)
    expect([...details.querySelectorAll('.trk-placemark-details-description')].map(element=>element.textContent)).toEqual([location])
    expect(details.querySelector('img')?.src).toBe(POINT.images[0])
    expect(details.querySelector('.trk-placemark-details-member')?.textContent).toBe('木马坳')
    const metadata=details.querySelector('.trk-placemark-details-metadata')!
    expect(metadata.textContent).toContain('1456');expect(metadata.textContent).toContain(formatPlacemarkTime(point.time))
    expect(metadata.textContent).toContain('120.000000');expect(metadata.textContent).toContain('30.000000')
    expect(JSON.stringify({group,points})).toBe(original)
    expect(mount(point).querySelector('.trk-placemark-details-description')?.textContent).toBe(location)
  })

  it('retains unique child notes and recomputes shared locations when browsing different children',()=>{
    const location='位置：木马坳附近。',group={...GROUP,description:`组说明\n${location}`}
    const points=[{...POINT,images:[POINT.images[0]],description:`天气晴\n${location}\n岔路右转`},{...SECOND,description:'山口说明\n位置：山口附近。'}]
    const original=JSON.stringify({group,points}),details=mountGroup(points,{},group)
    const descriptions=()=>[...details.querySelectorAll('.trk-placemark-details-description')].map(element=>element.textContent)
    expect(descriptions()).toEqual([group.description,'天气晴\n岔路右转'])
    details.querySelector<HTMLButtonElement>('[aria-label="下一张组图片"]')!.click()
    expect(descriptions()).toEqual([group.description,points[1].description])
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(SECOND.id)
    expect(details.querySelector('.trk-placemark-details-metadata')?.textContent).toContain('122.000000')
    expect(details.querySelector('img')?.src).toBe(SECOND.images[0])
    details.querySelector<HTMLButtonElement>('[aria-label="上一张组图片"]')!.click()
    expect(descriptions()).toEqual([group.description,'天气晴\n岔路右转'])
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(POINT.id)
    expect(details.textContent).not.toContain('山口说明')
    expect(JSON.stringify({group,points})).toBe(original)
    expect(mount(points[0]).querySelector('.trk-placemark-details-description')?.textContent).toBe(points[0].description)
  })

  it.each([
    {group:'组说明\r\n 位置 : 木马坳附近。 \r\n',child:'\r\n位置：木马坳附近。\r\n点位说明',remaining:'点位说明'},
    {group:'位置： 木马坳附近。 ',child:'点位说明\r 位置 : 木马坳附近。 \r',remaining:'点位说明'},
    {group:'\r组说明\r位置：木马坳附近。\r',child:' 位置 : 木马坳附近。 ',remaining:''},
  ])('deduplicates independent location lines across whitespace, colons and line endings: $child',({group:description,child,remaining})=>{
    const group={...GROUP,description},points=[{...POINT,description:child},SECOND],original=JSON.stringify({group,points})
    const details=mountGroup(points,{},group)
    const paragraphs=[...details.querySelectorAll('.trk-placemark-details-description')].map(element=>element.textContent)
    expect(paragraphs[0]).toBe(description)
    if(remaining) expect(paragraphs[1]?.trim()).toBe(remaining)
    expect(paragraphs).toHaveLength(remaining?2:1)
    expect(JSON.stringify({group,points})).toBe(original)
  })

  it.each([
    {group:'位置：木马坳附近。',child:'位置：木马坳东侧。'},
    {group:'位置：木马坳附近。',child:'位置：木马坳附近.'},
    {group:'位置：木马坳附近。',child:'位置：木马 坳附近。'},
    {group:'位置：木马坳附近。',child:'补充说明：位置：木马坳附近。'},
    {group:'共同说明',child:'共同说明'},
    {group:'组说明',child:'  点位说明\r\n位置：木马坳附近。 \r\n'},
    {group:'位置：',child:'位置：木马坳附近。'},
  ])('preserves unmatched locations and ordinary descriptions exactly: $child',({group:description,child})=>{
    const details=mountGroup([{...POINT,description:child},SECOND],{},{...GROUP,description})
    expect([...details.querySelectorAll('.trk-placemark-details-description')].map(element=>element.textContent)).toEqual([description,child])
  })

  it('keeps group and child information in a separate region from carousel and actions after image loading',()=>{
    const details=mountGroup([{...POINT,description:'较长的子点说明\n'.repeat(40)},SECOND],{onViewImage:vi.fn(),onEdit:vi.fn()})
    const body=details.querySelector('.trk-placemark-details-body')!
    const info=body.querySelector('.trk-placemark-group-info-scroll')!
    expect([...body.children].map(element=>element.className)).toEqual(['trk-placemark-group-info-scroll','trk-placemark-details-carousel','trk-placemark-details-actions'])
    expect(info.querySelector('.trk-placemark-details-group-info')?.textContent).toContain('组描述')
    expect(info.querySelector('.trk-placemark-details-member')?.textContent).toBe(POINT.name)
    expect(info.querySelector('.trk-placemark-details-description')?.textContent).toContain('组描述')
    expect(info.querySelector('.trk-placemark-details-metadata')).not.toBeNull()
    expect(info.querySelector('button')).toBeNull()
    const image=details.querySelector('img')!
    Object.defineProperties(image,{naturalWidth:{value:1280},naturalHeight:{value:800}})
    image.dispatchEvent(new Event('load'))
    expect(details.querySelector('.trk-placemark-details-photo-ready')).not.toBeNull()
    expect(body.querySelector('[aria-label="下一张组图片"]')?.parentElement?.parentElement).toBe(body)
    expect(body.querySelector('.trk-placemark-details-view')?.parentElement?.parentElement).toBe(body)
    expect(body.querySelector('[aria-label="编辑标记组"]')?.parentElement?.parentElement).toBe(body)
    expect(mount().querySelector('.trk-placemark-group-info-scroll')).toBeNull()
  })

  it('retains separate actions and natural information structure for failed and missing group images',()=>{
    const failed=mountGroup([POINT,SECOND],{onViewImage:vi.fn(),onEdit:vi.fn()})
    failed.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(failed.querySelector('.trk-placemark-details-photo-ready')).toBeNull()
    expect(failed.querySelector('.trk-placemark-details-photo-overlay')).toBeNull()
    expect(failed.querySelector('.trk-placemark-group-info-scroll')?.querySelector('.trk-placemark-details-metadata')).not.toBeNull()
    expect(failed.querySelector('.trk-placemark-details-actions')?.parentElement?.className).toBe('trk-placemark-details-body')
    const empty=mountGroup([{...POINT,images:[]},{...SECOND,images:[]}],{onEdit:vi.fn()})
    expect(empty.querySelector('img,.trk-placemark-details-carousel')).toBeNull()
    expect(empty.querySelector('.trk-placemark-details-photo-overlay')).toBeNull()
    expect(empty.querySelector('.trk-placemark-details-empty')?.textContent).toBe('暂无图片')
    expect(empty.querySelector('.trk-placemark-group-info-scroll')?.textContent).toContain(POINT.description)
    expect(empty.querySelector('[aria-label="编辑标记组"]')?.parentElement?.parentElement?.className).toBe('trk-placemark-details-body')
  })

  it('changes group layout from a ready wide slide to a portrait overlay and back without losing carousel or viewer controls', () => {
    const changed = vi.fn(), view = vi.fn(), edit = vi.fn()
    const points = [{...POINT, images: [POINT.images[0]]}, {...SECOND, images: [POINT.images[1]]}]
    const original = JSON.stringify(points)
    const details = mountGroup(points, {onChangePhoto: changed, onViewImage: view, onEdit: edit, maxWidth: 420, maxHeight: 568})
    const assertControls = () => {
      const body = details.querySelector('.trk-placemark-details-body')!
      expect([...body.children].map(element => element.className)).toEqual(['trk-placemark-group-info-scroll', 'trk-placemark-details-carousel', 'trk-placemark-details-actions'])
      expect(body.querySelector('[aria-label="上一张组图片"]')).not.toBeNull()
      expect(body.querySelector('[aria-label="下一张组图片"]')).not.toBeNull()
      expect(body.querySelector('.trk-placemark-details-view')?.parentElement?.parentElement).toBe(body)
      expect(body.querySelector('[aria-label="编辑标记组"]')?.parentElement?.parentElement).toBe(body)
      expect(body.querySelector('.trk-placemark-group-info-scroll')?.textContent).toContain(GROUP.description)
    }
    const wide = details.querySelector('img')!
    loadImage(wide, 2400, 600)
    const first = details.querySelector<HTMLElement>('.trk-placemark-details')!
    expect(first.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(first.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    expect(first.style.width).toBe('420px'); expect(details.textContent).toContain('1 / 2'); assertControls()
    details.querySelector<HTMLButtonElement>('[aria-label="下一张组图片"]')!.click()
    expect(wide.isConnected).toBe(false)
    const portrait = details.querySelector('img')!, second = details.querySelector<HTMLElement>('.trk-placemark-details')!
    expect(second.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    loadImage(portrait, 1200, 2400)
    expect(second.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(second.classList.contains('trk-placemark-details-photo-overlay')).toBe(true)
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(SECOND.id)
    expect(details.textContent).toContain('2 / 2'); assertControls()
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-view')!.click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[1], 1)
    details.querySelector<HTMLButtonElement>('[aria-label="下一张组图片"]')!.click()
    const returned = details.querySelector<HTMLElement>('.trk-placemark-details')!
    expect(returned.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(returned.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    loadImage(details.querySelector('img')!, 2400, 600)
    expect(returned.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(returned.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(POINT.id)
    expect(details.textContent).toContain('1 / 2'); assertControls()
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-view')!.click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[0], 0)
    expect(changed.mock.calls.map(([photo]) => photo)).toEqual([{pointId: SECOND.id, url: POINT.images[1]}, {pointId: POINT.id, url: POINT.images[0]}])
    expect(JSON.stringify(points)).toBe(original)
  })

  it('chooses the cover by both source child and URL when two children share the same image',()=>{
    const details=createPlacemarkGroupDetails({...GROUP,cover:{pointId:SECOND.id,imageUrl:SECOND.images[0]}},[POINT,SECOND],vi.fn())
    document.body.append(details);mounted.push(details)
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(SECOND.id)
    expect(details.textContent).toContain('3 / 3')
  })
  it('shows one image and safe group metadata plus original child metadata, preserving duplicate URLs across children',()=>{
    const changed=vi.fn(),view=vi.fn()
    const details=mountGroup([{...POINT,type:['风景','营地']},SECOND],{onChangePhoto:changed,onViewImage:view})
    expect(details.querySelectorAll('img')).toHaveLength(1)
    expect(details.textContent).toContain('组描述');expect(details.textContent).toContain(POINT.description)
    expect(details.textContent).toContain('1 / 3')
    expect([...details.querySelectorAll('.trk-placemark-details-type')].map(element=>element.textContent)).toEqual(['风景','营地'])
    details.querySelector<HTMLButtonElement>('[aria-label="上一张组图片"]')!.click()
    expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(SECOND.id)
    expect(changed).toHaveBeenLastCalledWith({pointId:SECOND.id,url:POINT.images[0]},'上一张组图片')
    expect(details.textContent).toContain('122.000000');expect(details.textContent).not.toContain('121.000000')
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-view')!.click()
    expect(view).toHaveBeenCalledExactlyOnceWith(POINT.images[0],2)
  })
  it('continues navigation after image failure, supports retry and keyboard wrap without forwarding arrows',()=>{
    const details=mountGroup(),bubbled=vi.fn()
    details.parentElement!.addEventListener('keydown',bubbled)
    const old=details.querySelector('img')!;old.dispatchEvent(new Event('error'))
    expect(details.querySelector('[role="status"]')?.textContent).toContain('加载失败')
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-retry')!.click()
    expect(details.querySelector('img')).not.toBe(old)
    const event=new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true});details.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true);expect(bubbled).not.toHaveBeenCalled()
    expect(details.textContent).toContain('3 / 3')
    expect(details.querySelector('img')?.src).toBe(SECOND.images[0])
    details.parentElement!.removeEventListener('keydown',bubbled)
  })
  it('retains no-photo or hidden selected-child information and only changes child after navigation',()=>{
    for(const point of [{...POINT,images:[]},{...POINT,hidden:true}]){
      const details=mountGroup([point,SECOND],{selectedPointId:POINT.id,onEdit:vi.fn()})
      expect(details.querySelector('img')).toBeNull();expect(details.textContent).toContain(POINT.description)
      expect(details.querySelector('[aria-label="编辑标记组"]')).not.toBeNull()
      details.querySelector<HTMLButtonElement>('[aria-label="下一张组图片"]')!.click()
      expect(details.querySelector('[data-group-member-id]')?.getAttribute('data-group-member-id')).toBe(SECOND.id)
    }
  })
})

describe('point details opened from the map', () => {
  it('shows the name, description and every photo directly in a nonmodal dialog', () => {
    const details = mount()
    expect(details.getAttribute('role')).toBe('dialog')
    expect(details.getAttribute('aria-modal')).toBe('false')
    expect(details.getAttribute('aria-label')).toBe('点位详情：牧场')
    expect(details.querySelector('h4')?.textContent).toBe('牧场')
    expect(details.querySelector('.trk-placemark-details-description')?.textContent).toBe(POINT.description)
    const photos = [...details.querySelectorAll('img')]
    expect(photos.map(image => image.src)).toEqual(POINT.images)
    expect(photos.map(image => image.alt)).toEqual(['牧场 · 图片 1', '牧场 · 图片 2'])
    expect(photos.every(image => image.loading === 'lazy' && image.referrerPolicy === 'no-referrer')).toBe(true)
    expect(details.textContent).not.toContain('查看图片')
  })

  it('renders names and descriptions as literal text without creating imported HTML', () => {
    const details = mount({...POINT, name: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script><a href="javascript:alert(1)">说明</a>', images: []})
    expect(details.querySelector('h4')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(details.querySelector('.trk-placemark-details-description')?.textContent).toContain('<script>alert(1)</script>')
    expect(details.querySelector('script, a, img')).toBeNull()
  })

  it('rejects unsafe or credential-bearing photo URLs from legacy records', () => {
    const details = mount({...POINT, images: [
      'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///C:/private.jpg', '/relative.jpg',
      'https://user:password@example.com/private.jpg', 'https://example.com/safe.jpg', 'http://example.com/also-safe.jpg',
    ]})
    expect([...details.querySelectorAll('img')].map(image => image.src)).toEqual(['https://example.com/safe.jpg', 'http://example.com/also-safe.jpg'])
  })

  it('omits empty names and descriptions without invented captions', () => {
    const details = mount({...POINT, name: ' ', description: ' ', images: []})
    expect(details.querySelector('h4, .trk-placemark-details-description')).toBeNull()
    expect(details.textContent).not.toMatch(/暂无说明|未命名点位|标注点/u)
    expect(details.textContent).toContain('暂无图片')
    expect(details.querySelector('img')).toBeNull()
  })

  it('shows the no-photo state when all stored links are unsafe', () => {
    const details = mount({...POINT, images: ['javascript:alert(1)']})
    expect(details.textContent).toContain('暂无图片')
    expect(details.querySelector('img')).toBeNull()
    expect(details.classList.contains('trk-placemark-details-with-photos')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
  })

  it('isolates a failed image and retries just that photo', () => {
    const details = mount()
    const [first, second] = [...details.querySelectorAll('img')]
    first.dispatchEvent(new Event('error'))
    expect(details.querySelector('[role="status"]')?.textContent).toContain('图片 1 加载失败')
    expect(details.querySelectorAll('img')).toHaveLength(1)
    expect(details.querySelector('img')).toBe(second)
    details.querySelector<HTMLButtonElement>('[aria-label="重试图片 1"]')!.click()
    const retried = details.querySelector<HTMLImageElement>('.trk-placemark-details-photo img')!
    expect(retried).not.toBe(first)
    expect(retried.src).toBe(POINT.images[0])
    expect(details.querySelectorAll('img')).toHaveLength(2)
    expect(details.querySelectorAll('img')[1]).toBe(second)
    expect(details.querySelector('[role="status"]')).toBeNull()
    first.dispatchEvent(new Event('error'))
    expect(details.querySelector('.trk-placemark-details-photo img')).toBe(retried)
  })

  it('closes through the labelled close button', () => {
    const close = vi.fn()
    const details = mount(POINT, close)
    const button = details.querySelector<HTMLButtonElement>('[aria-label="关闭点位详情"]')!
    expect(button.type).toBe('button')
    button.click()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes on Escape from its controls without also forwarding Escape to the map', () => {
    const close = vi.fn(), bubbled = vi.fn()
    const details = mount(POINT, close)
    details.parentElement!.addEventListener('keydown', bubbled, {once: true})
    const button = details.querySelector('button')!
    const event = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
    button.dispatchEvent(event)
    expect(close).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).not.toHaveBeenCalled()
    details.parentElement!.removeEventListener('keydown', bubbled)
  })

  it('does not close for other keyboard input', () => {
    const close = vi.fn()
    const details = mount(POINT, close)
    details.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
    expect(close).not.toHaveBeenCalled()
  })

  it('places photos above the name, description and recorded metadata', () => {
    const time = Date.parse('2026-05-29T06:48:22Z')
    const details = mount({...POINT, elevation: 1234.56, time})
    const photos = details.querySelector('.trk-placemark-details-photos')!
    const body = details.querySelector('.trk-placemark-details-body')!
    expect(photos.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(details.querySelector('.trk-placemark-details-header')).toBeNull()
    expect(body.textContent).toContain('海拔 1235 m')
    expect(body.textContent).toContain(`时间 ${formatPlacemarkTime(time)}`)
    expect(body.textContent).toContain('经度 120.000000 · 纬度 30.000000')
  })

  it('omits unavailable height/time metadata while preserving measured sea level', () => {
    const unknown = mount({...POINT, elevation: null, time: null})
    expect(unknown.querySelector('.trk-placemark-details-metadata')?.textContent).not.toMatch(/海拔|时间/u)
    const seaLevel = mount({...POINT, elevation: 0, time: null})
    expect(seaLevel.querySelector('.trk-placemark-details-metadata')?.textContent).toContain('海拔 0 m')
  })

  it('suppresses the old generated numbered title when a source name was absent', () => {
    const details = mount({...POINT, id: 'kml-3', name: '标注点 3', description: '', elevation: undefined, time: undefined})
    expect(details.querySelector('h4')).toBeNull()
    expect(details.textContent).not.toContain('标注点 3')
  })

  it.each([
    {naturalWidth: 2000, naturalHeight: 1000, expectedWidth: 400},
    {naturalWidth: 1000, naturalHeight: 2000, expectedWidth: 120},
    {naturalWidth: 80, naturalHeight: 120, expectedWidth: 80},
  ])('fits first-photo proportions without enlarging a $naturalWidth × $naturalHeight image', ({naturalWidth, naturalHeight, expectedWidth}) => {
    const details = mount()
    const image = details.querySelector('img')!
    Object.defineProperties(image, {naturalWidth: {value: naturalWidth}, naturalHeight: {value: naturalHeight}})
    image.dispatchEvent(new Event('load'))
    expect(details.style.width).toBe(`${expectedWidth}px`)
    expect(image.style.width).toBe(`${expectedWidth}px`)
    expect(image.style.height).toBe('auto')
    expect(image.style.maxWidth).toBe('100%')
  })

  it('respects map-pane bounds and ignores a stale load after photo retry', () => {
    const details = mount(POINT, vi.fn(), {maxWidth: 300, maxHeight: 150})
    const image = details.querySelector('img')!
    image.dispatchEvent(new Event('error'))
    details.querySelector<HTMLButtonElement>('[aria-label="重试图片 1"]')!.click()
    Object.defineProperties(image, {naturalWidth: {value: 1200}, naturalHeight: {value: 800}})
    image.dispatchEvent(new Event('load'))
    expect(details.style.width).toBe('280px')
    const retry = details.querySelector('img')!
    Object.defineProperties(retry, {naturalWidth: {value: 1000}, naturalHeight: {value: 2000}})
    retry.dispatchEvent(new Event('load'))
    expect(details.style.width).toBe('75px')
  })

  it('opens the clicked photo or the first photo from the bottom viewer button', () => {
    const view = vi.fn()
    const details = mount(POINT, vi.fn(), {onViewImage: view})
    const photoButtons = [...details.querySelectorAll<HTMLButtonElement>('.trk-placemark-details-photo-button')]
    photoButtons[1].click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[1], 1)
    const bottom = details.querySelector<HTMLButtonElement>('.trk-placemark-details-view')!
    expect(bottom.textContent).toBe('查看大图')
    bottom.click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[0], 0)
  })

  it.each([
    {name: 'wide browser regression', width: 2400, height: 600, maxWidth: 420, maxHeight: 568, overlay: false, fittedWidth: 420},
    {name: 'portrait', width: 1200, height: 2400, maxWidth: 420, maxHeight: 568, overlay: true, fittedWidth: 284},
    {name: 'portrait in a short canvas', width: 1200, height: 2400, maxWidth: 420, maxHeight: 200, overlay: false, fittedWidth: 100},
    {name: 'just below 240 px', width: 840, height: 478, maxWidth: 420, maxHeight: 568, overlay: false, fittedWidth: 420},
    {name: 'exactly 240 px', width: 840, height: 480, maxWidth: 420, maxHeight: 568, overlay: true, fittedWidth: 420},
  ])('keeps readiness separate from the information overlay for $name', ({width, height, maxWidth, maxHeight, overlay, fittedWidth}) => {
    const view = vi.fn(), edit = vi.fn()
    const details = mount({...POINT, images: [POINT.images[0]]}, vi.fn(), {maxWidth, maxHeight, onViewImage: view, onEdit: edit})
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    loadImage(details.querySelector('img')!, width, height)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-loading')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(overlay)
    expect(parseFloat(details.style.width)).toBeCloseTo(fittedWidth, 6)
    expect(details.querySelector('.trk-placemark-details-body')?.textContent).toContain(POINT.description)
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-view')!.click()
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-edit')!.click()
    expect(view).toHaveBeenCalledExactlyOnceWith(POINT.images[0], 0); expect(edit).toHaveBeenCalledOnce()
  })

  it.each([
    {height: 600, overlay: false}, // 100 + 8 + 100 = 208 fitted CSS pixels.
    {height: 696, overlay: true}, // 116 + 8 + 116 = the 240 px threshold.
  ])('requires all images ready and counts their fitted heights plus the photo gap, height=$height', ({height, overlay}) => {
    const details = mount(POINT, vi.fn(), {maxWidth: 400, maxHeight: 568})
    const images = [...details.querySelectorAll('img')]
    loadImage(images[0], 2400, height)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    loadImage(images[1], 2400, height)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(overlay)
  })

  it('uses the first photo card width when estimating the rendered height of a wider second photo', () => {
    for (const secondHeight of [100, 180]) {
      const details = mount(POINT, vi.fn(), {maxWidth: 400, maxHeight: 568})
      const [first, second] = [...details.querySelectorAll('img')]
      loadImage(first, 100, 120); loadImage(second, 300, secondHeight)
      expect(details.style.width).toBe('100px'); expect(second.style.width).toBe('300px'); expect(second.style.maxWidth).toBe('100%')
      expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
      // The second image shrinks to the card's 100 px width. For height 180,
      // the uncorrected sum is 308 px, but its rendered sum is 120 + 60 + 8.
      expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    }
  })

  it('clears an overlay on failure and retry, then recomputes it from the retried image dimensions', () => {
    const details = mount({...POINT, images: [POINT.images[0]]}, vi.fn(), {maxWidth: 420, maxHeight: 568, onViewImage: vi.fn()})
    const tall = details.querySelector('img')!
    loadImage(tall, 1200, 2400)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(true)
    tall.dispatchEvent(new Event('error'))
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-error')).toBe(true)
    details.querySelector<HTMLButtonElement>('[aria-label="重试图片 1"]')!.click()
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-loading')).toBe(true)
    const wide = details.querySelector('img')!
    expect(wide).not.toBe(tall); loadImage(wide, 2400, 600)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-error')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    expect(details.style.width).toBe('420px')
    wide.dispatchEvent(new Event('error'))
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    details.querySelector<HTMLButtonElement>('[aria-label="重试图片 1"]')!.click()
    loadImage(details.querySelector('img')!, 1200, 2400)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(true)
    expect(parseFloat(details.style.width)).toBeCloseTo(284, 6)
  })

  it('marks tall loaded photo cards for information floating over the photo bottom', () => {
    const details = mount()
    expect(details.classList.contains('trk-placemark-details-with-photos')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-loading')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    const images = [...details.querySelectorAll('img')]
    for (const image of images) {
      Object.defineProperties(image, {naturalWidth: {value: 1280}, naturalHeight: {value: 2275}})
      image.dispatchEvent(new Event('load'))
    }
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-loading')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-error')).toBe(false)
    expect(details.querySelector('.trk-placemark-details-body')?.textContent).toContain(POINT.description)
  })

  it('keeps metadata in normal flow for a point with no photos', () => {
    const details = mount({...POINT, images: []})
    expect(details.classList.contains('trk-placemark-details-with-photos')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.querySelector('.trk-placemark-details-body')?.textContent).toContain('经度 120.000000')
    expect(details.querySelector('.trk-placemark-details-retry')).toBeNull()
  })

  it('disables the overlay while any photo fails or retries so retry controls stay accessible', () => {
    const details = mount(POINT, vi.fn(), {onViewImage: vi.fn()})
    const images = [...details.querySelectorAll('img')]
    for (const image of images) {
      Object.defineProperties(image, {naturalWidth: {value: 1280}, naturalHeight: {value: 2275}})
      image.dispatchEvent(new Event('load'))
    }
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(true)
    images[1].dispatchEvent(new Event('error'))
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-error')).toBe(true)
    const retry = details.querySelector<HTMLButtonElement>('[aria-label="重试图片 2"]')!
    expect(retry.disabled).toBe(false)
    expect(retry.closest('.trk-placemark-details-error')).not.toBeNull()
    retry.click()
    expect(details.classList.contains('trk-placemark-details-photo-error')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-loading')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(false)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(false)
    const retried = details.querySelectorAll('img')[1]
    Object.defineProperties(retried, {naturalWidth: {value: 1280}, naturalHeight: {value: 2275}})
    retried.dispatchEvent(new Event('load'))
    expect(details.classList.contains('trk-placemark-details-photo-ready')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-overlay')).toBe(true)
    expect(details.classList.contains('trk-placemark-details-photo-loading')).toBe(false)
  })

  it('keeps readonly details free of an edit control', () => {
    const details = mount(POINT, vi.fn(), {onViewImage: vi.fn()})
    expect(details.querySelector('.trk-placemark-details-edit')).toBeNull()
    expect(details.querySelector('.trk-placemark-details-actions')?.children).toHaveLength(1)
  })

  it('places edit beside the viewer action and stops edit clicks from reaching the map', () => {
    const edit = vi.fn(), view = vi.fn(), close = vi.fn(), bubbled = vi.fn()
    const details = mount(POINT, close, {onViewImage: view, onEdit: edit})
    details.parentElement!.addEventListener('click', bubbled)
    const actions = details.querySelector('.trk-placemark-details-actions')!
    expect([...actions.children].map(button => button.textContent)).toEqual(['查看大图', '编辑'])
    const button = actions.querySelector<HTMLButtonElement>('[aria-label="编辑点位"]')!
    expect(button.type).toBe('button')
    button.click()
    expect(edit).toHaveBeenCalledOnce()
    expect(view).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(bubbled).not.toHaveBeenCalled()
    details.parentElement!.removeEventListener('click', bubbled)
  })

  it('keeps edit available without a photo and disables it while an operation is pending', () => {
    const edit = vi.fn()
    const editable = mount({...POINT, images: []}, vi.fn(), {onEdit: edit})
    expect(editable.querySelector('.trk-placemark-details-view')).toBeNull()
    editable.querySelector<HTMLButtonElement>('.trk-placemark-details-edit')!.click()
    expect(edit).toHaveBeenCalledOnce()
    const pending = mount({...POINT, images: []}, vi.fn(), {onEdit: edit, editDisabled: true})
    const disabled = pending.querySelector<HTMLButtonElement>('.trk-placemark-details-edit')!
    expect(disabled.disabled).toBe(true)
    disabled.click()
    disabled.dispatchEvent(new MouseEvent('click', {bubbles: true}))
    expect(edit).toHaveBeenCalledOnce()
  })

  it('shows a nonempty type as literal badge text and omits whitespace-only types', () => {
    const typed = mount({...POINT, type: '  补给点 <script>  '})
    expect(typed.querySelector('.trk-placemark-details-type')?.textContent).toBe('补给点 <script>')
    expect(typed.querySelector('script')).toBeNull()
    expect(mount({...POINT, type: '  '}).querySelector('.trk-placemark-details-type')).toBeNull()
  })

  it('renders multiple normalized types as separate safe badges in selection order', () => {
    const details = mount({...POINT, type: [' 风景 ', ' 补给点 ', '风景', '', ' ', '<img src=x onerror=alert(1)>']})
    expect([...details.querySelectorAll('.trk-placemark-details-type')].map(badge => badge.textContent))
      .toEqual(['风景', '补给点', '<img src=x onerror=alert(1)>'])
    expect(details.querySelector('.trk-placemark-details-types')?.childElementCount).toBe(3)
    expect(details.querySelectorAll('img')).toHaveLength(POINT.images.length)
    expect(details.querySelector('[onerror]')).toBeNull()
  })

  it('keeps unnamed points untitled when they have multiple types and omits an empty type group', () => {
    const details = mount({...POINT, name: '', type: ['打卡点', '营地']})
    expect(details.querySelector('h4')).toBeNull()
    expect([...details.querySelectorAll('.trk-placemark-details-type')].map(badge => badge.textContent)).toEqual(['打卡点', '营地'])
    const cleared = mount({...POINT, type: []})
    expect(cleared.querySelector('.trk-placemark-details-types, .trk-placemark-details-type')).toBeNull()
  })
})


describe('cached map photo display',()=>{
  it('loads thumbnail assets and sends the raw photo identity to both large-image actions',()=>{
    const view=vi.fn(),details=mount(POINT,vi.fn(),{trackId:'track-1',onViewImage:view})
    expect(details.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',POINT.images[0]))
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-photo-button')!.click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[0],0)
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-view')!.click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[0],0)
  })
  it('keeps child ownership and raw URLs while navigating cached group slides',()=>{
    const view=vi.fn(),change=vi.fn(),details=mountGroup([POINT,SECOND],{trackId:'track-1',onViewImage:view,onChangePhoto:change})
    details.querySelector<HTMLButtonElement>('[aria-label="下一张组图片"]')!.click()
    expect(change).toHaveBeenLastCalledWith({pointId:POINT.id,url:POINT.images[1]},'下一张组图片')
    expect(details.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',POINT.images[1]))
    details.querySelector<HTMLButtonElement>('.trk-placemark-details-photo-button')!.click()
    expect(view).toHaveBeenLastCalledWith(POINT.images[1],1)
  })
})
