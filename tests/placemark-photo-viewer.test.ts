// @vitest-environment jsdom
import {act, createElement, useState} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {placemarkPhotoOriginalUrl} from '../src/track/placemark-photo-assets.ts'
import {PlacemarkPhotoViewer, type PlacemarkViewerPhoto} from '../src/client/PlacemarkPhotoViewer.tsx'

let root: Root | null
let container: HTMLDivElement
let opener: HTMLButtonElement
let closed: ReturnType<typeof vi.fn<() => void>>
let selected: ReturnType<typeof vi.fn<(index:number) => void>>
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const showModal = vi.fn(function(this: HTMLDialogElement) {
  this.setAttribute('open', '')
  this.querySelector<HTMLButtonElement>('button')?.focus()
})
const close = vi.fn(function(this: HTMLDialogElement) {this.removeAttribute('open')})

type ViewerOptions={trackId?:string;url?:string;name?:string;gallery?:PlacemarkViewerPhoto[];initialIndex?:number}
function ControlledViewer({url = 'https://example.com/meadow.jpg', name = '牧场',trackId,gallery,initialIndex=0}:ViewerOptions) {
  const [opened, setOpened] = useState(true)
  const [index,setIndex]=useState(initialIndex)
  return opened ? createElement(PlacemarkPhotoViewer, {url, name,trackId,gallery,selectedIndex:index,onSelectImage:next=>{selected(next);setIndex(next)}, onClose: () => {closed(); setOpened(false)}}) : null
}
beforeEach(() => {
  showModal.mockClear(); close.mockClear()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value: showModal})
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value: close})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  closed = vi.fn<() => void>()
  selected=vi.fn<(index:number)=>void>()
  opener = document.createElement('button')
  opener.textContent = '打开图片'
  document.body.append(opener)
  opener.focus()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  container.remove(); opener.remove()
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).showModal
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).close
  vi.unstubAllGlobals()
})
async function render(props: ViewerOptions = {}) {await act(async () => root!.render(createElement(ControlledViewer, props)))}

describe('native placemark photo viewer', () => {
  it('wraps a group gallery through buttons and arrow keys without closing or remounting the dialog',async()=>{
    const gallery=[{url:'https://example.com/a.jpg',name:'林间'},{url:'https://example.com/b.jpg',name:'山口'}]
    await render({gallery,initialIndex:1})
    const dialog=container.querySelector('dialog')!
    expect(dialog.querySelector('img')?.src).toBe(gallery[1].url)
    await act(async()=>dialog.querySelector<HTMLButtonElement>('[aria-label="下一张大图"]')!.click())
    expect(selected).toHaveBeenLastCalledWith(0)
    expect(dialog.querySelector('img')?.src).toBe(gallery[0].url)
    const event=new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true})
    await act(async()=>dialog.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true);expect(selected).toHaveBeenLastCalledWith(1)
    expect(container.querySelector('dialog')).toBe(dialog);expect(showModal).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
  })

  it('can leave a failed slide and resets failure for another child with the same URL',async()=>{
    const gallery=[{url:'https://example.com/shared.jpg',name:'点位一'},{url:'https://example.com/shared.jpg',name:'点位二'}]
    await render({gallery})
    const image=container.querySelector('img')!
    await act(async()=>image.dispatchEvent(new Event('error')))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="下一张大图"]')!.click())
    const next=container.querySelector('img')!
    expect(next).not.toBe(image);expect(next.src).toBe(gallery[1].url);expect(next.alt).toBe('点位二')
    expect(container.querySelector('[role="status"]')).toBeNull()
    await act(async()=>image.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBe(next)
  })

  it('filters unsafe gallery links and leaves modified arrow shortcuts untouched',async()=>{
    await render({gallery:[{url:'javascript:alert(1)',name:'无效图'},{url:'https://example.com/safe.jpg',name:'有效图'}]})
    const dialog=container.querySelector('dialog')!
    expect(dialog.querySelector('img')?.src).toBe('https://example.com/safe.jpg')
    expect(dialog.querySelector('.trk-placemark-photo-viewer-carousel')?.textContent).toContain('1 / 1')
    const event=new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true})
    await act(async()=>dialog.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false);expect(selected).not.toHaveBeenCalled()
  })

  it('opens a native modal showing the full safe image without a fixed crop ratio', async () => {
    await render()
    const dialog = container.querySelector('dialog')!
    expect(showModal).toHaveBeenCalledOnce()
    expect(dialog.open).toBe(true)
    expect(dialog.getAttribute('aria-label')).toBe('牧场 · 大图')
    const image = dialog.querySelector('img')!
    expect(image.src).toBe('https://example.com/meadow.jpg')
    expect(image.alt).toBe('牧场')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.getAttribute('width')).toBeNull()
    expect(image.getAttribute('height')).toBeNull()
    expect(document.activeElement).toBe(dialog.querySelector('[aria-label="关闭大图"]'))
  })

  it.each(['button', 'cancel'] as const)('closes via %s and restores the photo opener focus', async method => {
    await render()
    if (method === 'button') await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭大图"]')!.click())
    else {
      const cancel = new Event('cancel', {cancelable: true})
      await act(async () => container.querySelector('dialog')!.dispatchEvent(cancel))
      expect(cancel.defaultPrevented).toBe(true)
    }
    expect(closed).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(container.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('isolates image errors and reloads the same safe image on retry', async () => {
    await render()
    const image = container.querySelector('img')!
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('图片加载失败')
    await act(async () => container.querySelector<HTMLButtonElement>('.trk-placemark-photo-viewer-retry')!.click())
    const retried = container.querySelector('img')!
    expect(retried).not.toBe(image)
    expect(retried.src).toBe('https://example.com/meadow.jpg')
    expect(container.querySelector('[role="status"]')).toBeNull()
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBe(retried)
  })

  it.each(['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///C:/private.jpg', 'https://user:password@example.com/private.jpg'])('rejects unsafe legacy URL %s without loading it', async url => {
    await render({url})
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('图片链接无效')
    expect(container.querySelector('a')).toBeNull()
  })

  it('does not show an invented title when the source name is empty', async () => {
    await render({name: ' '})
    expect(container.querySelector('.trk-placemark-photo-viewer-title')).toBeNull()
    expect(container.textContent).not.toContain('未命名')
    expect(container.querySelector('dialog')?.getAttribute('aria-label')).toBe('点位图片大图')
  })

  it('closes the native dialog on unmount without emitting a user close', async () => {
    await render()
    await act(async () => root!.unmount())
    root = null
    expect(close).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
  })
})


it('uses the cached original for each slide when a track is available',async()=>{
  const gallery=[{url:'https://example.com/a.jpg',name:'林间'},{url:'http://example.com/b.jpg',name:'山口'}]
  await render({trackId:'track-1',gallery})
  expect(container.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoOriginalUrl('track-1',gallery[0].url))
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="下一张大图"]')!.click())
  expect(container.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoOriginalUrl('track-1',gallery[1].url))
  expect(selected).toHaveBeenLastCalledWith(1)
})
