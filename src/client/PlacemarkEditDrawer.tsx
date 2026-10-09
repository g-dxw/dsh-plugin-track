import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { TrackPlacemark } from '../protocol.ts'
import { formatPlacemarkElevation, formatPlacemarkTime } from '../track/placemark-format.ts'
import { imageLink } from '../track/placemarks.ts'
import { usePlacemarkPhotoThumbnail } from './usePlacemarkPhotoThumbnail.ts'
import { placemarkTypes, validatePlacemarkEdits, type PlacemarkEdit } from '../track/placemark-edits.ts'
import { localPlacemarkPhoto, placemarkPhotoUrl, PLACEMARK_PHOTO_ACCEPT } from '../track/placemark-photos.ts'
import { validatePlacemarkPhotoFile } from './placemark-photo.ts'

export type PlacemarkInfoPatch = Pick<PlacemarkEdit, 'name' | 'description' | 'images' | 'type' | 'hidden'>
const TYPES = ['风景点', '休息点', '补给点', '厕所', '打卡点', '起点', '终点']

export function PlacemarkEditDrawer({point, points, trackId, saving, error, onSave, onClose, onReturnFocus, creating=false, onRelocate, onDelete, unavailable=false, onUploadPhoto, onUploadBusyChange}: {
  point: TrackPlacemark
  trackId?: string
  unavailable?: boolean
  creating?: boolean
  onRelocate?: (patch: PlacemarkInfoPatch) => void
  onDelete?: () => void
  onUploadPhoto?: (file: File) => Promise<string>
  onUploadBusyChange?: (busy: boolean) => void
  points: readonly TrackPlacemark[]
  saving: boolean
  error: string
  onSave: (patch: PlacemarkInfoPatch) => Promise<boolean>
  onClose: () => void
  onReturnFocus: () => void
}) {
  const initial = useRef({name: point.name, description: point.description, images: [...point.images], type: placemarkTypes(point), hidden: !!point.hidden}).current
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [images, setImages] = useState(initial.images)
  const [types, setTypes] = useState(initial.type)
  const [customType, setCustomType] = useState('')
  const [hidden, setHidden] = useState(initial.hidden)
  const [link, setLink] = useState('')
  const [validation, setValidation] = useState('')
  const [failed, setFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState('')
  const [discard, setDiscard] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const continueEditing = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const uploadPending = useRef(false)
  const mounted = useRef(false)
  const uploadBusyChange = useRef(onUploadBusyChange); uploadBusyChange.current = onUploadBusyChange
  const titleId = useId()
  const locked = saving || submitting || uploading
  const draft = {name, description, images, type: types, hidden}
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || !!link.trim() || !!customType.trim()
  const library = [...new Set(points.flatMap(item => item.images).map(imageLink).filter((url): url is string => !!url))]
  const returnFocus = useRef(onReturnFocus); returnFocus.current = onReturnFocus
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current!
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    nameInput.current?.focus()
    return () => {
      mounted.current = false
      if (uploadPending.current) {uploadPending.current = false; uploadBusyChange.current?.(false)}
      if (element.open && typeof element.close === 'function') element.close()
      if (previous?.isConnected) previous.focus()
      else returnFocus.current()
    }
  }, [])
  useEffect(() => {
    if (discard) continueEditing.current?.focus()
    else nameInput.current?.focus()
  }, [discard])
  function close() {
    if (locked || pending.current || uploadPending.current || discard) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  function addLink() {
    if (locked || discard) return
    const url = imageLink(link.trim())
    if (!url || url.length > 4096) {setValidation('请输入有效的 HTTP 或 HTTPS 图片链接'); return}
    if (!images.includes(url) && images.length >= 30) {setValidation('每个点位最多关联 30 张图片'); return}
    setImages(current => current.includes(url) ? current : [...current, url]); setLink(''); setValidation('')
  }
  async function addLocalPhotos(files: File[]) {
    if (!onUploadPhoto || !files.length || locked || pending.current || uploadPending.current || discard || unavailable) return
    setValidation(''); setFailed(false); setUploadNote('')
    try {
      const pendingLink = imageLink(link.trim())
      if (images.length + files.length + (pendingLink && !images.includes(pendingLink) ? 1 : 0) > 30) throw new Error('每个点位最多关联 30 张图片，请减少本次选择的图片')
      files.forEach(validatePlacemarkPhotoFile)
    } catch (reason) {setValidation(reason instanceof Error ? reason.message : '所选图片无效，请重新选择'); return}
    uploadPending.current = true; setUploading(true); uploadBusyChange.current?.(true)
    try {
      const urls: string[] = []
      for (const [index, file] of files.entries()) {
        if (!mounted.current) return
        setUploadNote(`正在上传图片 ${index + 1} / ${files.length}…`)
        const photo = localPlacemarkPhoto(await onUploadPhoto(file))
        if (!photo) throw new Error('图片服务返回的本地图片地址无效')
        urls.push(placemarkPhotoUrl(photo.trackId, photo.filename))
      }
      if (!mounted.current) return
      setImages(current => [...new Set([...current, ...urls])])
      setUploadNote(`已添加 ${urls.length} 张本地图片，保存后关联到此标注。`)
    } catch (reason) {
      if (mounted.current) {
        setUploadNote('')
        setValidation(`${reason instanceof Error ? reason.message : '图片上传失败'}。本次选择的图片未加入草稿，请重试。`)
      }
    } finally {
      if (uploadPending.current) {uploadPending.current = false; uploadBusyChange.current?.(false)}
      if (mounted.current) setUploading(false)
    }
  }
  function addedType(value: string): string[] | null {
    const tag = value.trim()
    if (!tag) {setValidation('请输入自定义标签'); return null}
    if (tag.length > 64) {setValidation('每个标签最多 64 个字符'); return null}
    if (!types.includes(tag) && types.length >= 20) {setValidation('每个点位最多添加 20 个类型标签'); return null}
    return types.includes(tag) ? types : [...types, tag]
  }
  function addTag() {
    if (locked || discard) return
    const next = addedType(customType)
    if (!next) return
    setTypes(next); setCustomType(''); setValidation('')
  }
  function toggleType(value: string, checked: boolean) {
    if (locked || discard) return
    if (checked) {
      const next = addedType(value)
      if (!next) return
      setTypes(next)
    } else setTypes(current => current.filter(item => item !== value))
    setValidation('')
  }
  function preparePatch(): PlacemarkInfoPatch | null {
    let next = draft
    if (customType.trim()) {
      const tags = addedType(customType)
      if (!tags) return null
      next = {...next, type: tags}
    }
    if (link.trim()) {
      const url = imageLink(link.trim())
      if (!url || url.length > 4096) {throw new Error('请输入有效的 HTTP 或 HTTPS 图片链接')}
      next = {...next, images: [...new Set([...images, url])]}
    }
    const {id: _id, ...patch} = validatePlacemarkEdits([{id: point.id, ...next}])[0]
    return patch
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (locked || pending.current || uploadPending.current || discard || unavailable) return
    setValidation(''); setFailed(false)
    try {
      const patch=preparePatch()
      if(!patch)return
      pending.current = true; setSubmitting(true)
      if (await onSave(patch)) onClose()
      else setFailed(true)
    } catch (reason) {setValidation(reason instanceof Error ? reason.message : '点位信息保存失败')}
    finally {pending.current = false; setSubmitting(false)}
  }
  return <dialog ref={dialog} className="trk-placemark-edit-drawer" aria-labelledby={titleId} aria-modal="true"
    onCancel={event => {event.preventDefault(); close()}}>
    <style>{DRAWER_CSS}</style>
    <form aria-busy={locked} onSubmit={event => {void save(event)}}>
      <header><div><h3 id={titleId}>{creating?'新增标注':'编辑标记点'}</h3><small>{creating?'定位后填写信息，保存才创建':unavailable?'已被其他操作删除':'标注点 '+(points.findIndex(item => item.id === point.id) + 1)}</small></div>
        <button type="button" className="trk-secondary" aria-label="关闭点位编辑" disabled={locked} onClick={close}>×</button></header>
      <div className="trk-placemark-edit-fields">
        {discard && <div className="trk-placemark-edit-discard" role="alert"><p>还有未保存的修改，是否放弃？</p><div>
          <button type="button" className="trk-secondary" disabled={locked} onClick={onClose}>放弃修改</button>
          <button ref={continueEditing} type="button" className="trk-secondary" disabled={locked} onClick={() => setDiscard(false)}>继续编辑</button></div></div>}
        {unavailable&&<p className="trk-error" role="alert">此点已被其他操作删除，无法保存；当前草稿保留，可复制内容后关闭。</p>}
        <section className="trk-placemark-edit-location" aria-label="标注位置">
          <small>经度 {point.coordinates[0].toFixed(6)} · 纬度 {point.coordinates[1].toFixed(6)}</small>
          <small>海拔 {formatPlacemarkElevation(point.elevation)}</small><small>时间 {formatPlacemarkTime(point.time,point.timeSource)||'未知（缺少可靠时间数据）'}</small>
          {onRelocate&&<button type="button" className="trk-secondary" disabled={locked||discard} onClick={()=>{try{const patch=preparePatch();if(patch)onRelocate(patch)}catch(reason){setValidation(reason instanceof Error?reason.message:'信息无效')}}}>返回地图重新定位</button>}
        </section>
        <fieldset disabled={locked || discard}>
          <label>标注名<input ref={nameInput} aria-label="标注名" maxLength={160} value={name} onChange={event => setName(event.target.value)}/></label>
          <label>描述<textarea aria-label="标注描述" maxLength={10000} rows={4} value={description} onChange={event => setDescription(event.target.value)}/></label>
          <section aria-label="点位类型"><h4>类型 <small>可多选</small></h4>
            <div className="trk-placemark-edit-types">{TYPES.map(value => <label key={value} className={types.includes(value) ? 'is-selected' : ''}>
              <input type="checkbox" aria-label={`点位类型：${value}`} checked={types.includes(value)} onChange={event => toggleType(value, event.target.checked)}/>{value}
            </label>)}</div>
            {types.some(value => !TYPES.includes(value)) && <div className="trk-placemark-edit-tags">{types.filter(value => !TYPES.includes(value)).map(value => <span key={value}>
              <span>{value}</span><button type="button" aria-label={`移除标签 ${value}`} onClick={() => setTypes(current => current.filter(item => item !== value))}>×</button>
            </span>)}</div>}
            <div className="trk-placemark-edit-add-tag"><label>自定义标签<input aria-label="自定义点位标签" placeholder="输入标签名称" maxLength={64} value={customType} onChange={event => setCustomType(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.nativeEvent.isComposing) {event.preventDefault(); addTag()}}}/></label>
              <button type="button" className="trk-secondary" disabled={!customType.trim()} onClick={addTag}>添加标签</button></div>
            {!types.length && <small>未选择类型</small>}
          </section>
          <label className="trk-placemark-edit-visibility"><input type="checkbox" checked={!hidden} onChange={event => setHidden(!event.target.checked)}/>在地图上显示</label>
          <section aria-label="点位图片"><h4>图片 <small>{images.length} / 30</small></h4>
            <div className="trk-placemark-edit-images">{images.map((url, index) => <div key={index} className="trk-placemark-edit-image">
              <DrawerThumbnail retryable key={url} trackId={trackId} url={url} label={`点位图片 ${index + 1}`}/>
              <div>{localPlacemarkPhoto(url) ? <span>图片 {index + 1} · 本地图片</span> : <label>图片 {index + 1} 链接<input aria-label={`第 ${index + 1} 张图片链接`} value={url} maxLength={4096} onChange={event => setImages(current => current.map((value, item) => item === index ? event.target.value : value))}/></label>}
                <button type="button" className="trk-secondary" aria-label={`移除第 ${index + 1} 张图片`} onClick={() => setImages(current => current.filter((_, item) => item !== index))}>移除</button></div>
            </div>)}</div>
            <label>图片链接<input aria-label="添加图片链接" placeholder="https://…" maxLength={4096} value={link} onChange={event => setLink(event.target.value)} onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); addLink()}}}/></label>
            <button type="button" className="trk-secondary" disabled={!link.trim() || images.length >= 30} onClick={addLink}>添加图片</button>
            {onUploadPhoto && <div className="trk-placemark-edit-upload"><label>添加本地图片<input type="file" aria-label="添加本地图片" accept={PLACEMARK_PHOTO_ACCEPT} multiple disabled={unavailable || images.length >= 30} onChange={event => {const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; void addLocalPhotos(files)}}/></label><small>支持 JPEG、PNG、WebP、GIF、AVIF；每张最多 20 MB。保存后关联到此标注。</small></div>}
            {uploadNote && <p className="trk-placemark-edit-upload-note" role="status" aria-live="polite">{uploadNote}</p>}
            {library.length > 0 && <details className="trk-placemark-edit-library"><summary>选择本轨迹图片 · {library.length}</summary><div>{library.map((url, index) => <button key={url} type="button" aria-label={`选择轨迹图片 ${index + 1}`} aria-pressed={images.includes(url)} disabled={!images.includes(url) && images.length >= 30}
              onClick={() => setImages(current => current.includes(url) ? current.filter(item => item !== url) : [...current, url])}>
              <DrawerThumbnail trackId={trackId} url={url} label={`轨迹图片 ${index + 1}`}/><span>{images.includes(url) ? '已选择' : '选择'}{localPlacemarkPhoto(url) ? ' · 本地图片' : ''}</span></button>)}</div></details>}
          </section>
        </fieldset>
        {(validation || failed) && <div className="trk-error" role="alert">{validation || error || '点位信息未保存，请重试'}</div>}
      </div>
      <footer>{onDelete&&<button type="button" className="trk-secondary trk-delete" disabled={locked||discard} onClick={onDelete}>删除标注点</button>}<button type="button" className="trk-secondary" disabled={locked} onClick={close}>取消</button><button type="submit" className="trk-primary" disabled={locked || unavailable || (!creating&&!dirty) || discard}>{uploading ? '正在上传图片…' : locked ? '正在保存…' : creating?'创建标注':'保存点位'}</button></footer>
    </form>
  </dialog>
}

function DrawerThumbnail({url, label, trackId, retryable=false}: {url: string; label: string; trackId?: string; retryable?: boolean}) {
  const photo=usePlacemarkPhotoThumbnail(trackId,imageLink(url))
  return photo.url&&!photo.failed ? <img src={photo.url} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={photo.onError}/>
    : <span className="trk-placemark-edit-image-failed" role="status">{photo.loading?'正在加载图片…':'图片未加载'}{photo.failed&&retryable&&<button type="button" className="trk-secondary" onClick={photo.retry}>重试图片</button>}</span>
}

const DRAWER_CSS = `
.trk-placemark-edit-upload{display:grid;gap:6px}.trk-placemark-edit-upload input{overflow:hidden}.trk-placemark-edit-upload-note{margin:0;color:var(--trk-muted);font-size:.9286em}
.trk-placemark-edit-types{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.trk-placemark-edit-drawer .trk-placemark-edit-types label{display:flex;flex-direction:row;align-items:center;gap:8px;min-height:44px;padding:8px 10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);cursor:pointer}.trk-placemark-edit-drawer .trk-placemark-edit-types label.is-selected{border-color:var(--trk-accent);background:var(--trk-hover)}.trk-placemark-edit-drawer .trk-placemark-edit-types input{width:20px;height:20px;min-height:20px;padding:0;flex:none;accent-color:var(--trk-accent)}.trk-placemark-edit-tags{display:flex;flex-wrap:wrap;gap:8px}.trk-placemark-edit-tags>span{display:inline-flex;align-items:center;max-width:100%;padding-left:10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);background:var(--trk-hover);font-size:.9286em}.trk-placemark-edit-tags>span>span{min-width:0;overflow-wrap:anywhere}.trk-placemark-edit-tags button{width:44px;flex:none;border:0;background:transparent;color:inherit;border-radius:var(--trk-radius-sm)}.trk-placemark-edit-add-tag{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px}
.trk-placemark-edit-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(440px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;padding:0;border:0;border-left:1px solid var(--trk-border);background:var(--trk-surface);color:var(--trk-text);font:var(--trk-font-size)/1.5 var(--trk-font-family,system-ui,sans-serif);box-shadow:-10px 0 40px var(--trk-shadow);overflow:hidden}.trk-placemark-edit-drawer::backdrop{background:rgba(0,0,0,.2)}.trk-placemark-edit-drawer form{height:100%;display:flex;flex-direction:column}.trk-placemark-edit-drawer header,.trk-placemark-edit-drawer footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:18px;border-bottom:1px solid var(--trk-border);flex-shrink:0}.trk-placemark-edit-drawer h3,.trk-placemark-edit-drawer h4{margin:0;font-size:1em}.trk-placemark-edit-drawer small{color:var(--trk-muted);font-weight:400}.trk-placemark-edit-fields{overflow:auto;flex:1;padding:18px;min-height:0}.trk-placemark-edit-drawer fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:16px}.trk-placemark-edit-drawer label{display:grid;gap:6px;margin:0;font-size:.9286em}.trk-placemark-edit-drawer input,.trk-placemark-edit-drawer textarea,.trk-placemark-edit-drawer select{width:100%;min-width:0;font:inherit;color:inherit;background:var(--trk-bg);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:9px;min-height:44px}.trk-placemark-edit-drawer textarea{resize:vertical}.trk-placemark-edit-drawer .trk-placemark-edit-visibility{display:flex;flex-direction:row;align-items:center;gap:8px}.trk-placemark-edit-visibility input{width:20px;min-height:20px;flex:none}.trk-placemark-edit-drawer section{display:grid;gap:12px}.trk-placemark-edit-images{display:grid;gap:12px}.trk-placemark-edit-image{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px}.trk-placemark-edit-image>img,.trk-placemark-edit-image>span{width:72px;height:82px;object-fit:cover;border-radius:var(--trk-radius-sm);background:var(--trk-hover)}.trk-placemark-edit-image>div{display:grid;gap:6px}.trk-placemark-edit-drawer button{min-height:44px;font:inherit;cursor:pointer}.trk-placemark-edit-drawer button:disabled{opacity:.5;cursor:not-allowed}.trk-placemark-edit-drawer input:focus-visible,.trk-placemark-edit-drawer select:focus-visible,.trk-placemark-edit-drawer textarea:focus-visible,.trk-placemark-edit-drawer button:focus-visible,.trk-placemark-edit-library summary:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-placemark-edit-drawer footer{justify-content:flex-end;border-bottom:0;border-top:1px solid var(--trk-border)}.trk-placemark-edit-drawer .trk-primary{color:var(--trk-on-accent);background:var(--trk-primary-bg);border-color:var(--trk-accent)}.trk-placemark-edit-library summary{cursor:pointer;padding:8px 0}.trk-placemark-edit-library>div{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.trk-placemark-edit-library button{display:grid;gap:5px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:4px;background:var(--trk-bg);color:inherit;font-size:.857em}.trk-placemark-edit-library button[aria-pressed=true]{border-color:var(--trk-accent);outline:1px solid var(--trk-accent)}.trk-placemark-edit-library img,.trk-placemark-edit-library .trk-placemark-edit-image-failed{width:100%;height:76px;object-fit:cover;border-radius:3px}.trk-placemark-edit-image-failed{display:grid;place-items:center;text-align:center;color:var(--trk-muted);font-size:12px}.trk-placemark-edit-discard{border:1px solid var(--trk-border);padding:12px;margin-bottom:14px;border-radius:var(--trk-radius-sm)}.trk-placemark-edit-discard p{margin:0 0 10px}.trk-placemark-edit-discard>div{display:flex;gap:8px}.trk-placemark-edit-fields>.trk-error{margin-top:14px;margin-bottom:0}
`
