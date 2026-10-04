// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { annotationPhotoLayouts, annotationVisible, annotationsFromPlacemarks, ART_TEXT_LABELS, artTextPosition, diagramCoordinates, diagramHeight, routeCanvasSvg, routeSvg, trackSvg, validateAnnotations, validateArtLayout, validateArtRouteTransform } from '../src/track/annotations.ts'
import type { TrackPoint } from '../src/protocol.ts'
const points: TrackPoint[] = [[119.4, 30.3, 500, null], [119.5, 30.4, null, null], [119.6, 30.35, 600, null]]
const annotations = [{id: 'poi-1', pointIndex: 1, label: '山口', color: '#7c3aed', visible: true}]

describe('independent route and outer text layers', () => {
  it('exports a transparent route without background, labels, endpoint circles or photos', () => {
    const document=new DOMParser().parseFromString(routeSvg(points,{theme:'dark'}),'image/svg+xml'),svg=document.documentElement
    expect(document.querySelector('parsererror')).toBeNull()
    expect(svg.matches('[data-route-layer]')).toBe(true)
    expect(svg.getAttribute('width')).toBe('1200')
    expect(svg.getAttribute('height')).toBe(String(diagramHeight(points)))
    expect([...svg.children].map(element=>element.localName)).toEqual(['title','desc','path'])
    expect(svg.querySelector('rect,circle,ellipse,text,image,[data-annotation-id]')).toBeNull()
    expect(svg.querySelector('path')?.getAttribute('stroke')).toBe('#ff8c7c')
    expect(()=>routeSvg(points.slice(0,1))).toThrow('至少需要 2 个点')
  })
  it('places every marker, photo, connector, endpoint and text outside the route SVG', () => {
    const item={...annotations[0],photo:{dataUrl:'data:image/png;base64,AAAA'}}
    const document=new DOMParser().parseFromString(trackSvg(points,{name:'图层',annotations:[item]}),'image/svg+xml'),scene=document.documentElement,route=scene.querySelector('[data-route-layer]')!
    expect(scene.matches('[data-art-scene]')).toBe(true)
    expect(route.parentElement?.matches('[data-route-transform]')).toBe(true)
    expect(route.parentElement?.parentElement).toBe(scene)
    expect(route.querySelectorAll('path')).toHaveLength(1)
    expect(route.querySelector('[data-annotation-id],[data-photo-id],[data-connector-id],[data-art-text-id],text,circle,ellipse')).toBeNull()
    for(const layer of ['annotations','photos','connectors']) {
      const element=scene.querySelector(`[data-art-layer="${layer}"]`)!
      expect(element.parentElement).toBe(scene.querySelector('[data-route-annotations]'))
      expect(element.children.length).toBeGreaterThan(0)
    }
    expect(scene.querySelector('[data-art-layer="endpoints"]')?.parentElement).toBe(route.parentElement)
    expect([...scene.querySelectorAll('[data-art-text-id]')].map(element=>element.getAttribute('data-art-text-id')).sort()).toEqual(ART_TEXT_LABELS.map(item=>item.id).sort())
    for(const id of ['start','end'])expect(scene.querySelector(`[data-art-text-id="${id}"]`)?.parentElement).toBe(scene.querySelector('[data-route-annotations]'))
    for(const id of ['title','north'])expect(scene.querySelector(`[data-art-text-id="${id}"]`)?.parentElement).toBe(scene)
  })
  it('retains old default anchors and applies independent text positions without group transforms', () => {
    const pixels=diagramCoordinates(points),layout={title:{x:240,y:160},start:{x:320,y:340},end:{x:480,y:520},north:{x:120,y:740}}
    expect(artTextPosition('title',points,annotations)).toEqual([50,62])
    expect(artTextPosition('start',points,annotations)).toEqual([pixels[0][0]+14,pixels[0][1]+25])
    expect(artTextPosition('end',points,annotations)).toEqual([pixels[2][0]-14,pixels[2][1]+43])
    expect(artTextPosition('north',points,annotations)).toEqual([50,diagramHeight(points)-24])
    const before=structuredClone(layout),document=new DOMParser().parseFromString(trackSvg(points,{name:'标题',annotations,layout}),'image/svg+xml')
    for(const item of ART_TEXT_LABELS) {
      expect(artTextPosition(item.id,points,annotations,layout)).toEqual([layout[item.id].x,layout[item.id].y])
      const group=document.querySelector(`[data-art-text-id="${item.id}"]`)!
      expect(group.hasAttribute('transform')).toBe(false)
      expect(group.querySelector('text')?.getAttribute('x')).toBe(String(layout[item.id].x))
      expect(group.querySelector('text')?.getAttribute('y')).toBe(String(layout[item.id].y))
    }
    expect(document.querySelector('[data-art-text-id="title"] text:nth-of-type(2)')?.getAttribute('y')).toBe('192')
    expect(layout).toEqual(before)
  })
  it('provides text hit targets and selection only on the editing canvas', () => {
    const editing=new DOMParser().parseFromString(trackSvg(points,{name:'交互文字',interactive:true,selectedTextId:'title'}),'image/svg+xml')
    for(const item of ART_TEXT_LABELS) {
      const group=editing.querySelector(`[data-art-text-id="${item.id}"]`)!
      expect(group.getAttribute('tabindex')).toBe('0')
      expect(group.getAttribute('role')).toBe('button')
      expect(group.getAttribute('aria-label')).toBe(`移动${item.label}`)
      expect(group.querySelector('[data-art-text-hit]')?.getAttribute('fill')).toBe('transparent')
    }
    expect(editing.querySelectorAll('[data-art-text-hit][stroke]')).toHaveLength(1)
    const exported=new DOMParser().parseFromString(trackSvg(points,{name:'导出文字',selectedTextId:'title'}),'image/svg+xml')
    expect(exported.querySelector('[data-art-text-hit]')).toBeNull()
    expect(exported.querySelector('[data-art-text-id][role]')).toBeNull()
    expect(exported.querySelector('[data-art-text-id="title"] text')?.textContent).toBe('导出文字')
  })
  it('expands the outer scene for moved labels without resizing or moving the geographic route', () => {
    const original=new DOMParser().parseFromString(trackSvg(points,{name:'原图'}),'image/svg+xml'),moved=new DOMParser().parseFromString(trackSvg(points,{name:'改图',layout:{title:{x:100,y:4000}}}),'image/svg+xml')
    expect(moved.documentElement.getAttribute('height')).toBe('4056')
    expect(moved.querySelector('[data-route-layer]')?.getAttribute('height')).toBe(original.querySelector('[data-route-layer]')?.getAttribute('height'))
    expect(moved.querySelector('[data-route]')?.getAttribute('d')).toBe(original.querySelector('[data-route]')?.getAttribute('d'))
    expect(moved.querySelector('[data-art-text-id="north"] text')?.getAttribute('y')).toBe('4032')
  })
  it('validates only known text positions and clones valid layouts', () => {
    expect(validateArtLayout(undefined)).toEqual({})
    expect(validateArtLayout({})).toEqual({})
    const layout={title:{x:0,y:0},north:{x:1200,y:9000}},restored=validateArtLayout(layout)
    expect(restored).toEqual(layout)
    expect(restored).not.toBe(layout)
    expect(restored.title).not.toBe(layout.title)
    for(const invalid of [null,[],1,'title',new Date(),{unknown:{x:1,y:2}},{title:null},{title:[]},{title:{x:1}},{title:{x:1,y:2,extra:3}},{title:{x:NaN,y:2}},{title:{x:1,y:Infinity}},{title:{x:-1,y:2}},{title:{x:1201,y:2}},{title:{x:1,y:-1}},{title:{x:1,y:9001}},{title:{x:'1',y:2}}])expect(()=>validateArtLayout(invalid)).toThrow()
    expect(()=>trackSvg(points,{name:'布局',layout:{title:{x:Infinity,y:1}}})).toThrow('画布文字位置无效')
  })
})

describe('route camera with synchronized point overlays and fixed headings', () => {
  it('exports a live route-only canvas with geographic endpoint symbols and no artwork labels', () => {
    const document=new DOMParser().parseFromString(routeCanvasSvg(points,{theme:'dark'}),'image/svg+xml'),svg=document.documentElement
    expect(document.querySelector('parsererror')).toBeNull()
    expect(svg.matches('[data-route-layer]')).toBe(true)
    expect(svg.querySelectorAll('[data-route]')).toHaveLength(1)
    expect(svg.querySelector('[data-art-layer="endpoints"] circle')).not.toBeNull()
    expect(svg.querySelector('[data-art-layer="endpoints"] ellipse')).not.toBeNull()
    expect(svg.querySelector('rect,text,image,[data-art-text-id],[data-photo-id],[data-annotation-id],[data-connector-id]')).toBeNull()
    expect(svg.querySelector('[data-art-layer="endpoints"] circle')?.getAttribute('stroke')).toBe('#171d23')
    expect(svg.getAttribute('height')).toBe(String(diagramHeight(points)))
    expect(()=>routeCanvasSvg([])).toThrow('至少需要 2 个点')
  })
  it('keeps points, photos, connectors and endpoint text synchronized with the route in exports', () => {
    const item={...annotations[0],photo:{dataUrl:'data:image/png;base64,AAAA',x:80,y:180}},layout={title:{x:120,y:100}},route={x:40,y:-25,scale:1.5},before=structuredClone({item,layout,route})
    const original=new DOMParser().parseFromString(trackSvg(points,{name:'固定外层',annotations:[item],layout}),'image/svg+xml'),moved=new DOMParser().parseFromString(trackSvg(points,{name:'固定外层',annotations:[item],layout,route}),'image/svg+xml')
    const transformed=moved.querySelector('[data-route-transform]')!
    expect(transformed.getAttribute('transform')).toBe('translate(60 -37.5) scale(1.5)')
    expect(transformed.querySelector('[data-route-layer]')).not.toBeNull()
    expect(transformed.querySelector('[data-art-layer="endpoints"]')).not.toBeNull()
    expect(transformed.querySelector('[data-photo-id],[data-annotation-id],[data-connector-id],[data-art-text-id]')).toBeNull()
    expect(moved.documentElement.getAttribute('height')).toBe(original.documentElement.getAttribute('height'))
    expect(moved.querySelector('[data-route]')?.getAttribute('d')).toBe(original.querySelector('[data-route]')?.getAttribute('d'))
    const associated=moved.querySelector('[data-route-annotations]')!
    expect(associated.getAttribute('transform')).toBe(transformed.getAttribute('transform'))
    expect(associated.parentElement).toBe(moved.documentElement)
    expect(associated.closest('[data-route-transform]')).toBeNull()
    for(const selector of ['[data-art-layer="connectors"]','[data-art-layer="photos"]','[data-art-layer="annotations"]','[data-art-text-id="start"]','[data-art-text-id="end"]']) {
      expect(moved.querySelector(selector)?.outerHTML).toBe(original.querySelector(selector)?.outerHTML)
      expect(moved.querySelector(selector)?.parentElement).toBe(associated)
    }
    for(const selector of ['[data-art-layer="background"]','[data-art-text-id="title"]','[data-art-text-id="north"]']) {
      expect(moved.querySelector(selector)?.outerHTML).toBe(original.querySelector(selector)?.outerHTML)
      expect(moved.querySelector(selector)?.parentElement).toBe(moved.documentElement)
    }
    expect({item,layout,route}).toEqual(before)
  })
  it('exports an independent transparent live overlay without route or endpoint symbols', () => {
    const item={...annotations[0],photo:{dataUrl:'data:image/png;base64,AAAA'}},route={x:200,y:300,scale:2}
    const all=new DOMParser().parseFromString(trackSvg(points,{name:'独立外层',annotations:[item],route,interactive:true}),'image/svg+xml'),overlay=new DOMParser().parseFromString(trackSvg(points,{name:'独立外层',annotations:[item],route,layer:'overlay',interactive:true}),'image/svg+xml'),background=overlay.querySelector('[data-art-layer="background"]')!
    expect(overlay.documentElement.matches('[data-art-scene]')).toBe(true)
    expect(overlay.querySelector('[data-route-transform],[data-route-layer],[data-route],[data-art-layer="endpoints"]')).toBeNull()
    expect(overlay.querySelector('[data-route-annotations]')?.getAttribute('transform')).toBe('translate(400 600) scale(2)')
    expect(background.getAttribute('fill')).toBe('transparent')
    expect(background.getAttribute('pointer-events')).toBe('all')
    expect(background.getAttribute('height')).toBe(overlay.documentElement.getAttribute('height'))
    expect(overlay.documentElement.getAttribute('height')).toBe(all.documentElement.getAttribute('height'))
    for(const selector of ['[data-art-layer="connectors"]','[data-art-layer="photos"]','[data-art-layer="annotations"]',...ART_TEXT_LABELS.map(item=>`[data-art-text-id="${item.id}"]`)])expect(overlay.querySelector(selector)?.outerHTML).toBe(all.querySelector(selector)?.outerHTML)
  })
  it('preserves endpoint label offsets and connector attachment under camera translation and scaling', () => {
    const item={...annotations[0],photo:{dataUrl:'data:image/png;base64,AAAA',x:80,y:180}},pixels=diagramCoordinates(points)
    // Apply the SVG ancestor transforms to actual rendered coordinate attributes.
    function displayed(element:Element,x:number,y:number):[number,number] {
      for(let parent=element.parentElement;parent;parent=parent.parentElement) {
        const match=parent.getAttribute('transform')?.match(/^translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)$/u)
        if(match){x=x*Number(match[3])+Number(match[1]);y=y*Number(match[3])+Number(match[2])}
      }
      return [x,y]
    }
    const position=(element:Element,xAttribute:string,yAttribute:string)=>displayed(element,Number(element.getAttribute(xAttribute)),Number(element.getAttribute(yAttribute)))
    for(const route of [{x:40,y:-25,scale:1.5},{x:-80,y:120,scale:.75},{x:25,y:30,scale:4}]) {
      const document=new DOMParser().parseFromString(trackSvg(points,{name:'关联位置信息',annotations:[item],route}),'image/svg+xml')
      const start=position(document.querySelector('[data-art-layer="endpoints"] circle')!,'cx','cy'),end=position(document.querySelector('[data-art-layer="endpoints"] ellipse')!,'cx','cy')
      const startLabel=position(document.querySelector('[data-art-text-id="start"] text')!,'x','y'),endLabel=position(document.querySelector('[data-art-text-id="end"] text')!,'x','y')
      expect(startLabel[0]-start[0]).toBeCloseTo(14*route.scale,1);expect(startLabel[1]-start[1]).toBeCloseTo(25*route.scale,1)
      expect(endLabel[0]-end[0]).toBeCloseTo(-14*route.scale,1);expect(endLabel[1]-end[1]).toBeCloseTo(43*route.scale,1)
      const marker=position(document.querySelector('[data-annotation-id="poi-1"] circle')!,'cx','cy'),photo=position(document.querySelector('[data-photo-id="poi-1"] rect')!,'x','y')
      expect(marker[0]).toBeCloseTo((pixels[1][0]+route.x)*route.scale,1);expect(marker[1]).toBeCloseTo((pixels[1][1]+route.y)*route.scale,1)
      expect(photo).toEqual([(80+route.x)*route.scale,(180+route.y)*route.scale])
      const connector=document.querySelector('[data-connector-id="poi-1"]')!,ends=[...connector.getAttribute('d')!.matchAll(/[ML]([-\d.]+),([-\d.]+)/gu)].map(match=>displayed(connector,Number(match[1]),Number(match[2])))
      expect(ends[0]).toEqual(marker)
      expect(ends[1][0]).toBeGreaterThanOrEqual(photo[0]);expect(ends[1][0]).toBeLessThanOrEqual(photo[0]+320*route.scale)
      expect(ends[1][1]).toBeGreaterThanOrEqual(photo[1]);expect(ends[1][1]).toBeLessThanOrEqual(photo[1]+200*route.scale)
      expect(position(document.querySelector('[data-art-text-id="title"] text')!,'x','y')).toEqual([50,62])
      expect(position(document.querySelector('[data-art-text-id="north"] text')!,'x','y')).toEqual([50,diagramHeight(points)-24])
    }
  })
  it('validates complete bounded route transforms without accepting invalid or extra values', () => {
    expect(validateArtRouteTransform(undefined)).toEqual({x:0,y:0,scale:1})
    const valid={x:-10000,y:10000,scale:.25},restored=validateArtRouteTransform(valid)
    expect(restored).toEqual(valid)
    expect(restored).not.toBe(valid)
    expect(validateArtRouteTransform({x:10000,y:-10000,scale:4})).toEqual({x:10000,y:-10000,scale:4})
    for(const invalid of [null,[],1,'route',new Date(),{}, {x:0,y:0},{x:0,scale:1},{y:0,scale:1},{x:0,y:0,scale:1,extra:1},{x:NaN,y:0,scale:1},{x:0,y:Infinity,scale:1},{x:0,y:0,scale:NaN},{x:-10001,y:0,scale:1},{x:0,y:10001,scale:1},{x:0,y:0,scale:.249},{x:0,y:0,scale:4.001},{x:'0',y:0,scale:1}])expect(()=>validateArtRouteTransform(invalid)).toThrow('轨迹图层变换无效')
    expect(()=>trackSvg(points,{name:'变换',route:{x:0,y:0,scale:Infinity}})).toThrow('轨迹图层变换无效')
  })
})

describe('annotated SVG exports', () => {
  it('creates an editable canvas label for an unnamed imported photo point', () => {
    const point={id:'kml-1',name:'',description:'',coordinates:[119.5,30.4] as [number,number],images:['https://example.com/photo.jpg'],elevation:500,time:null}
    const imported=annotationsFromPlacemarks([point],points)
    expect(imported[0].label).toBe('点位 1')
    expect(validateAnnotations(imported,points.length)).toHaveLength(1)
    expect(imported[0].imageUrls).toEqual(point.images)
    expect(point.name).toBe('')
  })
  it('escapes names and labels as text rather than executable markup', () => {
    const svg = trackSvg(points, {name: '<script>alert(1)</script>', annotations: [{...annotations[0], label: '<image href="https://evil.example"/>'}]})
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.querySelector('script,image,foreignObject')).toBeNull()
    expect(document.querySelector('title')?.textContent).toContain('<script>')
    expect(document.querySelector('[data-annotation-id]')?.getAttribute('aria-label')).toContain('<image href="https://evil.example"/>')
  })
  it('exports a self-contained route, endpoints and numbered annotation legend', () => {
    const svg = trackSvg(points, {name: '天目山', annotations, mode: 'points'})
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(document.querySelector('path')?.getAttribute('d')).toMatch(/^M.*L.*L/u)
    expect(document.querySelector('[data-annotation-id="poi-1"] circle')).not.toBeNull()
    expect(document.documentElement.textContent).toContain('起点')
    expect(document.documentElement.textContent).toContain('终点')
    expect(document.documentElement.textContent).toContain('山口')
    expect(svg).not.toContain('href=')
  })
  it('does not mutate the measured tuples when rendering a styled map', () => {
    const original = structuredClone(points)
    for (const theme of ['light', 'dark', 'paper'] as const) expect(trackSvg(points, {name: '轨迹', annotations, theme})).toContain('<svg')
    expect(points).toEqual(original)
  })
  it('unwraps date-line crossings into a short continuous diagram', () => {
    const svg = trackSvg([[179.9, 30, null, null], [-179.9, 30, null, null]], {name: '跨日界线'})
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const path = document.querySelector('path')!.getAttribute('d')!
    const positions = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/gu)].map(match => [Number(match[1]), Number(match[2])])
    expect(positions).toHaveLength(2)
    for (const [x, y] of positions) {expect(x).toBeGreaterThanOrEqual(45); expect(x).toBeLessThanOrEqual(1155); expect(y).toBeGreaterThanOrEqual(110); expect(y).toBeLessThanOrEqual(560)}
  })
  it('rejects out-of-range, duplicate and oversized point labels', () => {
    expect(() => validateAnnotations([{...annotations[0], pointIndex: 8}], 3)).toThrow()
    expect(() => validateAnnotations([annotations[0], {...annotations[0], label: '重复编号'}], 3)).toThrow()
    expect(validateAnnotations([annotations[0], {...annotations[0], id: 'poi-2'}], 3)).toHaveLength(2)
    expect(() => validateAnnotations([{...annotations[0], label: '山'.repeat(81)}], 3)).toThrow()
    expect(() => validateAnnotations([{...annotations[0], color: 'url(evil)'}], 3)).toThrow()
  })
  it('defaults ordinary labels to hidden and shows other annotation kinds', () => {
    const ordinary={id:'ordinary',pointIndex:0,label:'普通',color:'#7c3aed'}
    expect(annotationVisible(ordinary)).toBe(false)
    expect(annotationVisible({...ordinary,kind:'note'})).toBe(false)
    for(const kind of ['checkin','rest','toilet','supply'] as const) expect(annotationVisible({...ordinary,kind})).toBe(true)
    const items=[ordinary,{...ordinary,id:'note',kind:'note' as const},...(['checkin','rest','toilet','supply'] as const).map(kind=>({...ordinary,id:kind,kind,label:kind}))]
    const document=new DOMParser().parseFromString(trackSvg(points,{name:'默认显示',annotations:items}),'image/svg+xml')
    expect([...document.querySelectorAll('[data-annotation-id]')].map(element=>element.getAttribute('data-annotation-id'))).toEqual(['checkin','rest','toilet','supply'])
    expect(document.querySelector('desc')?.textContent).toContain('4 个标注')
    expect(document.querySelector('[data-annotation-id="checkin"]')?.getAttribute('aria-label')).toBe('编辑点位 3：checkin')
    expect(document.querySelector('[data-annotation-id="checkin"] text')?.textContent).toBe('3')
  })
  it('lets an explicit visibility setting override each type default', () => {
    const ordinary={id:'ordinary',pointIndex:0,label:'普通',color:'#7c3aed',visible:true}
    const hidden={...ordinary,id:'hidden',kind:'checkin' as const,visible:false,label:'隐藏打卡点'}
    expect(annotationVisible(ordinary)).toBe(true)
    expect(annotationVisible(hidden)).toBe(false)
    const document=new DOMParser().parseFromString(trackSvg(points,{name:'显式显示',annotations:[ordinary,hidden]}),'image/svg+xml')
    expect(document.querySelector('[data-annotation-id="ordinary"]')).not.toBeNull()
    expect(document.querySelector('[data-annotation-id="hidden"]')).toBeNull()
    expect(document.querySelector('desc')?.textContent).toContain('1 个标注')
  })
  it('validates visibility booleans and preserves omitted legacy settings', () => {
    const {visible:_visible,...legacy}=annotations[0]
    expect(validateAnnotations([legacy],points.length)[0]).not.toHaveProperty('visible')
    for(const visible of [true,false]) expect(validateAnnotations([{...legacy,visible}],points.length)[0].visible).toBe(visible)
    for(const visible of [null,0,1,'true',{},[]]) expect(()=>validateAnnotations([{...legacy,visible}],points.length)).toThrow('标注显示设置无效')
  })
  it('omits hidden photos and connectors without shifting the remaining photo layout', () => {
    const photo={dataUrl:'data:image/png;base64,AAAA'}
    const items=[{id:'hidden',pointIndex:0,label:'隐藏',color:'#7c3aed',photo},{id:'shown',pointIndex:1,label:'可见打卡点',color:'#0f766e',kind:'checkin' as const,photo}]
    const before=structuredClone(items),layout=annotationPhotoLayouts(items,points)
    const document=new DOMParser().parseFromString(trackSvg(points,{name:'照片布局',annotations:items}),'image/svg+xml')
    expect(document.querySelector('[data-photo-id="hidden"]')).toBeNull()
    expect(document.querySelector('[data-connector-id="hidden"]')).toBeNull()
    expect(document.querySelector('[data-annotation-id="hidden"]')).toBeNull()
    expect(document.querySelector('[data-photo-id="shown"] rect')?.getAttribute('x')).toBe(String(layout[1].x))
    expect(document.querySelector('[data-photo-id="shown"] rect')?.getAttribute('y')).toBe(String(layout[1].y))
    expect(document.querySelector('[data-connector-id="shown"]')).not.toBeNull()
    expect(document.querySelector('[data-photo-id="shown"] text')?.textContent).toBe('2 · 可见打卡点')
    expect(items).toEqual(before)
  })
  it('computes export height only from displayed markers and photos', () => {
    const hidden={id:'hidden',pointIndex:0,label:'隐藏',color:'#7c3aed',position:{x:200,y:8900},photo:{dataUrl:'data:image/png;base64,AAAA',x:100,y:8600}}
    const height=(items:typeof hidden[])=>new DOMParser().parseFromString(trackSvg(points,{name:'画布高度',annotations:items}),'image/svg+xml').documentElement.getAttribute('height')
    expect(height([hidden])).toBe(height([]))
    const document=new DOMParser().parseFromString(trackSvg(points,{name:'显示高位点',annotations:[{...hidden,visible:true}]}),'image/svg+xml')
    expect(document.documentElement.getAttribute('height')).toBe('8970')
    expect(document.querySelector('desc')?.textContent).toContain('1 个标注')
  })
})
