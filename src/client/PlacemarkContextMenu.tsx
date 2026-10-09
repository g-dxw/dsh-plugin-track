import { useEffect, useRef, type KeyboardEvent } from 'react'

export function PlacemarkContextMenu({x,y,count,disabled,groupDisabled=false,mergeCount=0,onMerge,onGroup,onDelete,onClear,onClose}:{x:number;y:number;count:number;disabled:boolean;groupDisabled?:boolean;mergeCount?:number;onMerge?:()=>void;onDelete?:()=>void;onGroup:()=>void;onClear:()=>void;onClose:()=>void}) {
  const menu=useRef<HTMLDivElement>(null)
  const close=useRef(onClose);close.current=onClose
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside=(event:globalThis.PointerEvent)=>{if(event.target instanceof Node&&!menu.current?.contains(event.target))close.current()}
    const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current()}}
    const moved=()=>close.current()
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true)
    window.addEventListener('resize',moved);window.addEventListener('scroll',moved,true)
    return()=>{
      document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true)
      window.removeEventListener('resize',moved);window.removeEventListener('scroll',moved,true)
      if(previous?.isConnected)previous.focus({preventScroll:true})
    }
  },[])
  function keyboard(event:KeyboardEvent<HTMLDivElement>){
    const controls=Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[])
    if(event.key==='Tab'){event.preventDefault();onClose();return}
    if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)||!controls.length)return
    event.preventDefault()
    const index=controls.indexOf(document.activeElement as HTMLButtonElement)
    const next=event.key==='Home'?0:event.key==='End'?controls.length-1:(index+(event.key==='ArrowUp'?-1:1)+controls.length)%controls.length
    controls[next].focus()
  }
  return <div ref={menu} role="menu" aria-label="标注点菜单" className="trk-placemark-context-menu" style={{left:Math.max(8,Math.min(x,window.innerWidth-216)),top:Math.max(8,Math.min(y,window.innerHeight-160))}} onKeyDown={keyboard} onContextMenu={event=>event.preventDefault()}>
    {onMerge?<button type="button" role="menuitem" disabled={disabled||mergeCount<2||mergeCount!==count} onClick={onMerge}>合并分组（{mergeCount}）</button>:<button type="button" role="menuitem" disabled={disabled||groupDisabled||count<2} onClick={onGroup}>打组（{count}）</button>}
    {onDelete&&<button type="button" role="menuitem" disabled={disabled||!count} onClick={onDelete}>删除所选标注点（{count}）</button>}
    <button type="button" role="menuitem" disabled={disabled||!count} onClick={onClear}>取消选择</button>
  </div>
}
