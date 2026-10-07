import {useEffect, useRef, useState} from 'react'
import maplibregl from 'maplibre-gl'
import {geoEvaluate, geoSyncScene, geoDrawOverlay, geoScaleFor, geoResetSyncCache, geoGetImage, type GeoMotionProject, type GeoCamera} from '../track/geomotion.ts'
import {basemapCredits, styleFor, terrainProviderFor, MAPTILER_LOGO_URL, type BasemapId} from '../track/basemaps.ts'
import {configureMapTerrain} from '../track/map-terrain.ts'
import type {MapSettings, MapCredit} from '../track/map-settings.ts'
import {MAP_STYLE} from './maplibre-css.ts'
import {fitVideoMaterialImages} from '../track/video-materials-layout.ts'

export interface GeoMotionSceneHandle {
  renderAt(project:GeoMotionProject,time:number,signal?:AbortSignal):Promise<void>
  getCamera():GeoCamera
  getCaptureCanvas():HTMLCanvasElement
  freezeConfiguration():()=>void
}
type Props = {project:GeoMotionProject;time:number;basemap:BasemapId;settings:MapSettings;onReady:(handle:GeoMotionSceneHandle|null)=>void;onCameraChange?:(camera:GeoCamera)=>void}
const abortError = () => new DOMException('镜头渲染已取消','AbortError')
/** Resource waits are bounded and abortable, including assets requested before map capture. */
function waitForAsset(promise:Promise<void>,signal?:AbortSignal,message='图片加载超时，请检查网络后重试'):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(abortError());return}
    const finish=(reason?:unknown)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);reason?reject(reason):resolve()}
    const aborted=()=>finish(abortError())
    const timer=setTimeout(()=>finish(new Error(message)),15000)
    signal?.addEventListener('abort',aborted,{once:true})
    promise.then(()=>finish(),finish)
  })
}
const uniqueCredits = (credits:readonly MapCredit[]) => [...new Map(credits.map(credit=>[credit.label,credit])).values()]

/** An editor owns one map. The composition stays at output size; only CSS scales its preview. */
export function GeoMotionScene(props:Props) {
  const latest=useRef(props);latest.current=props
  const host=useRef<HTMLDivElement>(null), stage=useRef<HTMLDivElement>(null), mapContainer=useRef<HTMLDivElement>(null), overlay=useRef<HTMLCanvasElement>(null)
  const handle=useRef<GeoMotionSceneHandle|null>(null), configure=useRef<()=>void>(()=>{}), retry=useRef<()=>void>(()=>{}), locked=useRef<Props|null>(null)
  const [frozenProject,setFrozenProject]=useState<GeoMotionProject|null>(null)
  const visibleProject=frozenProject??props.project
  const [scale,setScale]=useState(1), [status,setStatus]=useState('正在加载镜头地图'), [error,setError]=useState('')

  useEffect(()=>{
    if(!mapContainer.current||!overlay.current)return
    let disposed=false, loaded=false, applyingCamera=false, lockDepth=0, styleSignature='', terrainSignature='', resourceError='', resizeEpoch=0, requestEpoch=0
    let pendingCancel:((reason:Error)=>void)|null=null
    let currentProject=latest.current.project, currentTime=latest.current.time
    let scene=geoEvaluate(currentProject,currentTime)
    const capture=document.createElement('canvas'), creditsCanvas=document.createElement('canvas')
    const initial=scene.camera
    const map=new maplibregl.Map({container:mapContainer.current,style:styleFor(latest.current.basemap,latest.current.settings),center:initial.center,zoom:initial.zoom,bearing:initial.bearing,pitch:initial.pitch,maxPitch:85,pixelRatio:1,fadeDuration:0,canvasContextAttributes:{preserveDrawingBuffer:true,antialias:true},attributionControl:false})
    const handlers=[map.dragPan,map.scrollZoom,map.boxZoom,map.dragRotate,map.keyboard,map.touchZoomRotate,map.touchPitch,map.doubleClickZoom]
    let handlerStates:boolean[]=[]
    let logo:HTMLImageElement|null=null, logoPromise:Promise<void>|null=null
    const active=()=>locked.current??latest.current
    const ensureLogo=()=>{
      if(logo?.complete&&logo.naturalWidth)return Promise.resolve()
      if(logoPromise)return logoPromise
      logoPromise=new Promise<void>((resolve,reject)=>{
        const image=new Image();image.crossOrigin='anonymous'
        const timer=setTimeout(()=>{image.onload=null;image.onerror=null;logoPromise=null;reject(new Error('地图来源标志加载超时，请重试或选择其他底图'))},8000)
        image.onload=()=>{clearTimeout(timer);logo=image;resolve()}
        image.onerror=()=>{clearTimeout(timer);logoPromise=null;reject(new Error('地图来源标志加载失败，请重试或选择其他底图'))}
        image.src=MAPTILER_LOGO_URL
      })
      return logoPromise
    }
    const creditList=()=>{
      const config=active()
      return uniqueCredits([...basemapCredits(config.basemap),...(currentProject.terrain?terrainProviderFor(config.settings).credits:[])])
    }
    const draw=()=>{
      if(disposed||!overlay.current)return
      const width=currentProject.width,height=currentProject.height
      for(const canvas of [overlay.current,capture,creditsCanvas]){if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height}
      const ctx=overlay.current.getContext('2d'),target=capture.getContext('2d'),creditCtx=creditsCanvas.getContext('2d')
      if(!ctx||!target||!creditCtx)throw new Error('无法创建视频合成画布')
      ctx.clearRect(0,0,width,height)
      const materialSources=new Set(Object.values(currentProject.nodes).filter(node=>node.type==='image'&&node.id.startsWith('material-photo-')).map(node=>node.type==='image'?node.src:''))
      const fitted=fitVideoMaterialImages(scene,width,height,materialSources,source=>{const entry=geoGetImage(source);return entry?.ready?{width:entry.img.naturalWidth,height:entry.img.naturalHeight}:null})
      geoDrawOverlay({ctx,width,height,scale:geoScaleFor(height),project:coordinates=>map.project(coordinates)},fitted)
      creditCtx.clearRect(0,0,width,height)
      const credits=creditList(),labels=credits.map(item=>item.label)
      if(labels.length){
        const fontSize=Math.max(12,Math.round(height/60)),padding=Math.max(8,Math.round(height/90))
        creditCtx.font=`${fontSize}px system-ui, "Microsoft YaHei", sans-serif`
        const hasLogo=credits.some(item=>item.label.includes('MapTiler'))&&logo?.naturalWidth
        const logoWidth=hasLogo?Math.round(height*0.14):0,available=width-padding*2-logoWidth
        const lines:string[]=[];let line=''
        for(const label of labels){const next=line?`${line} · ${label}`:label;if(line&&creditCtx.measureText(next).width>available){lines.push(line);line=label}else line=next}
        if(line)lines.push(line)
        const lineHeight=fontSize+4,band=Math.max(lines.length*lineHeight+padding*2,hasLogo?Math.round(height*0.052)+padding*2:0)
        creditCtx.fillStyle='rgba(16,24,32,.88)';creditCtx.fillRect(0,height-band,width,band)
        creditCtx.fillStyle='#fff';creditCtx.textBaseline='bottom'
        lines.forEach((text,index)=>creditCtx.fillText(text,padding,height-padding-(lines.length-1-index)*lineHeight,available))
        if(hasLogo&&logo){const logoHeight=logoWidth*logo.naturalHeight/logo.naturalWidth;creditCtx.fillStyle='#fff';creditCtx.fillRect(width-logoWidth-padding-4,height-logoHeight-padding-4,logoWidth+8,logoHeight+8);creditCtx.drawImage(logo,width-logoWidth-padding,height-logoHeight-padding,logoWidth,logoHeight)}
      }
      ctx.drawImage(creditsCanvas,0,0)
      target.fillStyle=currentProject.background||'#14202b';target.fillRect(0,0,width,height)
      target.drawImage(map.getCanvas(),0,0,width,height)
      target.drawImage(overlay.current,0,0,width,height)
    }
    const camera=():GeoCamera=>{const center=map.getCenter().wrap();return{center:[center.lng,center.lat],zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()}}
    configure.current=()=>{
      if(disposed||!loaded||locked.current)return
      const config=latest.current
      const signature=JSON.stringify([config.basemap,config.settings.maptilerKey])
      if(signature!==styleSignature){
        styleSignature=signature;resourceError='';terrainSignature='';setError('')
        map.setStyle(styleFor(config.basemap,config.settings),{diff:false})
        return
      }
      if(!map.isStyleLoaded())return
      const terrain=JSON.stringify([config.project.terrain,config.project.terrainExaggeration,config.settings.terrainProvider,config.settings.maptilerKey,config.settings.buildings])
      if(terrain!==terrainSignature){
        configureMapTerrain(map,{...config.settings,exaggeration:config.project.terrainExaggeration},config.project.terrain,config.basemap)
        terrainSignature=terrain
      }
    }
    retry.current=()=>{if(disposed||locked.current)return;styleSignature='';resourceError='';configure.current()}
    styleSignature=JSON.stringify([latest.current.basemap,latest.current.settings.maptilerKey])
    const surface:GeoMotionSceneHandle={
      getCamera:camera,getCaptureCanvas:()=>capture,
      freezeConfiguration(){
        lockDepth++
        if(lockDepth===1){
          locked.current={...latest.current,project:structuredClone(latest.current.project),settings:{...latest.current.settings}}
          handlerStates=handlers.map(handler=>handler.isEnabled());handlers.forEach(handler=>handler.disable())
          setFrozenProject(locked.current.project)
        }
        let released=false
        return()=>{if(released)return;released=true;lockDepth=Math.max(0,lockDepth-1);if(!lockDepth){locked.current=null;if(disposed)return;setFrozenProject(null);handlers.forEach((handler,index)=>{if(handlerStates[index])handler.enable()});configure.current();void surface.renderAt(latest.current.project,latest.current.time).catch(()=>{})}}
      },
      async renderAt(project,time,signal){
        if(disposed||signal?.aborted)throw abortError()
        if(!loaded)throw new Error('底图尚未就绪，请稍候')
        pendingCancel?.(abortError())
        const epoch=++requestEpoch
        if(!map.isStyleLoaded())await new Promise<void>((resolve,reject)=>{
          let finished=false
          const finish=(reason?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);map.off('render',ready);map.off('styledata',ready);signal?.removeEventListener('abort',aborted);if(pendingCancel===cancel)pendingCancel=null;reason?reject(reason):resolve()}
          const cancel=(reason:Error)=>finish(reason),aborted=()=>finish(abortError())
          const ready=()=>{if(disposed||epoch!==requestEpoch)return finish(abortError());if(resourceError)return finish(new Error(resourceError));if(map.isStyleLoaded())finish()}
          const timer=setTimeout(()=>finish(new Error('地图样式与图层未完成加载，请重试或切换底图')),15000)
          pendingCancel=cancel;signal?.addEventListener('abort',aborted,{once:true});map.on('render',ready);map.on('styledata',ready);map.triggerRepaint();ready()
        })
        if(disposed||signal?.aborted||epoch!==requestEpoch)throw abortError()
        if(map.getCanvas().width!==project.width||map.getCanvas().height!==project.height)map.resize()
        currentProject=project;currentTime=Math.max(0,Math.min(project.duration,time));scene=geoEvaluate(project,currentTime)
        if(resourceError)throw new Error(resourceError)
        const images=Object.values(project.nodes).filter(node=>node.type==='image').map(node=>geoGetImage(node.src)).filter(entry=>entry!==null)
        await waitForAsset(Promise.all(images.map(entry=>entry.promise)).then(()=>{if(images.some(entry=>entry.failed))throw new Error('工程图片加载失败，请检查图片地址与跨域权限')}),signal)
        if(creditList().some(item=>item.label.includes('MapTiler')))await waitForAsset(ensureLogo(),signal,'地图来源标志加载超时，请重试或选择其他底图')
        if(disposed||signal?.aborted||epoch!==requestEpoch)throw abortError()
        applyingCamera=true
        try{map.jumpTo({center:scene.camera.center,zoom:scene.camera.zoom,bearing:scene.camera.bearing,pitch:Math.min(85,scene.camera.pitch)});geoSyncScene(map,scene)}finally{applyingCamera=false}
        return new Promise<void>((resolve,reject)=>{
          let finished=false
          const finish=(reason?:Error)=>{
            if(finished)return;finished=true;clearTimeout(timer);map.off('render',rendered);signal?.removeEventListener('abort',aborted)
            if(pendingCancel===cancel)pendingCancel=null
            if(reason){reject(reason);return}
            try{draw();if(!disposed)setError('');resolve()}catch(error){reject(error)}
          }
          const cancel=(reason:Error)=>finish(reason),aborted=()=>finish(abortError())
          const rendered=()=>{if(disposed)return finish(abortError());if(resourceError)return finish(new Error(resourceError));if(map.isStyleLoaded()&&map.areTilesLoaded())finish();else map.triggerRepaint()}
          const timer=setTimeout(()=>finish(new Error('地图或地形瓦片未完整加载，请重试或切换底图')),15000)
          pendingCancel=cancel;signal?.addEventListener('abort',aborted,{once:true});map.on('render',rendered);map.triggerRepaint()
        })
      },
    }
    handle.current=surface
    const loadedMap=()=>{if(disposed)return;loaded=true;configure.current();setStatus('拖动地图调整视角，记录到关键帧');latest.current.onReady(surface);void surface.renderAt(latest.current.project,latest.current.time).catch(reason=>{if(!disposed&&reason?.name!=='AbortError')setError(reason instanceof Error?reason.message:'镜头渲染失败')})}
    const styleLoaded=()=>{if(!loaded)return;geoResetSyncCache(map);terrainSignature='';resourceError='';setError('');configure.current();void surface.renderAt(latest.current.project,latest.current.time).catch(()=>{})}
    const moved=(event:unknown)=>{if(disposed||applyingCamera)return;if(event&&typeof event==='object'&&'originalEvent' in event&&event.originalEvent)latest.current.onCameraChange?.(camera());try{draw()}catch{/* pending capture reports errors */}}
    const rendered=()=>{if(!disposed&&loaded){try{draw()}catch{/* explicit renderAt reports capture errors */}}}
    const failed=()=>{if(disposed)return;resourceError='地图或地形资源加载失败，请检查网络后重试或切换底图';setError(resourceError);pendingCancel?.(new Error(resourceError))}
    const lost=(event:Event)=>{event.preventDefault();failed()}
    map.on('load',loadedMap);map.on('style.load',styleLoaded);map.on('move',moved);map.on('render',rendered);map.on('error',failed);map.getCanvas().addEventListener('webglcontextlost',lost)
    const resize=()=>{if(disposed||!host.current)return;const project=active().project;setScale(Math.min(host.current.clientWidth/project.width,host.current.clientHeight/project.height)||1)}
    const observer=new ResizeObserver(()=>{const epoch=++resizeEpoch;requestAnimationFrame(()=>{if(!disposed&&epoch===resizeEpoch)resize()})})
    if(host.current)observer.observe(host.current);resize()
    return()=>{disposed=true;observer.disconnect();pendingCancel?.(abortError());pendingCancel=null;handle.current=null;configure.current=()=>{};retry.current=()=>{};locked.current=null;latest.current.onReady(null);map.getCanvas().removeEventListener('webglcontextlost',lost);map.remove()}
  },[])

  useEffect(()=>{configure.current()},[props.basemap,props.settings,props.project.terrain,props.project.terrainExaggeration])
  useEffect(()=>{
    if(stage.current&&!locked.current){stage.current.style.width=`${props.project.width}px`;stage.current.style.height=`${props.project.height}px`}
    const surface=handle.current
    if(surface&&!locked.current)void surface.renderAt(props.project,props.time).catch(reason=>{if(reason?.name!=='AbortError')setError(reason instanceof Error?reason.message:'镜头渲染失败')})
  },[props.project,props.time])
  return <div className="trk-gm-scene">
    <style>{MAP_STYLE}{`.trk-gm-scene{min-width:0;position:relative}.trk-gm-scene-viewport{width:100%;position:relative;overflow:hidden;background:#14202b}.trk-gm-scene-stage{position:absolute;left:50%;top:50%;transform-origin:center;overflow:hidden}.trk-gm-scene-map{position:absolute;inset:0}.trk-gm-scene-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.trk-gm-scene-status{font-size:12px;padding:6px 0;color:var(--trk-muted)}.trk-gm-scene-error{font-size:13px;padding:8px;color:var(--trk-danger);background:var(--trk-danger-bg)}`}</style>
    <div ref={host} className="trk-gm-scene-viewport" style={{aspectRatio:`${visibleProject.width}/${visibleProject.height}`}}>
      <div ref={stage} className="trk-gm-scene-stage" style={{width:visibleProject.width,height:visibleProject.height,transform:`translate(-50%,-50%) scale(${scale})`}}>
        <div ref={mapContainer} className="trk-gm-scene-map" /><canvas ref={overlay} className="trk-gm-scene-overlay" aria-label="地名与字幕预览" />
      </div>
    </div>
    {error?<div className="trk-gm-scene-error" role="alert">{error} <button type="button" onClick={()=>retry.current()} disabled={!!frozenProject}>重试地图</button></div>:<div className="trk-gm-scene-status" role="status">{status}</div>}
  </div>
}
