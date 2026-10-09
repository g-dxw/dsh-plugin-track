// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { annotationAnchorPosition, annotationPosition, annotationPhotoLayouts, annotationVisible, annotationsFromPlacemarks, ART_TEXT_LABELS, artTextPosition, diagramCoordinates, diagramHeight, fitArtRouteToCanvas, routeCanvasSvg, routeSvg, trackSvg, validateAnnotations, validateArtLayout, validateArtRouteTransform, validateArtCanvasSize, DEFAULT_ART_CANVAS_SIZE } from '../src/track/annotations.ts'
import type { TrackPoint } from '../src/protocol.ts'
import { mercatorY } from '../src/track/sandbox/coordinates.ts'
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
    const valid={x:-10000,y:10000,scale:.001},restored=validateArtRouteTransform(valid)
    expect(restored).toEqual(valid)
    expect(restored).not.toBe(valid)
    expect(validateArtRouteTransform({x:10000,y:-10000,scale:4})).toEqual({x:10000,y:-10000,scale:4})
    for(const invalid of [null,[],1,'route',new Date(),{}, {x:0,y:0},{x:0,scale:1},{y:0,scale:1},{x:0,y:0,scale:1,extra:1},{x:NaN,y:0,scale:1},{x:0,y:Infinity,scale:1},{x:0,y:0,scale:NaN},{x:-10001,y:0,scale:1},{x:0,y:10001,scale:1},{x:0,y:0,scale:.000999},{x:0,y:0,scale:4.001},{x:'0',y:0,scale:1}])expect(()=>validateArtRouteTransform(invalid)).toThrow('轨迹图层变换无效')
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


describe('geographic source anchors and independent marker layout', () => {
  const source = {id: 'source-marker', sourceId: 'kml-source', sourceCoordinates: [119.45, 30.35] as [number,number], pointIndex: 0, label: '真实点位', color: '#7c3aed', visible: true, position: {x: 820, y: 740}}
  it('projects fractional and off-route source coordinates independently of the nearest route index or marker layout', () => {
    const [start, end] = diagramCoordinates(points), [lon, lat] = source.sourceCoordinates
    const expectedX = start[0] + (lon - points[0][0]) / (points[1][0] - points[0][0]) * (end[0] - start[0])
    const expectedY = start[1] + (mercatorY(lat) - mercatorY(points[0][1])) / (mercatorY(points[1][1]) - mercatorY(points[0][1])) * (end[1] - start[1])
    const anchor = annotationAnchorPosition(source, points)
    expect(anchor[0]).toBeCloseTo(expectedX, 8)
    expect(anchor[1]).toBeCloseTo(expectedY, 8)
    expect(anchor).not.toEqual(start)
    expect(anchor).not.toEqual([source.position.x, source.position.y])
    expect(annotationPosition(source, points)).toEqual([820, 740])
    expect(annotationAnchorPosition({...source, position: {x: 100, y: 180}}, points)).toEqual(anchor)
  })

  it('moves the geographic anchor with the source while retaining the independently placed marker', () => {
    const moved = {...source, sourceCoordinates: [119.58, 30.37] as [number,number]}
    expect(annotationAnchorPosition(moved, points)).not.toEqual(annotationAnchorPosition(source, points))
    expect(annotationPosition(moved, points)).toEqual(annotationPosition(source, points))
    const document = new DOMParser().parseFromString(trackSvg(points, {name: '位置更新', annotations: [moved]}), 'image/svg+xml')
    const anchor = document.querySelector('[data-annotation-anchor-id]')!, [ax, ay] = annotationAnchorPosition(moved, points)
    expect(Number(anchor.getAttribute('cx'))).toBeCloseTo(ax, 2)
    expect(Number(anchor.getAttribute('cy'))).toBeCloseTo(ay, 2)
    expect(document.querySelector('[data-annotation-id] circle')?.getAttribute('cx')).toBe('820.00')
  })

  it('keeps exact source projection distinct from bounded marker layout and uses route indices when no source coordinate exists', () => {
    const outside = {...source, sourceCoordinates: [119, 30.35] as [number,number], position: undefined}
    expect(annotationAnchorPosition(outside, points)[0]).toBeLessThan(24)
    expect(annotationPosition(outside, points)[0]).toBe(24)
    const manual = {id: 'manual', pointIndex: 1, label: '手工', color: '#7c3aed', position: {x: 80, y: 140}}
    expect(annotationAnchorPosition(manual, points)).toEqual(diagramCoordinates(points)[1])
    expect(annotationPosition(manual, points)).toEqual([80, 140])
    const crossing: TrackPoint[] = [[179.9, 30, null, null], [-179.9, 30, null, null]]
    const [left, right] = diagramCoordinates(crossing), centered = annotationAnchorPosition({...source, sourceCoordinates: [180, 30]}, crossing)
    expect(centered[0]).toBeCloseTo((left[0] + right[0]) / 2, 8)
    expect(centered[1]).toBeCloseTo(left[1], 8)
  })

  it('exports non-interactive source dots and leaders inside the shared route transform', () => {
    const route = {x: 40, y: -20, scale: 1.5}, before = structuredClone(source)
    for (const layer of ['all', 'overlay'] as const) {
      const document = new DOMParser().parseFromString(trackSvg(points, {name: '源锚点', annotations: [source], route, layer, interactive: true}), 'image/svg+xml')
      const parent = document.querySelector('[data-route-annotations]')!, anchor = document.querySelector('[data-annotation-anchor-id="source-marker"]')!, leader = document.querySelector('[data-anchor-connector-id="source-marker"]')!
      const [ax, ay] = annotationAnchorPosition(source, points)
      expect(parent.getAttribute('transform')).toBe('translate(60 -30) scale(1.5)')
      expect(anchor.closest('[data-route-annotations]')).toBe(parent)
      expect(leader.closest('[data-route-annotations]')).toBe(parent)
      expect(anchor.closest('[data-annotation-id]')).toBeNull()
      expect(leader.getAttribute('d')).toBe(`M${ax.toFixed(2)},${ay.toFixed(2)} L820.00,740.00`)
      for (const element of [anchor, leader]) {
        expect(element.getAttribute('pointer-events')).toBe('none')
        expect(element.hasAttribute('tabindex')).toBe(false)
        expect(element.hasAttribute('role')).toBe(false)
      }
    }
    expect(source).toEqual(before)
  })

  it('filters hidden source anchors and leaders and produces a zero-length leader at an unshifted source marker', () => {
    const overlapping = {...source, id: 'overlapping', position: undefined}
    const hidden = {...source, id: 'hidden-source', visible: false}
    const manual = {id: 'manual', pointIndex: 0, label: '独立标记', color: '#7c3aed', visible: true}
    const document = new DOMParser().parseFromString(trackSvg(points, {name: '显隐', annotations: [overlapping, hidden, manual]}), 'image/svg+xml')
    expect(document.querySelectorAll('[data-annotation-anchor-id]')).toHaveLength(1)
    expect(document.querySelector('[data-annotation-anchor-id="hidden-source"]')).toBeNull()
    expect(document.querySelector('[data-anchor-connector-id="hidden-source"]')).toBeNull()
    expect(document.querySelector('[data-annotation-anchor-id="manual"]')).toBeNull()
    const [ax, ay] = annotationAnchorPosition(overlapping, points)
    expect(document.querySelector('[data-anchor-connector-id="overlapping"]')?.getAttribute('d')).toBe(`M${ax.toFixed(2)},${ay.toFixed(2)} L${ax.toFixed(2)},${ay.toFixed(2)}`)
  })
})

describe('source information lengths and copied source coordinates', () => {
  it('retains source names and descriptions within point-editor limits without sharing mutable coordinates or images', () => {
    const source = {id: 'source', name: '名'.repeat(160), description: '说'.repeat(10000), coordinates: [119.5, 30.4] as [number,number], images: ['https://example.com/photo.jpg']}
    const before = structuredClone(source), [imported] = annotationsFromPlacemarks([source], points)
    expect(imported.label).toBe(source.name)
    expect(imported.description).toBe(source.description)
    expect(validateAnnotations([imported], points.length)[0]).toMatchObject({label: source.name, description: source.description})
    expect(imported.sourceCoordinates).not.toBe(source.coordinates)
    expect(imported.imageUrls).not.toBe(source.images)
    imported.sourceCoordinates![0] = 120
    imported.imageUrls!.push('https://example.com/another.jpg')
    expect(source).toEqual(before)
  })

  it('allows longer metadata only for valid linked sources and preserves manual annotation limits', () => {
    const manual = {id: 'manual', pointIndex: 0, label: '名'.repeat(80), description: '说'.repeat(4000), color: '#7c3aed'}
    expect(validateAnnotations([manual], points.length)).toHaveLength(1)
    expect(() => validateAnnotations([{...manual, label: '名'.repeat(81)}], points.length)).toThrow('80')
    expect(() => validateAnnotations([{...manual, description: '说'.repeat(4001)}], points.length)).toThrow('4000')
    const source = {...manual, sourceId: 'kml-source', label: '名'.repeat(160), description: '说'.repeat(10000)}
    expect(validateAnnotations([source], points.length)).toHaveLength(1)
    expect(() => validateAnnotations([{...source, label: '名'.repeat(161)}], points.length)).toThrow('160')
    expect(() => validateAnnotations([{...source, description: '说'.repeat(10001)}], points.length)).toThrow('10000')
    for (const sourceId of ['', 'invalid/id']) expect(() => validateAnnotations([{...source, sourceId}], points.length)).toThrow('来源点位无效')
  })
})


it('refreshes source metadata when the immutable route and source coordinate objects are reused', () => {
  const coordinates: [number,number] = [119.5,30.4], source = {id:'source',name:'原名称',description:'原说明',coordinates,images:['https://example.com/old.jpg']}
  const [old] = annotationsFromPlacemarks([source],points)
  const [current] = annotationsFromPlacemarks([{...source,name:'当前名称',description:'当前说明',images:['https://example.com/new.jpg']}],points)
  expect(current.pointIndex).toBe(old.pointIndex)
  expect(current).toMatchObject({label:'当前名称',description:'当前说明',imageUrls:['https://example.com/new.jpg'],sourceCoordinates:coordinates})
  expect(current.sourceCoordinates).not.toBe(coordinates)
  expect(old).toMatchObject({label:'原名称',description:'原说明',imageUrls:['https://example.com/old.jpg']})
})


describe('source text XML output without changing point-editor information', () => {
  it.each([
    {name:'control character', label:'山\u0001口', rendered:'山\ufffd口'},
    {name:'isolated high surrogate', label:'山\ud800口', rendered:'山\ufffd口'},
    {name:'isolated low surrogate', label:'山\udfff口', rendered:'山\ufffd口'},
    {name:'valid emoji', label:'山口 🥾🌄', rendered:'山口 🥾🌄'},
    {name:'markup and attribute quotes', label:'<script>"&山口</script>', rendered:'<script>"&山口</script>'},
  ])('keeps $name in source data and renders safe full labels and truncated marker/photo text', ({label,rendered}) => {
    const source = {id:'source-xml',sourceId:'kml-1',pointIndex:0,label,description:'原始\u0001说明\ud800',color:'#7c3aed',visible:true,photo:{dataUrl:'data:image/png;base64,AAAA',x:40,y:220}}
    const before = structuredClone(source), [validated] = validateAnnotations([source],points.length)
    expect(validated.label).toBe(label)
    expect(validated.description).toBe(source.description)
    const document = new DOMParser().parseFromString(trackSvg(points,{name:'正常路线',annotations:[validated],interactive:true}),'image/svg+xml')
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.querySelector('script,foreignObject')).toBeNull()
    expect(document.querySelector('[data-annotation-id]')?.getAttribute('aria-label')).toBe(`编辑点位 1：${rendered}`)
    expect(document.querySelector('[data-photo-id]')?.getAttribute('aria-label')).toBe(`${rendered}的照片`)
    expect(document.querySelector('[data-annotation-id]')?.lastElementChild?.textContent).toBe(Array.from(rendered).slice(0,18).join(''))
    expect(document.querySelector('[data-photo-id]')?.lastElementChild?.textContent).toBe(`1 · ${Array.from(rendered).slice(0,13).join('')}`)
    expect(source).toEqual(before)
  })

  it('preserves leading and trailing source text while manual labels retain their trim behavior', () => {
    const source = {id:'source',sourceId:'kml-1',pointIndex:0,label:'  山\u0001口  ',description:'  源说明\ud800  ',color:'#7c3aed'}
    expect(validateAnnotations([source],points.length)[0]).toMatchObject({label:source.label,description:source.description})
    expect(validateAnnotations([{id:'manual',pointIndex:0,label:'  手工标题  ',color:'#7c3aed'}],points.length)[0].label).toBe('手工标题')
  })

  it('continues rejecting invalid manual labels, manual descriptions and route titles', () => {
    const manual = {id:'manual',pointIndex:0,label:'手工点位',color:'#7c3aed',visible:true}
    for (const invalid of ['坏\u0001字符','坏\ud800字符','坏\udfff字符']) {
      expect(() => validateAnnotations([{...manual,label:invalid}],points.length)).toThrow('标注名称')
      expect(() => validateAnnotations([{...manual,description:invalid}],points.length)).toThrow('点位说明')
      expect(() => trackSvg(points,{name:invalid,annotations:[manual]})).toThrow('非法 XML 字符')
    }
  })
})


describe('fixed-size annotation artwork', () => {
  it('validates and copies pixel dimensions without changing the 1200-unit coordinate system', () => {
    expect(validateArtCanvasSize(undefined)).toEqual({width:1200,height:900})
    expect(validateArtCanvasSize(undefined)).not.toBe(DEFAULT_ART_CANVAS_SIZE)
    const canvas={width:240,height:4096},validated=validateArtCanvasSize(canvas)
    expect(validated).toEqual(canvas);expect(validated).not.toBe(canvas)
    expect(validateArtCanvasSize({width:4096,height:240})).toEqual({width:4096,height:240})
    for(const invalid of [null,[],1,'size',new Date(),{}, {width:1200},{height:900},{width:1200,height:900,extra:true},{width:239,height:900},{width:4097,height:900},{width:1200,height:239},{width:1200,height:4097},{width:NaN,height:900},{width:Infinity,height:900},{width:1200.5,height:900},{width:1200,height:900.5},{width:'1200',height:900}])expect(()=>validateArtCanvasSize(invalid)).toThrow()
  })

  it('exports exact requested pixels and a proportional viewBox without expanding for stored marker or text positions', () => {
    const item={...annotations[0],position:{x:400,y:8800},photo:{dataUrl:'data:image/png;base64,AAAA',x:80,y:8600}},layout={title:{x:100,y:8000}}
    const before=structuredClone({item,layout,points})
    for(const canvas of [{width:1200,height:900},{width:1600,height:900},{width:900,height:1600},{width:240,height:4096}]) {
      const document=new DOMParser().parseFromString(trackSvg(points,{name:'尺寸',annotations:[item],layout,canvas}),'image/svg+xml'),svg=document.documentElement
      expect(document.querySelector('parsererror')).toBeNull()
      expect(svg.getAttribute('width')).toBe(String(canvas.width));expect(svg.getAttribute('height')).toBe(String(canvas.height))
      expect(svg.getAttribute('viewBox')).toBe(`0 0 1200 ${1200*canvas.height/canvas.width}`)
      expect(document.querySelector('[data-art-layer="background"]')?.getAttribute('height')).toBe(String(1200*canvas.height/canvas.width))
      expect(document.querySelector('[data-annotation-id] circle')?.getAttribute('cy')).toBe('8800.00')
      expect(document.querySelector('[data-photo-id] rect')?.getAttribute('y')).toBe('8600')
      expect(document.querySelector('[data-route]')?.getAttribute('d')).toBe(new DOMParser().parseFromString(trackSvg(points,{name:'旧画布'}),'image/svg+xml').querySelector('[data-route]')?.getAttribute('d'))
    }
    expect({item,layout,points}).toEqual(before)
    expect(new DOMParser().parseFromString(trackSvg(points,{name:'旧画布',annotations:[item],layout}),'image/svg+xml').documentElement.getAttribute('height')).toBe('8870')
  })

  it('keeps route, endpoint rings, markers, photos and leaders while omitting all fixed headings and statistics', () => {
    const item={...annotations[0],sourceId:'source-1',sourceCoordinates:[119.45,30.35] as [number,number],photo:{dataUrl:'data:image/png;base64,AAAA'}},canvas={width:1600,height:900}
    const document=new DOMParser().parseFromString(trackSvg(points,{name:'不要导出的路线名',annotations:[item],layout:{title:{x:100,y:8900}},canvas,annotationsOnly:true}),'image/svg+xml')
    expect(document.querySelector('parsererror')).toBeNull()
    for(const selector of ['[data-route]','[data-art-layer="endpoints"] circle','[data-art-layer="endpoints"] ellipse','[data-annotation-id]','[data-photo-id] image','[data-connector-id]','[data-annotation-anchor-id]','[data-anchor-connector-id]'])expect(document.querySelector(selector)).not.toBeNull()
    expect(document.querySelector('[data-art-text-id],[data-art-text-hit]')).toBeNull()
    expect(document.documentElement.textContent).toContain('山口')
    for(const text of ['不要导出的路线名','起点','终点','北 ↑',' km','个轨迹点','个标注'])expect(document.documentElement.textContent).not.toContain(text)
    expect(document.documentElement.getAttribute('height')).toBe('900')
    expect(trackSvg(points,{name:'无效\u0001标题',annotationsOnly:true,canvas})).toContain('<title id="title">轨迹标注图</title>')
    const overlay=new DOMParser().parseFromString(trackSvg(points,{name:'纯标注',annotations:[item],canvas,annotationsOnly:true,layer:'overlay',interactive:true}),'image/svg+xml')
    expect(overlay.querySelector('[data-art-text-id]')).toBeNull();expect(overlay.querySelector('[data-photo-id]')).not.toBeNull()
  })

  it('fits actual visible artwork in landscape, portrait and extreme wide canvases while retaining saved local positions', () => {
    const items=[
      {...annotations[0],label:'沿途的十八个字山口打卡点标题名称',position:{x:1040,y:1100},sourceId:'source',sourceCoordinates:[119.42,30.31] as [number,number],photo:{dataUrl:'data:image/png;base64,AAAA',x:840,y:1500}},
      {...annotations[0],id:'hidden',visible:false,position:{x:0,y:8800},photo:{dataUrl:'data:image/png;base64,AAAA',x:0,y:8700}}
    ],before=structuredClone({points,items})
    for(const canvas of [{width:1200,height:900},{width:1600,height:900},{width:900,height:1600},{width:4096,height:240}]) {
      const route=fitArtRouteToCanvas(points,items,canvas),height=1200*canvas.height/canvas.width
      expect(validateArtRouteTransform(route)).toEqual(route)
      const document=new DOMParser().parseFromString(trackSvg(points,{name:'适配',annotations:items,canvas,route,annotationsOnly:true}),'image/svg+xml')
      const displayed=(x:number,y:number):[number,number]=>[(x+route.x)*route.scale,(y+route.y)*route.scale]
      const bounds:(readonly [number,number])[]=[]
      for(const match of document.querySelector('[data-route]')!.getAttribute('d')!.matchAll(/[ML]([-\d.]+),([-\d.]+)/gu))bounds.push(displayed(Number(match[1]),Number(match[2])))
      for(const element of document.querySelectorAll('[data-art-layer="photos"] rect,[data-art-layer="photos"] image')) {
        const x=Number(element.getAttribute('x')),y=Number(element.getAttribute('y')),width=Number(element.getAttribute('width')),height=Number(element.getAttribute('height'))
        bounds.push(displayed(x,y),displayed(x+width,y+height))
      }
      for(const element of document.querySelectorAll('circle,ellipse')) {
        const x=Number(element.getAttribute('cx')),y=Number(element.getAttribute('cy')),rx=Number(element.getAttribute('r')??element.getAttribute('rx')),ry=Number(element.getAttribute('r')??element.getAttribute('ry'))
        bounds.push(displayed(x-rx,y-ry),displayed(x+rx,y+ry))
      }
      const label=document.querySelector('[data-annotation-id] > text:last-child')!,labelX=Number(label.getAttribute('x')),labelY=Number(label.getAttribute('y'))
      bounds.push(displayed(labelX,labelY-17),displayed(labelX+Array.from(label.textContent!).length*17,labelY))
      for(const [x,y] of bounds){expect(x).toBeGreaterThanOrEqual(23.9);expect(x).toBeLessThanOrEqual(1176.1);expect(y).toBeGreaterThanOrEqual(23.9);expect(y).toBeLessThanOrEqual(height-23.9)}
      expect(document.querySelector('[data-photo-id="hidden"]')).toBeNull()
      expect(document.querySelector('[data-annotation-id] circle')?.getAttribute('cy')).toBe('1100.00')
    }
    expect({points,items}).toEqual(before)
  })

  it('allows compact fitting below the old zoom minimum and avoids counting hidden high-position content', () => {
    const item={...annotations[0],position:{x:400,y:8800},photo:{dataUrl:'data:image/png;base64,AAAA',x:40,y:8700}},canvas={width:1200,height:900}
    const fit=fitArtRouteToCanvas(points,[item],canvas)
    expect(fit.scale).toBeLessThan(.25);expect(fit.scale).toBeGreaterThanOrEqual(.001)
    expect((8700+fit.y)*fit.scale).toBeGreaterThanOrEqual(24)
    expect((8900+fit.y)*fit.scale).toBeLessThanOrEqual(876)
    expect(fitArtRouteToCanvas(points,[{...item,visible:false}],canvas)).toEqual(fitArtRouteToCanvas(points,[],canvas))
  })

  it('reports artwork outside the supported camera bounds without altering off-route source coordinates', () => {
    const item={...annotations[0],sourceId:'far',sourceCoordinates:[0,0] as [number,number]},before=structuredClone(item)
    expect(()=>fitArtRouteToCanvas(points,[item],{width:1200,height:900})).toThrow('标注范围过大')
    expect(item).toEqual(before)
    expect(()=>fitArtRouteToCanvas(points.slice(0,1),[],{width:1200,height:900})).toThrow('至少需要 2 个点')
    expect(()=>trackSvg(points,{name:'无效画布',canvas:{width:0,height:900}})).toThrow('整数像素')
  })
})
