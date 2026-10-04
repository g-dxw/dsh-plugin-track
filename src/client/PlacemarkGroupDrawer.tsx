import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { PlacemarkGroup, TrackPlacemark } from '../protocol.ts'
import { groupMembers, groupTypes } from '../track/placemark-groups.ts'
import { formatPlacemarkElevation, formatPlacemarkTime, placemarkTitle } from '../track/placemark-format.ts'
import { placemarkTypes } from '../track/placemark-edits.ts'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'

export interface PlacemarkGroupDrawerProps {
  trackId?: string
  group: PlacemarkGroup
  groups: readonly PlacemarkGroup[]
  points: readonly TrackPlacemark[]
  creating?: boolean
  saving: boolean
  error: string
  onSave: (next: PlacemarkGroup) => Promise<boolean>
  onDissolve?: () => Promise<boolean>
  onClose: () => void
  onReturnFocus?: () => void
}

function orderedMemberIds(ids: readonly string[], points: readonly TrackPlacemark[]): string[] {
  const wanted = new Set(ids)
  return [...new Set([...points.filter(point => wanted.has(point.id)).map(point => point.id), ...wanted])]
}

// Saved cover selection is independent of the temporary visible-only slideshow.
function coverPhotos(group: PlacemarkGroup, points: readonly TrackPlacemark[]) {
  return groupMembers(group, points).flatMap(point => [...new Set(point.images.filter((url): url is string => typeof url === 'string').map(imageLink).filter((url): url is string => !!url))].map(url => ({point, url})))
}
function coverPhoto(group: PlacemarkGroup, points: readonly TrackPlacemark[]) {
  const photos = coverPhotos(group, points), url = group.cover && imageLink(group.cover.imageUrl)
  return photos.find(photo => photo.point.id === group.cover?.pointId && photo.url === url) || photos[0]
}

export function PlacemarkGroupDrawer({group, points, trackId, creating = false, saving, error, onSave, onDissolve, onClose, onReturnFocus}: PlacemarkGroupDrawerProps) {
  const initial = useRef({name: group.name, description: group.description, memberIds: orderedMemberIds(group.memberIds, points), cover: group.cover, hidden: !!group.hidden}).current
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [memberIds, setMemberIds] = useState(initial.memberIds)
  const [cover, setCover] = useState(initial.cover)
  const [hidden, setHidden] = useState(initial.hidden)
  const [validation, setValidation] = useState('')
  const [failed, setFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [discard, setDiscard] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const continueEditing = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const titleId = useId()
  const locked = saving || submitting
  const draft: PlacemarkGroup = {...group, name, description, memberIds, hidden, cover}
  const knownIds = new Set(points.map(point => point.id))
  const unresolvedIds = memberIds.filter(id => !knownIds.has(id))
  const retainedCover = cover && unresolvedIds.includes(cover.pointId) ? cover : undefined
  const members = groupMembers(draft, points)
  const photos = coverPhotos(draft, points)
  const currentCover = retainedCover ? undefined : coverPhoto(draft, points)
  const types = groupTypes(draft, points)
  const dirty = creating || JSON.stringify({name, description, memberIds, cover, hidden}) !== JSON.stringify(initial)
  const returnFocus = useRef(onReturnFocus); returnFocus.current = onReturnFocus
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current!
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    nameInput.current?.focus()
    return () => {
      if (element.open && typeof element.close === 'function') element.close()
      if (previous?.isConnected) previous.focus()
      else returnFocus.current?.()
    }
  }, [])
  useEffect(() => {if (discard) continueEditing.current?.focus(); else nameInput.current?.focus()}, [discard])
  function close() {
    if (locked || pending.current || discard) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  function removeMember(id: string) {
    if (locked || discard || !knownIds.has(id) || !memberIds.includes(id)) return
    const nextIds = orderedMemberIds(memberIds.filter(memberId => memberId !== id), points)
    const nextCover = coverPhoto({...draft, memberIds: nextIds}, points)
    setMemberIds(nextIds)
    setCover(retainedCover || (nextCover ? {pointId: nextCover.point.id, imageUrl: nextCover.url} : undefined))
    setValidation('')
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (locked || pending.current || discard) return
    setValidation(''); setFailed(false)
    if (creating ? members.length < 2 : !memberIds.length) {setValidation(creating ? '创建分组至少选择 2 个已恢复的标注点' : '分组至少保留 1 个标注点，可使用解散分组保留全部原点位'); return}
    if (!name.trim()) {setValidation('请输入分组名称'); return}
    if (name.length > 160 || description.length > 10000) {setValidation('分组名称最多 160 个字符，描述最多 10000 个字符'); return}
    const anchor = currentCover?.point || members[0]
    const next: PlacemarkGroup = {...draft, name: name.trim(), memberIds: orderedMemberIds(memberIds, points), coordinates: creating ? [...anchor.coordinates] : [...group.coordinates]}
    if (retainedCover) next.cover = {...retainedCover}
    else if (currentCover) next.cover = {pointId: currentCover.point.id, imageUrl: currentCover.url}
    else delete next.cover
    pending.current = true; setSubmitting(true)
    try {if (await onSave(next)) onClose(); else setFailed(true)}
    catch (reason) {setValidation(reason instanceof Error ? reason.message : '分组未保存，请重试')}
    finally {pending.current = false; setSubmitting(false)}
  }
  async function dissolve() {
    if (!onDissolve || locked || pending.current || discard) return
    pending.current = true; setSubmitting(true); setValidation(''); setFailed(false)
    try {if (await onDissolve()) onClose(); else setFailed(true)}
    catch (reason) {setValidation(reason instanceof Error ? reason.message : '分组未解散，请重试')}
    finally {pending.current = false; setSubmitting(false)}
  }
  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex="0"]')).filter(item => !item.matches(':disabled') && !item.closest('[hidden]'))
    const first = controls[0], last = controls[controls.length - 1]
    if (!first) {event.preventDefault(); return}
    if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus()}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus()}
  }
  return <dialog ref={dialog} className="trk-placemark-edit-drawer trk-placemark-group-drawer" aria-labelledby={titleId} aria-modal="true"
    onKeyDown={trapFocus} onCancel={event => {event.preventDefault(); close()}}>
    <style>{GROUP_DRAWER_CSS}</style>
    <form onSubmit={event => {void save(event)}}>
      <header><div><h3 id={titleId}>{creating ? '创建标记点组' : '编辑标记点组'}</h3><small>原标注点和图片保留，分组仅改变展示</small></div>
        <button type="button" className="trk-secondary" aria-label="关闭分组编辑" disabled={locked} onClick={close}>×</button></header>
      <div className="trk-placemark-edit-fields">
        {discard && <div className="trk-placemark-edit-discard" role="alert"><p>还有未保存的修改，是否放弃？</p><div>
          <button type="button" className="trk-secondary" disabled={locked} onClick={onClose}>放弃修改</button>
          <button ref={continueEditing} type="button" className="trk-secondary" disabled={locked} onClick={() => setDiscard(false)}>继续编辑</button></div></div>}
        <fieldset disabled={locked || discard}>
          <label>分组名称<input ref={nameInput} aria-label="分组名称" maxLength={160} value={name} onChange={event => setName(event.target.value)}/></label>
          <label>描述<textarea aria-label="分组描述" maxLength={10000} rows={3} value={description} onChange={event => setDescription(event.target.value)}/></label>
          <section aria-label="分组成员"><h4>成员 <small>{memberIds.length} 个 · {creating ? '至少 2 个' : '至少 1 个'}</small></h4>
            <div className="trk-placemark-group-members">{members.map(point => {
              const index = points.findIndex(item => item.id === point.id)
              const label = `${index + 1}${placemarkTitle(point) ? ` ${placemarkTitle(point)}` : ''}`
              const title = placemarkTitle(point), types = placemarkTypes(point)
              const elevation = formatPlacemarkElevation(point.elevation), time = formatPlacemarkTime(point.time,point.timeSource)
              const url = point.images.map(imageLink).find((image): image is string => !!image)
              return <div key={point.id} data-group-member-id={point.id} className={`trk-placemark-group-member${point.hidden ? ' is-hidden' : ''}`}>
                <span className="trk-placemark-group-member-thumbnail">{url && <GroupPhoto trackId={trackId} key={url} url={url} label={title || `点位 ${index + 1}`}/>}<span className="trk-placemark-group-member-number">{index + 1}</span></span>
                <span className="trk-placemark-group-member-text">{title && <strong>{title}</strong>}{types.length > 0 && <span className="trk-placemark-group-member-types">{types.map(type => <small key={type}>{type}</small>)}</span>}{elevation && <small>{elevation}</small>}{time && <small>{time}</small>}{point.hidden && <small>已在地图隐藏</small>}</span>
                <button type="button" className="trk-placemark-group-member-remove" aria-label={`移出分组成员：${label}`} title="移出分组" onClick={() => removeMember(point.id)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 12h12m-4-4 4 4-4 4M12 5H4v14h8"/></svg></button>
              </div>
            })}</div>
            <small>添加成员时，在点位列表把未分组点拖入本组；移出成员会在保存后生效。</small>
            {unresolvedIds.length > 0 && <div role="status" className="trk-placemark-group-unresolved"><p>以下 {unresolvedIds.length} 个成员尚未恢复，成员关系暂时保留且不可移除。恢复原始点位后可继续编辑。</p><ul>{unresolvedIds.map(id => <li key={id}>{id}</li>)}</ul></div>}
          </section>
          <section aria-label="分组类型"><h4>类型 <small>来自所有成员，自动汇总</small></h4><div className="trk-placemark-group-types">{types.length ? types.map(type => <span key={type}>{type}</span>) : <small>未分类</small>}</div></section>
          <label className="trk-placemark-group-visibility"><input type="checkbox" aria-label="在地图上显示分组" checked={!hidden} onChange={event => setHidden(!event.target.checked)}/>在地图上显示分组</label>
          <section aria-label="分组封面"><h4>默认图片 <small>从全部成员的图片中选择</small></h4>
            {retainedCover && <p className="trk-muted">封面来源点尚未恢复，保留已保存的封面；选择其他图片后可替换。</p>}
            {photos.length ? <div className="trk-placemark-group-photos">{photos.map(({point, url}, index) => {
              const pointIndex = points.findIndex(item => item.id === point.id) + 1
              const selected = currentCover?.point.id === point.id && currentCover.url === url
              return <button key={`${point.id}:${url}`} type="button" aria-label={`分组封面：${pointIndex}${placemarkTitle(point) ? ` ${placemarkTitle(point)}` : ''} 图片 ${point.images.indexOf(url) + 1}${point.hidden ? '，已在地图隐藏' : ''}`} aria-pressed={selected}
                onClick={() => setCover({pointId: point.id, imageUrl: url})}><GroupPhoto trackId={trackId} url={url} label={`分组图片 ${index + 1}`}/><span>{selected ? '已选择' : '选择'} · {pointIndex}{point.hidden && <small> · 已隐藏</small>}</span></button>
            })}</div> : <p className="trk-muted">所选成员没有图片，分组可继续保存。</p>}
          </section>
        </fieldset>
        {(validation || failed || error) && <div className="trk-error" role="alert">{validation || error || '分组操作失败，请重试'}</div>}
        {!creating && onDissolve && <div className="trk-placemark-group-dissolve"><p>解散后，所有成员恢复为独立标注点，原信息和图片保留。可通过撤销恢复分组。</p><button type="button" className="trk-secondary" disabled={locked || discard} onClick={() => {void dissolve()}}>解散分组</button></div>}
      </div>
      <footer><button type="button" className="trk-secondary" disabled={locked} onClick={close}>取消</button><button type="submit" className="trk-primary" disabled={locked || !dirty || discard}>{locked ? '正在保存…' : creating ? '创建分组' : '保存分组'}</button></footer>
    </form>
  </dialog>
}

function GroupPhoto({url, label, trackId}: {url: string; label: string; trackId?: string}) {
  const [failed, setFailed] = useState(false)
  return failed ? <span className="trk-placemark-group-photo-failed">图片未加载</span> : <img src={trackId ? placemarkPhotoThumbnailUrl(trackId, url) : url} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
}

const GROUP_DRAWER_CSS = `
.trk-placemark-group-member{display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--trk-radius-sm);background:var(--trk-hover);min-width:0}.trk-placemark-group-member.is-hidden{opacity:.6}.trk-placemark-group-member-thumbnail{position:relative;display:grid;place-items:center;flex:none;width:64px;height:76px;background:var(--trk-bg);border-radius:8px;overflow:hidden}.trk-placemark-group-member-thumbnail img,.trk-placemark-group-member-thumbnail .trk-placemark-group-photo-failed{height:100%;width:100%;object-fit:cover;border-radius:0}.trk-placemark-group-member-number{position:absolute;top:4px;left:4px;min-width:22px;padding:1px 5px;border-radius:6px;background:var(--trk-surface);color:var(--trk-text);font-size:.857em;text-align:center}.trk-placemark-group-member-text{display:grid;gap:4px;min-width:0;flex:1;font-size:.9286em}.trk-placemark-group-member-text strong{overflow-wrap:anywhere}.trk-placemark-group-member-types{display:flex;flex-wrap:wrap;gap:4px}.trk-placemark-group-member-types small{padding:1px 5px;border-radius:4px;background:var(--trk-bg)}.trk-placemark-group-drawer .trk-placemark-group-member-remove{display:grid;place-items:center;flex:none;border:0;background:transparent;color:var(--trk-muted);border-radius:6px;min-width:32px;min-height:32px;padding:6px}.trk-placemark-group-drawer .trk-placemark-group-member-remove:hover{background:var(--trk-bg);color:var(--trk-text)}
.trk-placemark-group-unresolved{font-size:.9286em;color:var(--trk-muted);overflow-wrap:anywhere}
.trk-placemark-group-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(440px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;padding:0;border:0;border-left:1px solid var(--trk-border);background:var(--trk-surface);color:var(--trk-text);font:var(--trk-font-size)/1.5 var(--trk-font-family,system-ui,sans-serif);box-shadow:-10px 0 40px var(--trk-shadow);overflow:hidden}.trk-placemark-group-drawer::backdrop{background:rgba(0,0,0,.2)}.trk-placemark-group-drawer form{height:100%;display:flex;flex-direction:column}.trk-placemark-group-drawer header,.trk-placemark-group-drawer footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:18px;border-bottom:1px solid var(--trk-border);flex-shrink:0}.trk-placemark-group-drawer h3,.trk-placemark-group-drawer h4{margin:0;font-size:1em}.trk-placemark-group-drawer small{color:var(--trk-muted);font-weight:400}.trk-placemark-group-drawer .trk-placemark-edit-fields{overflow:auto;flex:1;padding:18px;min-height:0;scroll-padding-block:12px}.trk-placemark-group-drawer fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:16px}.trk-placemark-group-drawer label{display:grid;gap:6px;margin:0;font-size:.9286em}.trk-placemark-group-drawer input,.trk-placemark-group-drawer textarea{width:100%;min-width:0;font:inherit;color:inherit;background:var(--trk-bg);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:9px;min-height:44px}.trk-placemark-group-drawer textarea{resize:vertical}.trk-placemark-group-drawer section{display:grid;gap:12px}.trk-placemark-group-drawer button{min-height:44px;min-width:44px;font:inherit;cursor:pointer}.trk-placemark-group-drawer button:disabled,.trk-placemark-group-drawer input:disabled{opacity:.5;cursor:not-allowed}.trk-placemark-group-drawer input:focus-visible,.trk-placemark-group-drawer textarea:focus-visible,.trk-placemark-group-drawer button:focus-visible{outline:2px solid var(--trk-focus);outline-offset:2px}.trk-placemark-group-drawer footer{justify-content:flex-end;border-bottom:0;border-top:1px solid var(--trk-border)}.trk-placemark-group-drawer .trk-primary{color:var(--trk-on-accent);background:var(--trk-primary-bg);border-color:var(--trk-accent)}.trk-placemark-group-drawer .trk-placemark-edit-discard{border:1px solid var(--trk-border);padding:12px;margin-bottom:14px;border-radius:var(--trk-radius-sm)}.trk-placemark-group-drawer .trk-placemark-edit-discard p{margin:0 0 10px}.trk-placemark-group-drawer .trk-placemark-edit-discard>div{display:flex;gap:8px}.trk-placemark-group-drawer .trk-error{margin-top:14px;margin-bottom:0}.trk-placemark-group-members{display:grid;gap:8px}.trk-placemark-group-drawer .trk-placemark-group-members label,.trk-placemark-group-drawer .trk-placemark-group-visibility{display:flex;align-items:center;gap:8px;min-height:44px}.trk-placemark-group-members label{padding:8px 10px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm)}.trk-placemark-group-members label.is-selected{border-color:var(--trk-accent);background:var(--trk-hover)}.trk-placemark-group-members span{min-width:0;overflow-wrap:anywhere}.trk-placemark-group-drawer input[type=checkbox]{width:20px;height:20px;min-height:20px;padding:0;flex:none;accent-color:var(--trk-accent)}.trk-placemark-group-types{display:flex;flex-wrap:wrap;gap:8px}.trk-placemark-group-types>span{padding:4px 8px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);overflow-wrap:anywhere}.trk-placemark-group-photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.trk-placemark-group-photos button{display:grid;gap:5px;border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);padding:4px;background:var(--trk-bg);color:inherit;font-size:.857em;min-width:0}.trk-placemark-group-photos button[aria-pressed=true]{border-color:var(--trk-accent);outline:1px solid var(--trk-accent)}.trk-placemark-group-photos img,.trk-placemark-group-photo-failed{width:100%;height:84px;object-fit:cover;border-radius:3px}.trk-placemark-group-photo-failed{display:grid;place-items:center;color:var(--trk-muted);font-size:12px}.trk-placemark-group-dissolve{margin-top:20px;padding-top:16px;border-top:1px solid var(--trk-border);font-size:.9286em}.trk-placemark-group-dissolve p{margin:0 0 10px}
`
