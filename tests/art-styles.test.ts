// @vitest-environment jsdom
import {describe,expect,it} from 'vitest'
import {annotationPhotoLayouts,annotationPosition,fitArtRouteToCanvas,photoConnector,routeCanvasSvg,routeSvg,trackSvg,validateAnnotations,type TrackAnnotation} from '../src/track/annotations.ts'
import {ART_STYLE_LIMITS,getArtBackground,getArtElementStyle,getArtRouteStyle,getArtTextStyle,validateArtElementStyle,validateArtStyles,validateArtTextStyle,type ArtStyles} from '../src/track/art-styles.ts'
import type {TrackPoint} from '../src/protocol.ts'
const points:TrackPoint[]=[[119.4,30.3,500,null],[119.5,30.4,null,null],[119.6,30.35,600,null]]
const item:TrackAnnotation={id:'style-1',pointIndex:1,label:'山口',color:'#7c3aed',visible:true,photo:{dataUrl:'data:image/png;base64,AAAA',x:40,y:150}}
function document(styles:ArtStyles={},annotation:TrackAnnotation=item,options:{theme?:'light'|'dark'|'paper';interactive?:boolean;annotationsOnly?:boolean}={}){return new DOMParser().parseFromString(trackSvg(points,{name:'山野路线',annotations:[annotation],styles,...options}),'image/svg+xml')}

describe('art style schema and inheritance',()=>{
  it('has empty optional state and copies validated input without mutation',()=>{
    expect(validateArtStyles(undefined)).toEqual({});expect(validateArtElementStyle(undefined)).toEqual({});expect(validateArtTextStyle(undefined)).toEqual({})
    const styles:ArtStyles={defaults:{textColor:'#123456',textSize:24,textOffsetX:10,photoWidth:400},texts:{title:{textColor:'#ff0000',textSize:32}},route:{color:'#00aaff',width:8},background:'#f4f4f4'},before=structuredClone(styles),validated=validateArtStyles(styles)
    expect(validated).toEqual(styles);expect(styles).toEqual(before);expect(validated.defaults).not.toBe(styles.defaults)
    expect(validateAnnotations([{...item,style:{textColor:'#abcdef',textSize:29}}],points.length)[0].style).toEqual({textColor:'#abcdef',textSize:29})
  })
  it.each([null,[],new Date(),{unknown:1},{defaults:{textSize:Infinity}},{defaults:{textOffsetX:1001}},{defaults:{photoWidth:23}},{defaults:{textColor:'url(https://example.com)'}},{defaults:{fontFamily:'" onload="evil'}},{defaults:{fontWeight:900}},{texts:{other:{textSize:20}}},{texts:{title:{textOffsetX:20}}},{route:{width:0}},{route:{startRadius:81}},{background:'red"/>'}])('rejects malformed or unsafe input %#',value=>{expect(()=>validateArtStyles(value)).toThrow()})
  it('validates exact bounds shared by the controls',()=>{
    for(const [key,{min,max}] of Object.entries(ART_STYLE_LIMITS)){
      expect(validateArtElementStyle({[key]:min})).toEqual({[key]:min});expect(validateArtElementStyle({[key]:max})).toEqual({[key]:max})
      expect(()=>validateArtElementStyle({[key]:min-.01})).toThrow();expect(()=>validateArtElementStyle({[key]:max+.01})).toThrow()
    }
    expect(validateArtStyles({background:'transparent',defaults:{photoCaptionBackground:'#1234abcd',markerColor:'#abc'}})).toEqual({background:'transparent',defaults:{photoCaptionBackground:'#1234abcd',markerColor:'#abc'}})
  })
  it('resolves local overrides then shared values then theme defaults and the legacy marker color',()=>{
    const styles:ArtStyles={defaults:{textColor:'#123456',textSize:25,markerColor:'#00aaff',textOffsetX:8},texts:{title:{textSize:40}}},local={...item,style:{textColor:'#abcdef',markerColor:'#ff0000',textOffsetY:-12}}
    expect(getArtElementStyle(local,styles)).toMatchObject({textColor:'#abcdef',textSize:25,markerColor:'#ff0000',textOffsetX:8,textOffsetY:-12})
    expect(getArtElementStyle(item,styles)).toMatchObject({textColor:'#123456',textSize:25,markerColor:'#00aaff'})
    expect(getArtElementStyle(item,{},'dark')).toMatchObject({textColor:'#f1f3f5',markerColor:item.color})
    expect(getArtTextStyle('title',styles)).toMatchObject({textColor:'#123456',textSize:40})
    expect(getArtRouteStyle({},'dark').color).toBe('#ff8c7c');expect(getArtBackground({},'dark')).toBe('#171d23')
  })
  it('keeps number contrast tied to the final marker color unless locally overridden',()=>{
    expect(getArtElementStyle(item,{defaults:{markerColor:'#ffffff'}}).numberColor).toBe('#000')
    expect(getArtElementStyle({...item,style:{numberColor:'#123456'}},{defaults:{markerColor:'#000000'}}).numberColor).toBe('#123456')
  })
})

describe('global and local SVG rendering',()=>{
  it('preserves role-specific legacy styles when no override exists',()=>{
    const svg=document({},item,{theme:'dark'})
    expect(svg.querySelector('[data-art-style="label"]')?.getAttribute('fill')).toBe('#f1f3f5')
    expect(svg.querySelector('[data-art-style="photo-caption"]')?.getAttribute('fill')).toBe('#fff')
    expect(svg.querySelector('[data-art-style="title"]')?.getAttribute('font-size')).toBe('28')
    expect(svg.querySelector('[data-art-style="statistics"]')?.getAttribute('font-size')).toBe('15')
    expect(svg.querySelector('[data-art-style="photo-connector"]')?.getAttribute('stroke')).toBe('#b5bec7')
    expect(svg.querySelector('[data-art-style="marker"]')?.getAttribute('r')).toBe('16')
  })
  it('changes every text role globally and retains independent overrides',()=>{
    const styles:ArtStyles={defaults:{textColor:'#123456',textSize:24,fontFamily:'serif',fontWeight:500},texts:{title:{textColor:'#ef1234',textSize:48}}},local={...item,style:{textColor:'#abcdef',textSize:31,fontWeight:700 as const}},svg=document(styles,local)
    for(const role of ['label','photo-caption']){expect(svg.querySelector(`[data-art-style="${role}"]`)?.getAttribute('fill')).toBe('#abcdef');expect(svg.querySelector(`[data-art-style="${role}"]`)?.getAttribute('font-size')).toBe('31')}
    expect(svg.querySelector('[data-art-style="title"]')?.getAttribute('fill')).toBe('#ef1234');expect(svg.querySelector('[data-art-style="title"]')?.getAttribute('font-size')).toBe('48')
    for(const role of ['start','end','north'])expect(svg.querySelector(`[data-art-style="${role}"]`)?.getAttribute('font-size')).toBe('24')
    expect(svg.querySelector('[data-art-style="statistics"]')?.getAttribute('font-size')).toBe('48')
    expect(svg.querySelector('[data-art-style="label"]')?.getAttribute('font-family')).toContain('SimSun')
    const newer=document({...styles,defaults:{...styles.defaults,textColor:'#000000',textSize:20}},local)
    expect(newer.querySelector('[data-art-style="label"]')?.getAttribute('fill')).toBe('#abcdef');expect(newer.querySelector('[data-art-style="start"]')?.getAttribute('font-size')).toBe('20')
  })
  it('moves label and caption text relative to their marker/frame while retaining all source geometry',()=>{
    const before=structuredClone(item),styles:ArtStyles={defaults:{textOffsetX:40,textOffsetY:60}},svg=document(styles),[x,y]=annotationPosition(item,points)
    expect(Number(svg.querySelector('[data-art-style="label"]')?.getAttribute('x'))).toBeCloseTo(x+63,2)
    expect(Number(svg.querySelector('[data-art-style="label"]')?.getAttribute('y'))).toBeCloseTo(y+45,2)
    expect(svg.querySelector('[data-art-style="photo-caption"]')?.getAttribute('x')).toBe('100');expect(svg.querySelector('[data-art-style="photo-caption"]')?.getAttribute('y')).toBe('244')
    expect(svg.querySelector('[data-art-style="photo-frame"]')?.getAttribute('x')).toBe('40');expect(item).toEqual(before)
  })
  it('expands title hit targets and statistics spacing with larger type',()=>{
    const svg=document({texts:{title:{textSize:96}}},item,{interactive:true}),title=svg.querySelector('[data-art-text-id="title"]')!,first=Number(title.querySelector('[data-art-style="title"]')?.getAttribute('y')),stats=Number(title.querySelector('[data-art-style="statistics"]')?.getAttribute('y'))
    expect(stats-first).toBeGreaterThan(96);expect(Number(title.querySelector('[data-art-text-hit]')?.getAttribute('height'))).toBeGreaterThan(160)
  })
  it('styles route, endpoint symbols and background consistently in the live and exported route layers',()=>{
    const styles:ArtStyles={route:{color:'#123456',width:13,startColor:'#00ff00',endColor:'#0000ff',startRadius:20,endRadius:25},background:'#eeeeee'},svg=document(styles)
    expect(svg.querySelector('[data-route]')?.getAttribute('stroke')).toBe('#123456');expect(svg.querySelector('[data-route]')?.getAttribute('stroke-width')).toBe('13')
    expect(svg.querySelector('[data-art-style="start-symbol"]')?.getAttribute('r')).toBe('20');expect(svg.querySelector('[data-art-style="end-symbol"]')?.getAttribute('rx')).toBe('25')
    expect(svg.querySelector('[data-art-layer="background"]')?.getAttribute('fill')).toBe('#eeeeee')
    const live=new DOMParser().parseFromString(routeCanvasSvg(points,{styles}),'image/svg+xml')
    expect(live.querySelector('[data-route]')?.outerHTML).toBe(svg.querySelector('[data-route]')?.outerHTML)
    const routeOnly=new DOMParser().parseFromString(routeSvg(points,{styles}),'image/svg+xml');expect(routeOnly.querySelector('[data-art-style="start-symbol"]')).toBeNull()
  })
  it('changes frame size, photo fit, borders and connector endpoints with per-photo overrides',()=>{
    const local={...item,style:{photoWidth:480,photoHeight:300,photoRadius:30,photoBorderColor:'#123456',photoBorderWidth:6,photoFit:'contain' as const,connectorColor:'#ff0000',connectorWidth:4,connectorDash:'solid' as const}},svg=document({},local),frame=svg.querySelector('[data-art-style="photo-frame"]')!,image=svg.querySelector('image')!,connector=svg.querySelector('[data-connector-id]')!,[mx,my]=annotationPosition(item,points)
    expect(frame.getAttribute('width')).toBe('480');expect(frame.getAttribute('height')).toBe('300');expect(frame.getAttribute('rx')).toBe('30');expect(frame.getAttribute('stroke')).toBe('#123456');expect(frame.getAttribute('stroke-width')).toBe('6')
    expect(image.getAttribute('width')).toBe('468');expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');expect(image.getAttribute('clip-path')).toContain('art-photo-clip-style-1')
    expect(connector.getAttribute('d')).toBe(photoConnector(mx,my,40,150,480,300));expect(connector.getAttribute('stroke')).toBe('#ff0000');expect(connector.hasAttribute('stroke-dasharray')).toBe(false)
  })
  it('keeps the photo inside a minimum-size frame even with a thick border',()=>{
    const svg=document({}, {...item,style:{photoWidth:24,photoHeight:24,photoBorderWidth:20}}),frame=svg.querySelector('[data-art-style="photo-frame"]')!,image=svg.querySelector('image')!
    for(const [position,size] of [['x','width'],['y','height']] as const){const start=Number(frame.getAttribute(position)),end=start+Number(frame.getAttribute(size));expect(Number(image.getAttribute(position))).toBeGreaterThanOrEqual(start);expect(Number(image.getAttribute(position))+Number(image.getAttribute(size))).toBeLessThanOrEqual(end)}
    expect(Number(image.getAttribute('width'))).toBeGreaterThan(0)
  })
  it('reflows automatic right-side photos according to shared dimensions and stacked height',()=>{
    const items=[{...item,photo:{dataUrl:item.photo!.dataUrl}},{...item,id:'style-2',photo:{dataUrl:item.photo!.dataUrl}},{...item,id:'style-3',photo:{dataUrl:item.photo!.dataUrl}}],layouts=annotationPhotoLayouts(items,points,{defaults:{photoWidth:480,photoHeight:360}})
    expect(layouts[1].x).toBe(680);expect(layouts[2].y-layouts[0].y).toBeGreaterThanOrEqual(385);expect(layouts[1]).toMatchObject({width:480,height:360})
  })
  it('keeps automatically positioned narrow and full-width photos within the saved-position bounds',()=>{
    const items=[{...item,photo:{dataUrl:item.photo!.dataUrl}},{...item,id:'style-2',photo:{dataUrl:item.photo!.dataUrl}}]
    const narrow=annotationPhotoLayouts(items,points,{defaults:{photoWidth:200}}),wide=annotationPhotoLayouts(items,points,{defaults:{photoWidth:1200}})
    expect(narrow.map(layout=>layout.x)).toEqual([40,880]);expect(wide.map(layout=>layout.x)).toEqual([0,0])
    for(const layouts of [narrow,wide])expect(()=>validateAnnotations(layouts.map(({annotation,x,y})=>({...annotation,photo:{...annotation.photo!,x,y}})),points.length)).not.toThrow()
    expect(annotationPhotoLayouts([{...item,photo:{...item.photo!,x:100}}],points,{defaults:{photoWidth:1200}})[0].x).toBe(100)
  })
  it('fits large styled labels, offset captions and changed marker/frame sizes without editing local positions',()=>{
    const local={...item,position:{x:1080,y:1100},style:{textColor:'#112233',textSize:60,textOffsetX:100,textOffsetY:200,markerRadius:50,photoWidth:480,photoHeight:300}},styles:ArtStyles={route:{startRadius:30,endRadius:40}},before=structuredClone(local),canvas={width:1200,height:900},route=fitArtRouteToCanvas(points,[local],canvas,styles)
    const svg=new DOMParser().parseFromString(trackSvg(points,{name:'样式',annotations:[local],styles,route,canvas,annotationsOnly:true}),'image/svg+xml'),marker=svg.querySelector('[data-art-style="marker"]')!,label=svg.querySelector('[data-art-style="label"]')!
    for(const element of [marker,label]){const x=Number(element.getAttribute(element===marker?'cx':'x')),y=Number(element.getAttribute(element===marker?'cy':'y'));expect((x+route.x)*route.scale).toBeGreaterThanOrEqual(23);expect((y+route.y)*route.scale).toBeLessThanOrEqual(877)}
    expect(local).toEqual(before);expect(svg.querySelector('[data-art-text-id]')).toBeNull()
  })
  it('keeps full labels after an explicit text size choice instead of an old fixed character cap',()=>{
    const label='旅行中的美丽山脉与森林步道休息补给点位',svg=document({defaults:{textSize:20}},{...item,label})
    expect(svg.querySelector('[data-art-style="label"]')?.textContent).toBe(label);expect(svg.querySelector('[data-art-style="photo-caption"]')?.textContent).toBe(`1 · ${label}`)
    expect(svg.querySelectorAll('[data-art-style="photo-caption"] tspan').length).toBeGreaterThan(1);expect(Number(svg.querySelector('[data-art-style="photo-caption-background"]')?.getAttribute('height'))).toBeGreaterThan(30)
  })
})
