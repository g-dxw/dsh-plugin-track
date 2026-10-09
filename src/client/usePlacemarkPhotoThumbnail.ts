import {useEffect,useState} from 'react'
import {placemarkPhotoThumbnailUrl} from '../track/placemark-photo-assets.ts'
import {preparePlacemarkPhotoCache} from './placemark-photo-cache.ts'

/** Register draft photo sources before the browser requests their track-scoped asset. */
export function usePlacemarkPhotoThumbnail(trackId:string|undefined,source:string|null) {
  const key=JSON.stringify([trackId,source])
  const [ready,setReady]=useState<{key:string;url:string}|null>(null)
  const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    setReady(null);setFailed(false)
    if(!trackId||!source)return
    const controller=new AbortController()
    void preparePlacemarkPhotoCache(trackId,[source],controller.signal).then(()=>{
      if(!controller.signal.aborted)setReady({key,url:placemarkPhotoThumbnailUrl(trackId,source)})
    }).catch(()=>{if(!controller.signal.aborted)setFailed(true)})
    return()=>controller.abort()
  },[key,attempt])
  const url=source&&(!trackId?source:ready?.key===key?ready.url:null)
  return {url,failed,loading:!!source&&!url&&!failed,onError:()=>setFailed(true),retry:()=>{setReady(null);setFailed(false);setAttempt(value=>value+1)}}
}
