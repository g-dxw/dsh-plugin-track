// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {usePlacemarkPhotoThumbnail} from '../src/client/usePlacemarkPhotoThumbnail.ts'
import {preparePlacemarkPhotoCache} from '../src/client/placemark-photo-cache.ts'
import {placemarkPhotoThumbnailUrl} from '../src/track/placemark-photo-assets.ts'
vi.mock('../src/client/placemark-photo-cache.ts',()=>({preparePlacemarkPhotoCache:vi.fn()}))
let root:Root,node:HTMLDivElement
const source='https://example.com/draft.jpg'
function Preview({url=source}:{url?:string}){
 const photo=usePlacemarkPhotoThumbnail('track-1',url)
 return photo.failed?createElement('button',{onClick:photo.retry},'重试图片'):photo.url?createElement('img',{src:photo.url,onError:photo.onError,alt:'预览'}):createElement('span',null,'正在加载')
}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.mocked(preparePlacemarkPhotoCache).mockReset();node=document.createElement('div');document.body.append(node);root=createRoot(node)})
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()})
it('registers an unsaved logical URL before requesting its thumbnail',async()=>{
 let registered!:()=>void
 vi.mocked(preparePlacemarkPhotoCache).mockReturnValue(new Promise<void>(resolve=>{registered=resolve}))
 await act(async()=>root.render(createElement(Preview)))
 expect(node.querySelector('img')).toBeNull()
 expect(preparePlacemarkPhotoCache).toHaveBeenCalledWith('track-1',[source],expect.any(AbortSignal))
 await act(async()=>registered())
 expect(node.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',source))
})
it('aborts old registration and prevents its late completion from painting another source',async()=>{
 let registered!:()=>void
 vi.mocked(preparePlacemarkPhotoCache).mockReturnValueOnce(new Promise<void>(resolve=>{registered=resolve})).mockResolvedValueOnce()
 await act(async()=>root.render(createElement(Preview)))
 const signal=vi.mocked(preparePlacemarkPhotoCache).mock.calls[0][2]!
 const next='https://example.com/next.jpg'
 await act(async()=>root.render(createElement(Preview,{url:next})))
 expect(signal.aborted).toBe(true)
 await act(async()=>registered())
 expect(node.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',next))
})
it('allows a registration failure to retry without falling back to the remote original',async()=>{
 vi.mocked(preparePlacemarkPhotoCache).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce()
 await act(async()=>root.render(createElement(Preview)))
 expect(node.querySelector('img')).toBeNull()
 await act(async()=>node.querySelector('button')!.click())
 expect(preparePlacemarkPhotoCache).toHaveBeenCalledTimes(2)
 expect(node.querySelector('img')?.getAttribute('src')).toBe(placemarkPhotoThumbnailUrl('track-1',source))
})
