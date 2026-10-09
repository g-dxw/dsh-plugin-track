import type { TrackPoint, TrackPlacemark } from '../protocol.ts'
import { mercatorY } from './sandbox/coordinates.ts'
import { editedMetrics } from './edit.ts'
import { imageLink } from './placemarks.ts'
import { ART_FONT_FAMILIES, getArtBackground, getArtElementStyle, getArtPalette, getArtRouteStyle, getArtTextStyle, validateArtElementStyle, validateArtStyles, type ArtElementStyle, type ArtStyles } from './art-styles.ts'

export type AnnotationKind = 'checkin' | 'rest' | 'toilet' | 'supply' | 'note'
export const ANNOTATION_KINDS: {id: AnnotationKind; label: string; symbol: string}[] = [{id:'note',label:'普通标注',symbol:''},{id:'checkin',label:'打卡点',symbol:'✓'},{id:'rest',label:'休息点',symbol:'休'},{id:'toilet',label:'厕所',symbol:'WC'},{id:'supply',label:'补给点',symbol:'+'}]
export interface TrackAnnotation {
  id: string; pointIndex: number; label: string; color: string; kind?: AnnotationKind; visible?: boolean
  description?: string; imageUrls?: string[]; sourceId?: string; sourceCoordinates?: [number,number]
  style?: ArtElementStyle
  /** Marker and photo positions use the route-local artwork coordinates. */
  position?: {x:number;y:number}
  photo?: {dataUrl:string;x?:number;y?:number;sourceUrl?:string}
}
export function annotationVisible(annotation:TrackAnnotation):boolean {return annotation.visible??(annotation.kind!==undefined && annotation.kind!=='note')}
export type ArtTheme = 'light' | 'dark' | 'paper'
export type ArtTextId = 'title' | 'start' | 'end' | 'north'
export type ArtLayout = Partial<Record<ArtTextId, {x:number;y:number}>>
export interface ArtRouteTransform {x:number;y:number;scale:number}
export interface ArtCanvasSize {width:number;height:number}
export const DEFAULT_ART_CANVAS_SIZE:ArtCanvasSize={width:1200,height:900}
/** Canvas pixels affect export dimensions; artwork coordinates remain 1200 units wide. */
export function validateArtCanvasSize(value:unknown):ArtCanvasSize {
  if(value===undefined)return {...DEFAULT_ART_CANVAS_SIZE}
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('画布尺寸无效')
  const canvas=value as Partial<ArtCanvasSize>
  if(Object.keys(value).some(key=>key!=='width' && key!=='height') || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width!<240 || canvas.width!>4096 || canvas.height!<240 || canvas.height!>4096)throw new Error('画布宽高需要 240 至 4096 的整数像素')
  return {width:canvas.width!,height:canvas.height!}
}
/** Route camera values use the fixed 1200-wide artwork coordinate system. */
export function validateArtRouteTransform(value:unknown):ArtRouteTransform {
  if(value===undefined)return {x:0,y:0,scale:1}
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('轨迹图层变换无效')
  const transform=value as Partial<ArtRouteTransform>
  if(Object.keys(value).some(key=>key!=='x' && key!=='y' && key!=='scale') || typeof transform.x!=='number' || typeof transform.y!=='number' || typeof transform.scale!=='number' || !Number.isFinite(transform.x) || !Number.isFinite(transform.y) || !Number.isFinite(transform.scale) || Math.abs(transform.x)>10000 || Math.abs(transform.y)>10000 || transform.scale<.001 || transform.scale>4)throw new Error('轨迹图层变换无效')
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
const invalidXmlOutput = new RegExp(invalidXml.source,'gu')
function validPosition(x:number,y:number,maximumX:number) {return Number.isFinite(x) && x>=0 && x<=maximumX && Number.isFinite(y) && y>=0 && y<=9000}
export function validateAnnotations(value:unknown,pointCount:number):TrackAnnotation[] {
  if (!Array.isArray(value) || value.length>100) throw new Error('最多可添加 100 个轨迹标注')
  const ids = new Set<string>(); let photoBytes=0,photoCount=0
  return value.map(raw=>{
    if (!raw || typeof raw!=='object') throw new Error('标注格式无效')
    const item=raw as Partial<TrackAnnotation>
    if (typeof item.id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id)) throw new Error('标注编号无效或重复')
    if (!Number.isInteger(item.pointIndex) || item.pointIndex!<0 || item.pointIndex!>=pointCount) throw new Error('标注点序号无效')
    if (item.sourceId!==undefined && (typeof item.sourceId!=='string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.sourceId))) throw new Error('来源点位无效')
    const labelLimit=item.sourceId?160:80,descriptionLimit=item.sourceId?10000:4000
    if (typeof item.label!=='string' || !item.label.trim() || Array.from(item.label).length>labelLimit || (!item.sourceId && invalidXml.test(item.label))) throw new Error(`标注名称需要 1 至 ${labelLimit} 个有效字符`)
    if (typeof item.color!=='string' || !/^#[0-9a-f]{6}$/iu.test(item.color)) throw new Error('标注颜色无效')
    if (item.kind!==undefined && !ANNOTATION_KINDS.some(kind=>kind.id===item.kind)) throw new Error('标注类别无效')
    if (item.visible!==undefined && typeof item.visible!=='boolean') throw new Error('标注显示设置无效')
    if (item.description!==undefined && (typeof item.description!=='string' || item.description.length>descriptionLimit || (!item.sourceId && invalidXml.test(item.description)))) throw new Error(`点位说明最多 ${descriptionLimit} 个有效字符`)
    if (item.imageUrls!==undefined && (!Array.isArray(item.imageUrls) || item.imageUrls.length>30 || item.imageUrls.some(url=>typeof url!=='string' || url.length>4096 || !imageLink(url)))) throw new Error('标注图片链接无效')
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
    return {id:item.id,pointIndex:item.pointIndex!,label:item.sourceId?item.label:item.label.trim(),color:item.color,
      ...(item.kind===undefined?{}:{kind:item.kind}),...(item.visible===undefined?{}:{visible:item.visible}),...(item.description===undefined?{}:{description:item.description}),
      ...(item.imageUrls===undefined?{}:{imageUrls:[...new Set(item.imageUrls)]}),...(item.sourceId===undefined?{}:{sourceId:item.sourceId}),
      ...(item.sourceCoordinates===undefined?{}:{sourceCoordinates:[...item.sourceCoordinates] as [number,number]}),
      ...(item.position===undefined?{}:{position:{x:item.position.x,y:item.position.y}}),...(item.style===undefined?{}:{style:validateArtElementStyle(item.style)}),...(photo?{photo}:{})}
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
/** The geographic source anchor stays independent of marker and photo layout. */
export function annotationAnchorPosition(annotation:TrackAnnotation,points:readonly TrackPoint[]):[number,number] {
  const transform=projection(points)
  if (annotation.sourceCoordinates) {
    let x=(annotation.sourceCoordinates[0]+180)/360
    while(x-transform.centerX>.5)x-=1;while(x-transform.centerX<-.5)x+=1
    return transform.pixel(x,mercatorY(annotation.sourceCoordinates[1]))
  }
  return transform.projected[annotation.pointIndex]
}
export function annotationPosition(annotation:TrackAnnotation,points:readonly TrackPoint[]):[number,number] {
  if (annotation.position) return [annotation.position.x,annotation.position.y]
  const [x,y]=annotationAnchorPosition(annotation,points)
  return annotation.sourceCoordinates?[Math.max(24,Math.min(1176,x)),Math.max(120,Math.min(projection(points).height-40,y))]:[x,y]
}
/** Photos alternate beside their markers; stored user positions always win. */
export function annotationPhotoLayouts(annotations:readonly TrackAnnotation[],points:readonly TrackPoint[]=[],styles:ArtStyles={}) {
  const nextY=[150,150]
  return annotations.filter(annotation=>annotation.photo).map((annotation,index)=>{
    const style=getArtElementStyle(annotation,styles),side=index%2,markerY=points.length?annotationPosition(annotation,points)[1]:220+Math.floor(index/2)*240
    const y=annotation.photo!.y??Math.max(150,markerY-style.photoHeight/2,nextY[side]);nextY[side]=y+style.photoHeight+25
    const defaultX=side?Math.max(40,1160-style.photoWidth):40,maximumX=Math.min(880,Math.max(0,1200-style.photoWidth))
    return {annotation,x:annotation.photo!.x??Math.min(maximumX,defaultX),y,width:style.photoWidth,height:style.photoHeight,style}
  })
}
/** Fits visible route artwork without rewriting route-local marker or photo positions. */
export function fitArtRouteToCanvas(points:readonly TrackPoint[],annotations:readonly TrackAnnotation[],canvas:ArtCanvasSize,styles:ArtStyles={}):ArtRouteTransform {
  if(points.length<2)throw new Error('轨迹至少需要 2 个点才能绘图')
  const size=validateArtCanvasSize(canvas),items=validateAnnotations(annotations,points.length),visible=items.filter(annotationVisible),appearance=validateArtStyles(styles),routeStyle=getArtRouteStyle(appearance)
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity
  const include=(x:number,y:number,width:number=0,height:number=0)=>{left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+width);bottom=Math.max(bottom,y+height)}
  // Endpoint rings are slightly larger than the path stroke, including a closed route's outer ring.
  for(const [x,y] of diagramCoordinates(points)){const radius=Math.max(18,routeStyle.startRadius+2,routeStyle.endRadius+8,routeStyle.width/2);include(x-radius,y-radius,radius*2,radius*2)}
  for(const annotation of visible) {
    const [x,y]=annotationPosition(annotation,points),style=getArtElementStyle(annotation,appearance),label=annotationDisplayLabel(annotation,style,appearance),radius=style.markerRadius+style.markerBorderWidth/2
    include(x-radius,y-radius,radius*2,radius*2)
    const tx=x+23+style.textOffsetX,ty=y-15+style.textOffsetY
    include(tx,ty-style.textSize,Math.max(1,Array.from(label).length*style.textSize),style.textSize*1.3)
    if(annotation.sourceId && annotation.sourceCoordinates){const [ax,ay]=annotationAnchorPosition(annotation,points);include(ax-5,ay-5,10,10)}
  }
  for(const {annotation,x,y,width,height,style} of annotationPhotoLayouts(items,points,appearance))if(annotationVisible(annotation)){const border=style.photoBorderWidth/2;include(x-border,y-border,width+border*2,height+border*2);const tx=x+20+style.textOffsetX,ty=y+34+style.textOffsetY,caption=photoCaptionLayout(annotation,style,appearance,items.findIndex(item=>item.id===annotation.id)+1);include(tx-10,ty+caption.top,caption.width,caption.height)}
  const height=1200*size.height/size.width,padding=24,scale=Math.min(4,(1200-padding*2)/Math.max(1,right-left),(height-padding*2)/Math.max(1,bottom-top))
  const position=(minimum:number,maximum:number,extent:number)=>{
    const low=Math.max(-10000,padding/scale-minimum),high=Math.min(10000,(extent-padding)/scale-maximum)
    if(low>high+1e-8)throw new Error('标注范围过大，无法适配画布，请调整远离轨迹的点位')
    // Very wide canvases may need a smaller horizontal offset than exact centering permits.
    return Math.max(low,Math.min(high,extent/2/scale-(minimum+maximum)/2))
  }
  try{return validateArtRouteTransform({x:position(left,right,1200),y:position(top,bottom,height),scale})}catch{throw new Error('标注范围过大，无法适配画布，请调整远离轨迹的点位')}
}
const nearestPointCache=new WeakMap<readonly TrackPoint[],WeakMap<readonly [number,number],number>>()
function nearestAnnotationPointIndex(coordinates:readonly [number,number],points:readonly TrackPoint[]):number {
  let cache=nearestPointCache.get(points)
  if(!cache){cache=new WeakMap();nearestPointCache.set(points,cache)}
  const stored=cache.get(coordinates);if(stored!==undefined)return stored
  let pointIndex=0,distance=Infinity
  points.forEach(([lon,lat],index)=>{const dx=((lon-coordinates[0]+540)%360)-180,next=(dx*Math.cos(lat*Math.PI/180))**2+(lat-coordinates[1])**2;if(next<distance){distance=next;pointIndex=index}})
  cache.set(coordinates,pointIndex)
  return pointIndex
}
export function annotationsFromPlacemarks(placemarks:readonly TrackPlacemark[],points:readonly TrackPoint[]):TrackAnnotation[] {
  return placemarks.slice(0,100).map((placemark,index)=>({id:placemark.id,sourceId:placemark.id,sourceCoordinates:[...placemark.coordinates] as [number,number],pointIndex:nearestAnnotationPointIndex(placemark.coordinates,points),label:placemark.name.trim()||`点位 ${index+1}`,color:ANNOTATION_COLORS[0],description:placemark.description,imageUrls:[...placemark.images]}))
}

function artSceneHeight(points:readonly TrackPoint[],annotations:readonly TrackAnnotation[],layout:ArtLayout={},styles:ArtStyles={}) {
  const visible=annotations.filter(annotationVisible),photos=annotationPhotoLayouts(annotations,points,styles).filter(({annotation})=>annotationVisible(annotation))
  return Math.max(diagramHeight(points),...photos.map(photo=>photo.y+photo.height+40+Math.max(0,photo.style.textOffsetY)),...visible.map(annotation=>{const style=getArtElementStyle(annotation,styles);return annotationPosition(annotation,points)[1]+Math.max(70,style.markerRadius+8,style.textOffsetY+style.textSize)}),...Object.entries(layout).map(([id,position])=>{const style=getArtTextStyle(id as ArtTextId,styles);return position.y+(id==='title'?Math.max(56,style.textSize*2):Math.max(id==='north'?24:26,style.textSize*1.4))}))
}
export function artTextPosition(id:ArtTextId,points:readonly TrackPoint[],annotations:readonly TrackAnnotation[],layout:ArtLayout={},styles:ArtStyles={}):[number,number] {
  const positions=validateArtLayout(layout),stored=positions[id]
  if(stored)return [stored.x,stored.y]
  if(id==='title')return [50,62]
  if(id==='north')return [50,artSceneHeight(points,annotations,positions,styles)-24]
  const pixels=diagramCoordinates(points),point=id==='start'?pixels[0]:pixels[pixels.length-1]
  return [point[0]+(id==='start'?14:-14),point[1]+(id==='start'?25:43)]
}
/** A transparent route layer contains geographic path data only. */
export function routeSvg(points:readonly TrackPoint[],options:{theme?:ArtTheme;styles?:ArtStyles}={}):string {
  if(points.length<2)throw new Error('轨迹至少需要 2 个点才能绘图')
  const height=diagramHeight(points),path=diagramCoordinates(points).map(([x,y],index)=>`${index?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' '),style=getArtRouteStyle(validateArtStyles(options.styles),options.theme)
  return `<svg xmlns="http://www.w3.org/2000/svg" data-route-layer="" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-label="轨迹路线"><title>轨迹路线</title><desc>${points.length} 个轨迹点的路线示意图。</desc><path data-route="" data-art-style="route" d="${path}" fill="none" stroke="${style.color}" stroke-width="${style.width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}
function routeEndpoints(points:readonly TrackPoint[],theme?:ArtTheme,styles:ArtStyles={}):string {
  const pixels=diagramCoordinates(points),start=pixels[0],end=pixels[pixels.length-1],closed=Math.hypot(start[0]-end[0],start[1]-end[1])<1,style=getArtRouteStyle(styles,theme)
  const endRadius=closed?style.endRadius+6:style.endRadius
  return `<g data-art-layer="endpoints"><circle data-art-style="start-symbol" cx="${start[0].toFixed(2)}" cy="${start[1].toFixed(2)}" r="${style.startRadius}" fill="${style.startColor}" stroke="${getArtBackground(styles,theme)}" stroke-width="3"/><ellipse data-art-style="end-symbol" cx="${end[0].toFixed(2)}" cy="${end[1].toFixed(2)}" rx="${endRadius}" ry="${endRadius}" fill="none" stroke="${style.endColor}" stroke-width="4"/></g>`
}
/** The live route SVG contains path and endpoint symbols; its annotations are a separate synchronized layer. */
export function routeCanvasSvg(points:readonly TrackPoint[],options:{theme?:ArtTheme;styles?:ArtStyles}={}):string {
  return routeSvg(points,options).replace('</svg>',`${routeEndpoints(points,options.theme,validateArtStyles(options.styles))}</svg>`)
}
/** Export keeps route-bound annotations synchronized while title and direction stay fixed. */
export interface ArtSvgOptions {
  name:string;annotations?:readonly TrackAnnotation[];theme?:ArtTheme;mode?:'route'|'points';selectedId?:string|null;selectedTextId?:ArtTextId|null
  layout?:ArtLayout;route?:ArtRouteTransform;layer?:'all'|'overlay';interactive?:boolean;canvas?:ArtCanvasSize;annotationsOnly?:boolean;styles?:ArtStyles
}
function explicitElementStyle(annotation:TrackAnnotation,styles:ArtStyles):ArtElementStyle {return {...styles.defaults,...annotation.style}}
function annotationDisplayLabel(annotation:TrackAnnotation,_style:Required<ArtElementStyle>,styles:ArtStyles):string {return explicitElementStyle(annotation,styles).textSize===undefined?Array.from(annotation.label).slice(0,18).join(''):annotation.label}
function photoDisplayLabel(annotation:TrackAnnotation,_style:Required<ArtElementStyle>,styles:ArtStyles):string {return explicitElementStyle(annotation,styles).textSize===undefined?Array.from(annotation.label).slice(0,13).join(''):annotation.label}
function photoCaptionLayout(annotation:TrackAnnotation,style:Required<ArtElementStyle>,styles:ArtStyles,number:number) {
  const explicit=explicitElementStyle(annotation,styles),label=photoDisplayLabel(annotation,style,styles),content=`${number} · ${label}`
  if(explicit.textSize===undefined && explicit.photoWidth===undefined)return {lines:[content],width:Math.min(296,60+Array.from(label).length*17),height:30,top:-22,lineHeight:22}
  const characters=Array.from(content),limit=Math.max(1,Math.floor(Math.max(style.textSize,style.photoWidth-44)/style.textSize)),lines:string[]=[]
  for(let index=0;index<characters.length;index+=limit)lines.push(characters.slice(index,index+limit).join(''))
  return {lines,width:Math.max(style.textSize+20,Math.min(style.photoWidth-24,Math.max(...lines.map(line=>Array.from(line).length))*style.textSize+20)),height:Math.max(30,lines.length*style.textSize*1.3+8),top:-style.textSize-5,lineHeight:style.textSize*1.3}
}
function textAttributes(style:{textColor:string;textSize:number;fontFamily:'sans'|'serif'|'mono';fontWeight:number}):string {return `font-size="${style.textSize}" font-weight="${style.fontWeight}" font-family="${ART_FONT_FAMILIES[style.fontFamily]}" fill="${style.textColor}"`}
export function trackSvg(points:readonly TrackPoint[],options:ArtSvgOptions):string {
  if(points.length<2)throw new Error('轨迹至少需要 2 个点才能绘图')
  const annotations=validateAnnotations(options.annotations??[],points.length),layout=validateArtLayout(options.layout),route=validateArtRouteTransform(options.route),styles=validateArtStyles(options.styles),palette=getArtPalette(options.theme)
  const visibleAnnotations=annotations.filter(annotationVisible),photos=annotationPhotoLayouts(annotations,points,styles).filter(({annotation})=>annotationVisible(annotation))
  const canvas=options.canvas===undefined?null:validateArtCanvasSize(options.canvas),height=canvas?1200*canvas.height/canvas.width:artSceneHeight(points,annotations,layout,styles),metrics=editedMetrics(points),routeTransform=`translate(${route.x*route.scale} ${route.y*route.scale}) scale(${route.scale})`
  const elements=[`<svg xmlns="http://www.w3.org/2000/svg" data-art-scene="" width="${canvas?.width??1200}" height="${canvas?.height??height}" viewBox="0 0 1200 ${height}" role="${options.interactive?'group':'img'}" aria-labelledby="title desc" font-family="system-ui,Microsoft YaHei,sans-serif">`,
    options.annotationsOnly?`<title id="title">轨迹标注图</title><desc id="desc">轨迹线、标注、配图与连接线。</desc>`:`<title id="title">${escapeXml(options.name)} · 轨迹标注图</title><desc id="desc">${points.length} 个轨迹点，${visibleAnnotations.length} 个标注。此图为轨迹示意图。</desc>`,
    `<rect data-art-layer="background" width="1200" height="${height}" fill="${options.layer==='overlay'?'transparent':getArtBackground(styles,options.theme)}"${options.layer==='overlay'?' pointer-events="all"':''}/>`]
  if(options.layer!=='overlay'){const routeLayer=routeSvg(points,{theme:options.theme,styles});elements.push(`<g data-route-transform="" transform="${routeTransform}">${options.annotationsOnly?routeLayer.replace(/<desc>[^<]*<\/desc>/u,'<desc>轨迹路线。</desc>'):routeLayer}${routeEndpoints(points,options.theme,styles)}</g>`) }
  elements.push(`<g data-route-annotations="" transform="${routeTransform}"><g data-art-layer="connectors">`)
  for(const {annotation,x,y,width,height} of photos){const [mx,my]=annotationPosition(annotation,points),style=getArtElementStyle(annotation,styles,options.theme);elements.push(`<path data-connector-id="${annotation.id}" data-art-style="photo-connector" pointer-events="none" d="${photoConnector(mx,my,x,y,width,height)}" fill="none" stroke="${style.connectorColor}" stroke-width="${style.connectorWidth}"${style.connectorDash==='dashed'?' stroke-dasharray="6 5"':''}/>`)}
  elements.push('</g><g data-art-layer="anchors" pointer-events="none" aria-hidden="true">')
  for(const annotation of visibleAnnotations){
    if(!annotation.sourceId||!annotation.sourceCoordinates)continue
    const [ax,ay]=annotationAnchorPosition(annotation,points),[x,y]=annotationPosition(annotation,points),style=getArtElementStyle(annotation,styles,options.theme),explicit=explicitElementStyle(annotation,styles)
    elements.push(`<path data-anchor-connector-id="${annotation.id}" data-art-style="anchor-connector" pointer-events="none" d="${annotationAnchorConnector(ax,ay,x,y)}" fill="none" stroke="${explicit.connectorColor??style.markerColor}" stroke-width="${explicit.connectorWidth??1.5}"${style.connectorDash==='dashed'?' stroke-dasharray="4 3"':''}/><circle data-annotation-anchor-id="${annotation.id}" pointer-events="none" cx="${ax.toFixed(2)}" cy="${ay.toFixed(2)}" r="4" fill="${style.markerColor}" stroke="${getArtBackground(styles,options.theme)}" stroke-width="1.5"/>`)
  }
  elements.push('</g><g data-art-layer="photos">')
  for(const photo of photos){const {annotation,x,y,width,height}=photo,style=getArtElementStyle(annotation,styles,options.theme),explicit=explicitElementStyle(annotation,styles),number=annotations.findIndex(item=>item.id===annotation.id)+1,selected=options.selectedId===annotation.id,caption=photoCaptionLayout(annotation,style,styles,number)
    const border=style.photoBorderWidth,inset=Math.min(Math.max(2,border),(Math.min(width,height)-1)/2),imageWidth=Math.max(1,width-inset*2),imageHeight=Math.max(1,height-inset*2),captionX=x+20+style.textOffsetX,captionY=y+34+style.textOffsetY,clipId=`art-photo-clip-${annotation.id}`
    elements.push(`<g data-photo-id="${annotation.id}" tabindex="0" role="button" aria-label="${escapeAnnotationLabel(annotation)}的照片" style="cursor:grab"><rect data-art-style="photo-frame" x="${x}" y="${y}" width="${width}" height="${height}" rx="${style.photoRadius}" fill="${getArtBackground(styles,options.theme)}" stroke="${selected?'#ea793a':style.photoBorderColor}" stroke-width="${selected?Math.max(3,border):border}"/><defs><clipPath id="${clipId}"><rect x="${x+inset}" y="${y+inset}" width="${imageWidth}" height="${imageHeight}" rx="${Math.max(0,style.photoRadius-inset)}"/></clipPath></defs><image href="${annotation.photo!.dataUrl}" x="${x+inset}" y="${y+inset}" width="${imageWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid ${style.photoFit==='contain'?'meet':'slice'}" clip-path="url(#${clipId})"/><rect data-art-style="photo-caption-background" x="${captionX-10}" y="${captionY+caption.top}" width="${caption.width}" height="${caption.height}" rx="5" fill="${style.photoCaptionBackground}" fill-opacity=".92"/><text data-art-style="photo-caption" x="${captionX}" y="${captionY}" ${textAttributes({...style,textColor:explicit.textColor??'#fff',fontWeight:explicit.fontWeight??700})}>${caption.lines.length===1?escapeAnnotationLabel(annotation,caption.lines[0]):caption.lines.map((line,index)=>`<tspan x="${captionX}" dy="${index?caption.lineHeight:0}">${escapeAnnotationLabel(annotation,line)}</tspan>`).join('')}</text></g>`)}
  elements.push('</g><g data-art-layer="annotations">')
  annotations.forEach((annotation,index)=>{if(!annotationVisible(annotation))return;const [x,y]=annotationPosition(annotation,points),selected=options.selectedId===annotation.id,style=getArtElementStyle(annotation,styles,options.theme),explicit=explicitElementStyle(annotation,styles)
    elements.push(`<g data-annotation-id="${annotation.id}" tabindex="0" role="button" aria-label="编辑点位 ${index+1}：${escapeAnnotationLabel(annotation)}" style="cursor:grab">${selected?`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${style.markerRadius+6}" fill="none" stroke="#ea793a" stroke-width="3"/>`:''}<circle data-art-style="marker" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${style.markerRadius}" fill="${style.markerColor}" stroke="${style.markerBorderColor}" stroke-width="${style.markerBorderWidth}"/><text data-art-style="number" x="${x.toFixed(2)}" y="${(y+style.numberSize*5/13).toFixed(2)}" text-anchor="middle" ${textAttributes({...style,textColor:style.numberColor,textSize:style.numberSize,fontWeight:explicit.fontWeight??700})}>${index+1}</text><text data-art-style="label" x="${(x+23+style.textOffsetX).toFixed(2)}" y="${(y-15+style.textOffsetY).toFixed(2)}" ${textAttributes(style)}>${escapeAnnotationLabel(annotation,annotationDisplayLabel(annotation,style,styles))}</text></g>`)} )
  elements.push('</g>')
  const texts=options.annotationsOnly?[]:ART_TEXT_LABELS.map(item=>{
    const [x,y]=artTextPosition(item.id,points,annotations,layout,styles),title=item.id==='title',style=getArtTextStyle(item.id,styles,options.theme),explicit={...styles.defaults,...styles.texts?.[item.id]},label=title?Array.from(options.name).slice(0,40).join(''):item.id==='start'?'起点':item.id==='end'?'终点':'轨迹示意图 · 北 ↑'
    const statsStyle={...style,textColor:explicit.textColor??palette.muted,textSize:explicit.textSize??15,fontWeight:explicit.fontWeight??400},statsOffset=explicit.textSize===undefined?32:Math.max(32,style.textSize*1.2),width=title?Math.min(4000,Math.max(300,Array.from(label).length*style.textSize)):Math.max(item.id==='north'?170:48,Array.from(label).length*style.textSize)
    const top=y-(title?(explicit.textSize===undefined?30:Math.max(30,style.textSize*1.1)):Math.max(18,style.textSize)),boxHeight=title?Math.max(72,style.textSize*1.1+statsOffset+statsStyle.textSize*.4):Math.max(28,style.textSize*1.4),selected=options.interactive && options.selectedTextId===item.id
    return {id:item.id,svg:`<g data-art-text-id="${item.id}"${options.interactive?` tabindex="0" role="button" aria-label="移动${item.label}" style="cursor:grab"`:''}>${options.interactive?`<rect data-art-text-hit="" x="${x-8}" y="${top}" width="${width+16}" height="${boxHeight}" fill="transparent" pointer-events="all"${selected?' stroke="#ea793a" stroke-width="2" stroke-dasharray="5 4"':''}/>`:''}<text data-art-style="${item.id}" x="${x}" y="${y}" ${textAttributes(style)}>${escapeXml(label)}</text>${title?`<text data-art-style="statistics" x="${x}" y="${y+statsOffset}" ${textAttributes(statsStyle)}>${(metrics.distance/1000).toFixed(2)} km · ${visibleAnnotations.length} 个标注</text>`:''}</g>`}
  })
  elements.push(...texts.filter(item=>item.id==='start' || item.id==='end').map(item=>item.svg),'</g>',...texts.filter(item=>item.id==='title' || item.id==='north').map(item=>item.svg))
  elements.push('</svg>')
  return elements.join('')
}
export function annotationAnchorConnector(ax:number,ay:number,x:number,y:number):string {return `M${ax.toFixed(2)},${ay.toFixed(2)} L${x.toFixed(2)},${y.toFixed(2)}`}
export function photoConnector(mx:number,my:number,x:number,y:number,width=320,height=200):string {const tx=Math.max(x,Math.min(x+width,mx)),ty=Math.max(y,Math.min(y+height,my));return `M${mx.toFixed(2)},${my.toFixed(2)} L${tx.toFixed(2)},${ty.toFixed(2)}`}
function escapeAnnotationLabel(annotation:TrackAnnotation,value:string=annotation.label):string {return escapeXml(annotation.sourceId?value.replace(invalidXmlOutput,'\ufffd'):value)}
function escapeXml(value:string):string {if(invalidXml.test(value))throw new Error('名称含有非法 XML 字符');return value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&apos;')}
