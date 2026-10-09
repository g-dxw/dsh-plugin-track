import type { TrackPoint, TrackPlacemark } from '../protocol.ts'
import { mercatorY } from './sandbox/coordinates.ts'
import { editedMetrics } from './edit.ts'
import { imageLink } from './placemarks.ts'

export type AnnotationKind = 'checkin' | 'rest' | 'toilet' | 'supply' | 'note'
export const ANNOTATION_KINDS: {id: AnnotationKind; label: string; symbol: string}[] = [{id:'note',label:'普通标注',symbol:''},{id:'checkin',label:'打卡点',symbol:'✓'},{id:'rest',label:'休息点',symbol:'休'},{id:'toilet',label:'厕所',symbol:'WC'},{id:'supply',label:'补给点',symbol:'+'}]
export interface TrackAnnotation {
  id: string; pointIndex: number; label: string; color: string; kind?: AnnotationKind; visible?: boolean
  description?: string; imageUrls?: string[]; sourceId?: string; sourceCoordinates?: [number,number]
  /** Marker and photo positions use the route-local artwork coordinates. */
  position?: {x:number;y:number}
  photo?: {dataUrl:string;x?:number;y?:number;sourceUrl?:string}
}
export function annotationVisible(annotation:TrackAnnotation):boolean {return annotation.visible??(annotation.kind!==undefined && annotation.kind!=='note')}
export type ArtTheme = 'light' | 'dark' | 'paper'
export type ArtTextId = 'title' | 'start' | 'end' | 'north'
export type ArtLayout = Partial<Record<ArtTextId, {x:number;y:number}>>
export interface ArtRouteTransform {x:number;y:number;scale:number}
/** Route camera values use the fixed 1200-wide artwork coordinate system. */
export function validateArtRouteTransform(value:unknown):ArtRouteTransform {
  if(value===undefined)return {x:0,y:0,scale:1}
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('轨迹图层变换无效')
  const transform=value as Partial<ArtRouteTransform>
  if(Object.keys(value).some(key=>key!=='x' && key!=='y' && key!=='scale') || typeof transform.x!=='number' || typeof transform.y!=='number' || typeof transform.scale!=='number' || !Number.isFinite(transform.x) || !Number.isFinite(transform.y) || !Number.isFinite(transform.scale) || Math.abs(transform.x)>10000 || Math.abs(transform.y)>10000 || transform.scale<.25 || transform.scale>4)throw new Error('轨迹图层变换无效')
  return {x:transform.x,y:transform.y,scale:transform.scale}
}
export const ART_TEXT_LABELS: {id:ArtTextId;label:string}[] = [{id:'title',label:'标题与统计'},{id:'start',label:'起点文字'},{id:'end',label:'终点文字'},{id:'north',label:'方向说明'}]
/** Start/end text uses route-local coordinates; title/north uses fixed artwork coordinates. */
export function validateArtLayout(value:unknown):ArtLayout {
  if(value===undefined)return {}
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('画布文字布局无效')
  const layout:ArtLayout={}
  for(const [id,raw] of Object.entries(value)) {
    if(!ART_TEXT_LABELS.some(item=>item.id===id) || !raw || typeof raw!=='object' || Array.isArray(raw) || ![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw new Error('画布文字布局无效')
    const position=raw as {x?:unknown;y?:unknown}
    if(Object.keys(raw).some(key=>key!=='x' && key!=='y') || typeof position.x!=='number' || typeof position.y!=='number' || !validPosition(position.x,position.y,1200))throw new Error('画布文字位置无效')
    layout[id as ArtTextId]={x:position.x,y:position.y}
  }
  return layout
}
export const ANNOTATION_COLORS = ['#d33d33', '#0f766e', '#2563eb', '#7c3aed', '#b45309'] as const
export function annotationTextColor(color:string):string {
  const rgb=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4)
  const luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]
  return 1.05/(luminance+.05)>=(luminance+.05)/.05?'#fff':'#000'
}
const invalidXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u
function validPosition(x:number,y:number,maximumX:number) {return Number.isFinite(x) && x>=0 && x<=maximumX && Number.isFinite(y) && y>=0 && y<=9000}
export function validateAnnotations(value:unknown,pointCount:number):TrackAnnotation[] {
  if (!Array.isArray(value) || value.length>100) throw new Error('最多可添加 100 个轨迹标注')
  const ids = new Set<string>(); let photoBytes=0,photoCount=0
  return value.map(raw=>{
    if (!raw || typeof raw!=='object') throw new Error('标注格式无效')
    const item=raw as Partial<TrackAnnotation>
    if (typeof item.id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id)) throw new Error('标注编号无效或重复')
    if (!Number.isInteger(item.pointIndex) || item.pointIndex!<0 || item.pointIndex!>=pointCount) throw new Error('标注点序号无效')
    if (typeof item.label!=='string' || !item.label.trim() || Array.from(item.label).length>80 || invalidXml.test(item.label)) throw new Error('标注名称需要 1 至 80 个有效字符')
    if (typeof item.color!=='string' || !/^#[0-9a-f]{6}$/iu.test(item.color)) throw new Error('标注颜色无效')
    if (item.kind!==undefined && !ANNOTATION_KINDS.some(kind=>kind.id===item.kind)) throw new Error('标注类别无效')
    if (item.visible!==undefined && typeof item.visible!=='boolean') throw new Error('标注显示设置无效')
    if (item.description!==undefined && (typeof item.description!=='string' || item.description.length>4000 || invalidXml.test(item.description))) throw new Error('点位说明最多 4000 个有效字符')
    if (item.imageUrls!==undefined && (!Array.isArray(item.imageUrls) || item.imageUrls.length>30 || item.imageUrls.some(url=>typeof url!=='string' || url.length>4096 || !imageLink(url)))) throw new Error('标注图片链接无效')
    if (item.sourceId!==undefined && (typeof item.sourceId!=='string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.sourceId))) throw new Error('来源点位无效')
    if (item.sourceCoordinates!==undefined && (!Array.isArray(item.sourceCoordinates) || item.sourceCoordinates.length!==2 || !item.sourceCoordinates.every(Number.isFinite) || Math.abs(item.sourceCoordinates[0])>180 || Math.abs(item.sourceCoordinates[1])>90)) throw new Error('来源坐标无效')
    if (item.position!==undefined && (!item.position || !validPosition(item.position.x,item.position.y,1200))) throw new Error('画布点位位置无效')
    let photo:TrackAnnotation['photo']
    if (item.photo!==undefined) {
      const value=item.photo
      if (!value || typeof value!=='object' || typeof value.dataUrl!=='string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.dataUrl)) throw new Error('打卡图片必须为本地 PNG 或 JPEG')
      photoBytes+=value.dataUrl.length;photoCount++
      if (value.dataUrl.length>700000 || photoBytes>8*1024*1024 || photoCount>20) throw new Error('最多 20 张打卡图片，总大小上限 8 MB')
      if (!validPosition(value.x??0,value.y??0,880)) throw new Error('打卡图片位置无效')
      if (value.sourceUrl!==undefined && (typeof value.sourceUrl!=='string' || value.sourceUrl.length>4096 || !imageLink(value.sourceUrl))) throw new Error('图片来源无效')
      photo={dataUrl:value.dataUrl,...(value.x===undefined?{}:{x:value.x}),...(value.y===undefined?{}:{y:value.y}),...(value.sourceUrl===undefined?{}:{sourceUrl:value.sourceUrl})}
    }
    ids.add(item.id)
    return {id:item.id,pointIndex:item.pointIndex!,label:item.label.trim(),color:item.color,
      ...(item.kind===undefined?{}:{kind:item.kind}),...(item.visible===undefined?{}:{visible:item.visible}),...(item.description===undefined?{}:{description:item.description}),
      ...(item.imageUrls===undefined?{}:{imageUrls:[...new Set(item.imageUrls)]}),...(item.sourceId===undefined?{}:{sourceId:item.sourceId}),
      ...(item.sourceCoordinates===undefined?{}:{sourceCoordinates:[...item.sourceCoordinates] as [number,number]}),
      ...(item.position===undefined?{}:{position:{x:item.position.x,y:item.position.y}}),...(photo?{photo}:{})}
  })
}

const projectionCache = new WeakMap<readonly TrackPoint[], {height:number;projected:[number,number][];pixel:(x:number,y:number)=>[number,number];centerX:number}>()
function projection(points:readonly TrackPoint[]) {
  const cached=projectionCache.get(points);if(cached)return cached
  let previous:number|null=null,west=Infinity,east=-Infinity,north=Infinity,south=-Infinity
  const projected=points.map(point=>{
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error('轨迹坐标无效')
    let x=(point[0]+180)/360
    if (previous!==null) {while(x-previous>.5)x-=1;while(x-previous<-.5)x+=1}
    previous=x;const y=mercatorY(point[1]);west=Math.min(west,x);east=Math.max(east,x);north=Math.min(north,y);south=Math.max(south,y)
    return [x,y] as [number,number]
  })
  const spanX=Math.max(east-west,1e-8),spanY=Math.max(south-north,1e-8)
  const height=Math.round(Math.max(900,Math.min(1800,1100*spanY/spanX))),scale=Math.min(760/spanX,(height-320)/spanY)
  const pixel=(x:number,y:number):[number,number]=>[600+(x-(west+east)/2)*scale,height/2+30+(y-(north+south)/2)*scale]
  const result={height,projected:projected.map(([x,y])=>pixel(x,y)),pixel,centerX:(west+east)/2}
  projectionCache.set(points,result)
  return result
}
export function diagramCoordinates(points:readonly TrackPoint[]):[number,number][] {return projection(points).projected}
export function diagramHeight(points:readonly TrackPoint[]):number {return projection(points).height}
export function annotationPosition(annotation:TrackAnnotation,points:readonly TrackPoint[]):[number,number] {
  if (annotation.position) return [annotation.position.x,annotation.position.y]
  const transform=projection(points)
  if (annotation.sourceCoordinates) {
    let x=(annotation.sourceCoordinates[0]+180)/360
    while(x-transform.centerX>.5)x-=1;while(x-transform.centerX<-.5)x+=1
    const [px,py]=transform.pixel(x,mercatorY(annotation.sourceCoordinates[1]))
    return [Math.max(24,Math.min(1176,px)),Math.max(120,Math.min(transform.height-40,py))]
  }
  return transform.projected[annotation.pointIndex]
}
/** Photos alternate beside their markers; stored user positions always win. */
export function annotationPhotoLayouts(annotations:readonly TrackAnnotation[],points:readonly TrackPoint[]=[]) {
  const nextY=[150,150]
  return annotations.filter(annotation=>annotation.photo).map((annotation,index)=>{
    const side=index%2,markerY=points.length?annotationPosition(annotation,points)[1]:220+Math.floor(index/2)*240
    const y=annotation.photo!.y??Math.max(150,markerY-100,nextY[side]);nextY[side]=y+225
    return {annotation,x:annotation.photo!.x??(side?840:40),y}
  })
}
export function annotationsFromPlacemarks(placemarks:readonly TrackPlacemark[],points:readonly TrackPoint[]):TrackAnnotation[] {
  return placemarks.slice(0,100).map((placemark,index)=>{
    let pointIndex=0,distance=Infinity
    points.forEach(([lon,lat],index)=>{const dx=((lon-placemark.coordinates[0]+540)%360)-180,next=(dx*Math.cos(lat*Math.PI/180))**2+(lat-placemark.coordinates[1])**2;if(next<distance){distance=next;pointIndex=index}})
    return {id:placemark.id,sourceId:placemark.id,sourceCoordinates:placemark.coordinates,pointIndex,label:Array.from(placemark.name.trim()||`点位 ${index+1}`).slice(0,80).join(''),color:ANNOTATION_COLORS[0],description:placemark.description,imageUrls:placemark.images}
  })
}

function artPalette(theme?:ArtTheme) {
  return theme==='dark'?{background:'#171d23',foreground:'#f1f3f5',muted:'#b5bec7',route:'#ff8c7c'}:theme==='light'?{background:'#fff',foreground:'#303530',muted:'#757d76',route:'#e65f55'}:{background:'#fffdf6',foreground:'#413b32',muted:'#91958b',route:'#e65f55'}
}
function artSceneHeight(points:readonly TrackPoint[],annotations:readonly TrackAnnotation[],layout:ArtLayout={}) {
  const visible=annotations.filter(annotationVisible),photos=annotationPhotoLayouts(annotations,points).filter(({annotation})=>annotationVisible(annotation))
  return Math.max(diagramHeight(points),...photos.map(photo=>photo.y+240),...visible.map(annotation=>annotationPosition(annotation,points)[1]+70),...Object.entries(layout).map(([id,position])=>position.y+(id==='title'?56:id==='north'?24:26)))
}
export function artTextPosition(id:ArtTextId,points:readonly TrackPoint[],annotations:readonly TrackAnnotation[],layout:ArtLayout={}):[number,number] {
  const positions=validateArtLayout(layout),stored=positions[id]
  if(stored)return [stored.x,stored.y]
  if(id==='title')return [50,62]
  if(id==='north')return [50,artSceneHeight(points,annotations,positions)-24]
  const pixels=diagramCoordinates(points),point=id==='start'?pixels[0]:pixels[pixels.length-1]
  return [point[0]+(id==='start'?14:-14),point[1]+(id==='start'?25:43)]
}
/** A transparent route layer contains geographic path data only. */
export function routeSvg(points:readonly TrackPoint[],options:{theme?:ArtTheme}={}):string {
  if(points.length<2)throw new Error('轨迹至少需要 2 个点才能绘图')
  const height=diagramHeight(points),path=diagramCoordinates(points).map(([x,y],index)=>`${index?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" data-route-layer="" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-label="轨迹路线"><title>轨迹路线</title><desc>${points.length} 个轨迹点的路线示意图。</desc><path data-route="" d="${path}" fill="none" stroke="${artPalette(options.theme).route}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}
function routeEndpoints(points:readonly TrackPoint[],theme?:ArtTheme):string {
  const pixels=diagramCoordinates(points),start=pixels[0],end=pixels[pixels.length-1],closed=Math.hypot(start[0]-end[0],start[1]-end[1])<1
  return `<g data-art-layer="endpoints"><circle cx="${start[0].toFixed(2)}" cy="${start[1].toFixed(2)}" r="9" fill="#20986a" stroke="${artPalette(theme).background}" stroke-width="3"/><ellipse cx="${end[0].toFixed(2)}" cy="${end[1].toFixed(2)}" rx="${closed?16:10}" ry="${closed?16:10}" fill="none" stroke="#cf3330" stroke-width="4"/></g>`
}
/** The live route SVG contains path and endpoint symbols; its annotations are a separate synchronized layer. */
export function routeCanvasSvg(points:readonly TrackPoint[],options:{theme?:ArtTheme}={}):string {
  return routeSvg(points,options).replace('</svg>',`${routeEndpoints(points,options.theme)}</svg>`)
}
/** Export keeps route-bound annotations synchronized while title and direction stay fixed. */
export function trackSvg(points:readonly TrackPoint[],options:{name:string;annotations?:readonly TrackAnnotation[];theme?:ArtTheme;mode?:'route'|'points';selectedId?:string|null;selectedTextId?:ArtTextId|null;layout?:ArtLayout;route?:ArtRouteTransform;layer?:'all'|'overlay';interactive?:boolean}):string {
  if(points.length<2)throw new Error('轨迹至少需要 2 个点才能绘图')
  const annotations=validateAnnotations(options.annotations??[],points.length),layout=validateArtLayout(options.layout),route=validateArtRouteTransform(options.route),palette=artPalette(options.theme)
  const visibleAnnotations=annotations.filter(annotationVisible),photos=annotationPhotoLayouts(annotations,points).filter(({annotation})=>annotationVisible(annotation))
  const height=artSceneHeight(points,annotations,layout),metrics=editedMetrics(points),routeTransform=`translate(${route.x*route.scale} ${route.y*route.scale}) scale(${route.scale})`
  const elements=[`<svg xmlns="http://www.w3.org/2000/svg" data-art-scene="" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="${options.interactive?'group':'img'}" aria-labelledby="title desc" font-family="system-ui,Microsoft YaHei,sans-serif">`,
    `<title id="title">${escapeXml(options.name)} · 轨迹标注图</title><desc id="desc">${points.length} 个轨迹点，${visibleAnnotations.length} 个标注。此图为轨迹示意图。</desc>`,
    `<rect data-art-layer="background" width="1200" height="${height}" fill="${options.layer==='overlay'?'transparent':palette.background}"${options.layer==='overlay'?' pointer-events="all"':''}/>`]
  if(options.layer!=='overlay')elements.push(`<g data-route-transform="" transform="${routeTransform}">${routeSvg(points,{theme:options.theme})}${routeEndpoints(points,options.theme)}</g>`)
  elements.push(`<g data-route-annotations="" transform="${routeTransform}"><g data-art-layer="connectors">`)
  for(const {annotation,x,y} of photos){const [mx,my]=annotationPosition(annotation,points);elements.push(`<path data-connector-id="${annotation.id}" pointer-events="none" d="${photoConnector(mx,my,x,y)}" fill="none" stroke="${palette.muted}" stroke-width="2" stroke-dasharray="6 5"/>`)}
  elements.push('</g><g data-art-layer="photos">')
  for(const {annotation,x,y} of photos){const number=annotations.findIndex(item=>item.id===annotation.id)+1,selected=options.selectedId===annotation.id
    elements.push(`<g data-photo-id="${annotation.id}" tabindex="0" role="button" aria-label="${escapeXml(annotation.label)}的照片" style="cursor:grab"><rect x="${x}" y="${y}" width="320" height="200" rx="4" fill="${palette.background}" stroke="${selected?'#ea793a':palette.muted}" stroke-width="${selected?3:1}"/><image href="${annotation.photo!.dataUrl}" x="${x+2}" y="${y+2}" width="316" height="196" preserveAspectRatio="xMidYMid slice"/><rect x="${x+10}" y="${y+12}" width="${Math.min(296,60+Array.from(annotation.label).length*17)}" height="30" rx="5" fill="#203a3e" fill-opacity=".92"/><text x="${x+20}" y="${y+34}" font-size="17" font-weight="700" fill="#fff">${number} · ${escapeXml(Array.from(annotation.label).slice(0,13).join(''))}</text></g>`)}
  elements.push('</g><g data-art-layer="annotations">')
  annotations.forEach((annotation,index)=>{if(!annotationVisible(annotation))return;const [x,y]=annotationPosition(annotation,points),selected=options.selectedId===annotation.id
    elements.push(`<g data-annotation-id="${annotation.id}" tabindex="0" role="button" aria-label="编辑点位 ${index+1}：${escapeXml(annotation.label)}" style="cursor:grab">${selected?`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="22" fill="none" stroke="#ea793a" stroke-width="3"/>`:''}<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="16" fill="${annotation.color}" stroke="${palette.background}" stroke-width="2"/><text x="${x.toFixed(2)}" y="${(y+5).toFixed(2)}" text-anchor="middle" font-size="13" font-weight="700" fill="${annotationTextColor(annotation.color)}">${index+1}</text><text x="${(x+23).toFixed(2)}" y="${(y-15).toFixed(2)}" font-size="17" font-weight="600" fill="${palette.foreground}">${escapeXml(Array.from(annotation.label).slice(0,18).join(''))}</text></g>`)} )
  elements.push('</g>')
  const texts=ART_TEXT_LABELS.map(item=>{
    const [x,y]=artTextPosition(item.id,points,annotations,layout),title=item.id==='title',label=title?Array.from(options.name).slice(0,40).join(''):item.id==='start'?'起点':item.id==='end'?'终点':'轨迹示意图 · 北 ↑'
    const width=title?Math.min(1100,Math.max(300,Array.from(label).length*28)):item.id==='north'?170:48
    const top=y-(title?30:18),boxHeight=title?72:28,selected=options.interactive && options.selectedTextId===item.id
    return {id:item.id,svg:`<g data-art-text-id="${item.id}"${options.interactive?` tabindex="0" role="button" aria-label="移动${item.label}" style="cursor:grab"`:''}>${options.interactive?`<rect data-art-text-hit="" x="${x-8}" y="${top}" width="${width+16}" height="${boxHeight}" fill="transparent" pointer-events="all"${selected?' stroke="#ea793a" stroke-width="2" stroke-dasharray="5 4"':''}/>`:''}<text x="${x}" y="${y}" font-size="${title?28:item.id==='north'?13:15}"${title?' font-weight="700"':''} fill="${item.id==='north'?palette.muted:palette.foreground}">${escapeXml(label)}</text>${title?`<text x="${x}" y="${y+32}" font-size="15" fill="${palette.muted}">${(metrics.distance/1000).toFixed(2)} km · ${visibleAnnotations.length} 个标注</text>`:''}</g>`}
  })
  elements.push(...texts.filter(item=>item.id==='start' || item.id==='end').map(item=>item.svg),'</g>',...texts.filter(item=>item.id==='title' || item.id==='north').map(item=>item.svg))
  elements.push('</svg>')
  return elements.join('')
}
export function photoConnector(mx:number,my:number,x:number,y:number):string {const tx=Math.max(x,Math.min(x+320,mx)),ty=Math.max(y,Math.min(y+200,my));return `M${mx.toFixed(2)},${my.toFixed(2)} L${tx.toFixed(2)},${ty.toFixed(2)}`}
function escapeXml(value:string):string {if(invalidXml.test(value))throw new Error('名称含有非法 XML 字符');return value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&apos;')}
