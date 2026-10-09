import { useEffect,useRef,useState } from 'react'
import { loadTextModels } from './text-ai.ts'
import type { TextModelCatalog } from '../ai.ts'
export function useTextModels() {
  const[catalog,setCatalog]=useState<TextModelCatalog|null>(null),[model,setModel]=useState(''),[retry,setRetry]=useState(0)
  const current=useRef(0)
  useEffect(()=>{const generation=++current.current,controller=new AbortController();void loadTextModels(controller.signal).then(found=>{if(controller.signal.aborted||generation!==current.current)return;setCatalog(found);setModel(found.defaultModel||'')}).catch(reason=>{if(!controller.signal.aborted)setCatalog({available:false,models:[],message:reason instanceof Error?reason.message:'文本模型不可用'})});return()=>controller.abort()},[retry])
  return {catalog,model,setModel,reload:()=>setRetry(value=>value+1)}
}