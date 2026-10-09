import type { ArtTheme, ArtTextId, TrackAnnotation } from './annotations.ts'

export type ArtFontFamily = 'sans' | 'serif' | 'mono'
export type ArtFontWeight = 400 | 500 | 600 | 700
export interface ArtTextStyle {textColor?:string;textSize?:number;fontFamily?:ArtFontFamily;fontWeight?:ArtFontWeight}
/** Explicit values override the shared defaults without changing artwork coordinates. */
export interface ArtElementStyle extends ArtTextStyle {
  textOffsetX?:number;textOffsetY?:number;numberColor?:string;numberSize?:number
  markerColor?:string;markerRadius?:number;markerBorderColor?:string;markerBorderWidth?:number
  connectorColor?:string;connectorWidth?:number;connectorDash?:'solid'|'dashed'
  photoWidth?:number;photoHeight?:number;photoRadius?:number;photoBorderColor?:string;photoBorderWidth?:number
  photoFit?:'cover'|'contain';photoCaptionBackground?:string
}
export interface ArtRouteStyle {color?:string;width?:number;startColor?:string;endColor?:string;startRadius?:number;endRadius?:number}
export interface ArtStyles {defaults?:ArtElementStyle;texts?:Partial<Record<ArtTextId,ArtTextStyle>>;route?:ArtRouteStyle;background?:string}
export const ART_FONT_FAMILIES:Record<ArtFontFamily,string>={sans:'system-ui,Microsoft YaHei,sans-serif',serif:'Georgia,Songti SC,SimSun,serif',mono:'Consolas,Menlo,monospace'}
export const ART_STYLE_BOUNDS={textSize:[8,120],textOffsetX:[-1000,1000],textOffsetY:[-1000,1000],numberSize:[8,64],markerRadius:[4,80],markerBorderWidth:[0,16],connectorWidth:[0,20],photoWidth:[24,1200],photoHeight:[24,1200],photoRadius:[0,120],photoBorderWidth:[0,20]} as const
export const ART_STYLE_LIMITS:Record<string,{min:number;max:number}>=Object.fromEntries(Object.entries(ART_STYLE_BOUNDS).map(([key,[min,max]])=>[key,{min,max}]))
const textKeys=['textColor','textSize','fontFamily','fontWeight'] as const
const colorKeys=new Set(['textColor','numberColor','markerColor','markerBorderColor','connectorColor','photoBorderColor','photoCaptionBackground','color','startColor','endColor','background'])
const enums:Record<string,readonly (string|number)[]>={fontFamily:['sans','serif','mono'],fontWeight:[400,500,600,700],connectorDash:['solid','dashed'],photoFit:['cover','contain']}
const elementKeys=[...textKeys,...Object.keys(ART_STYLE_BOUNDS),'numberColor','markerColor','markerBorderColor','connectorColor','connectorDash','photoBorderColor','photoFit','photoCaptionBackground']
function plain(value:unknown,label:string):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error(`${label}无效`)
  return value as Record<string,unknown>
}
function color(value:unknown):value is string {return typeof value==='string' && (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value)||value==='transparent')}
function validateFields(value:unknown,keys:readonly string[],label:string,bounds:Record<string,readonly [number,number]>=ART_STYLE_BOUNDS):Record<string,unknown> {
  if(value===undefined)return {}
  const input=plain(value,label),output:Record<string,unknown>={}
  for(const [key,item] of Object.entries(input)) {
    if(!keys.includes(key))throw new Error(`${label}包含未知选项`)
    if(item===undefined)continue
    if(colorKeys.has(key)){if(!color(item))throw new Error(`${label}颜色无效`)}
    else if(enums[key]){if(!enums[key].includes(item as string|number))throw new Error(`${label}选项无效`)}
    else {const range=bounds[key];if(!range || typeof item!=='number' || !Number.isFinite(item) || item<range[0] || item>range[1])throw new Error(`${label}尺寸或位置超出范围`)}
    output[key]=item
  }
  return output
}
export function validateArtTextStyle(value:unknown):ArtTextStyle {return validateFields(value,textKeys,'文字样式') as ArtTextStyle}
export function validateArtElementStyle(value:unknown):ArtElementStyle {return validateFields(value,elementKeys,'标注样式') as ArtElementStyle}
export function validateArtStyles(value:unknown):ArtStyles {
  if(value===undefined)return {}
  const input=plain(value,'画布样式'),output:ArtStyles={}
  if(Object.keys(input).some(key=>!['defaults','texts','route','background'].includes(key)))throw new Error('画布样式包含未知选项')
  if(input.defaults!==undefined)output.defaults=validateArtElementStyle(input.defaults)
  if(input.texts!==undefined){const texts=plain(input.texts,'画布文字样式');output.texts={};for(const [id,style] of Object.entries(texts)){if(!['title','start','end','north'].includes(id))throw new Error('画布文字样式选项无效');output.texts[id as ArtTextId]=validateArtTextStyle(style)}}
  if(input.route!==undefined)output.route=validateFields(input.route,['color','width','startColor','endColor','startRadius','endRadius'],'轨迹样式',{width:[.5,40],startRadius:[2,80],endRadius:[2,80]}) as ArtRouteStyle
  if(input.background!==undefined){if(!color(input.background))throw new Error('画布背景颜色无效');output.background=input.background}
  return output
}
export function getArtPalette(theme:ArtTheme='paper') {
  return theme==='dark'?{background:'#171d23',foreground:'#f1f3f5',muted:'#b5bec7',route:'#ff8c7c'}:theme==='light'?{background:'#fff',foreground:'#303530',muted:'#757d76',route:'#e65f55'}:{background:'#fffdf6',foreground:'#413b32',muted:'#91958b',route:'#e65f55'}
}
function contrastColor(value:string):string {
  const expanded=value.length===4?'#'+value.slice(1).split('').map(part=>part+part).join(''):value
  if(!/^#[0-9a-f]{6,8}$/iu.test(expanded))return '#fff'
  const rgb=[1,3,5].map(start=>parseInt(expanded.slice(start,start+2),16)/255).map(part=>part<=.04045?part/12.92:((part+.055)/1.055)**2.4),luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]
  return 1.05/(luminance+.05)>=(luminance+.05)/.05?'#fff':'#000'
}
export function getArtElementStyle(annotation:TrackAnnotation,styles:ArtStyles={},theme:ArtTheme='paper'):Required<ArtElementStyle> {
  const palette=getArtPalette(theme),explicit={...styles.defaults,...annotation.style},markerColor=explicit.markerColor??annotation.color
  return {textColor:palette.foreground,textSize:17,fontFamily:'sans',fontWeight:600,textOffsetX:0,textOffsetY:0,numberColor:contrastColor(markerColor),numberSize:13,markerColor,markerRadius:16,markerBorderColor:palette.background,markerBorderWidth:2,connectorColor:palette.muted,connectorWidth:2,connectorDash:'dashed',photoWidth:320,photoHeight:200,photoRadius:4,photoBorderColor:palette.muted,photoBorderWidth:1,photoFit:'cover',photoCaptionBackground:'#203a3e',...explicit}
}
export function getArtTextStyle(id:ArtTextId,styles:ArtStyles={},theme:ArtTheme='paper'):Required<ArtTextStyle> {
  const palette=getArtPalette(theme),defaults=styles.defaults??{}
  return {textColor:id==='north'?palette.muted:palette.foreground,textSize:id==='title'?28:id==='north'?13:15,fontFamily:'sans',fontWeight:id==='title'?700:400,...Object.fromEntries(textKeys.filter(key=>defaults[key]!==undefined).map(key=>[key,defaults[key]])),...styles.texts?.[id]}
}
export function getArtRouteStyle(styles:ArtStyles={},theme:ArtTheme='paper'):Required<ArtRouteStyle> {return {color:getArtPalette(theme).route,width:6,startColor:'#20986a',endColor:'#cf3330',startRadius:9,endRadius:10,...styles.route}}
export function getArtBackground(styles:ArtStyles={},theme:ArtTheme='paper'):string {return styles.background??getArtPalette(theme).background}
