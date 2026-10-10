/** Distance-based route playback, with a map-only WebM capture session. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TrackRecord } from '../protocol.ts'
import type { BasemapId } from '../track/basemaps.ts'
import type { TrackFrameRenderer } from '../track/frame-renderer.ts'
import { advancePlayback, createPlaybackPath } from '../track/playback.ts'
import { clipTitle } from '../track/title.ts'
import { AnimationMap, type AnimationShot } from './AnimationMap.tsx'
import { clipboardSafeName } from './util.ts'

export type { AnimationShot } from './AnimationMap.tsx'
export interface TrackAnimationProps {
  track: TrackRecord
  basemap: BasemapId
  onBasemap: (next: BasemapId) => void
  onCancel: () => void
  backLabel?: string
  /** Adapter exposed for future encoders; ordinary playback continues to use MediaRecorder. */
  onFrameRenderer?: (renderer: TrackFrameRenderer | null) => void
  /** Generated/approved by the parent. Durations are seconds. */
  script?: readonly AnimationShot[]
}
type Capture = {
  recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; mime: string
  started: boolean; awaitingFinalFrame: boolean; discard: boolean; stopping: boolean; released: boolean; endingTimer: ReturnType<typeof setTimeout> | null
}
type Video = {url: string; filename: string}
const DURATIONS = [15, 30, 60] as const

function recordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(mime)) return mime
  }
  return null
}
function release(session: Capture): void {
  if (session.released) return
  session.released = true
  if (session.endingTimer !== null) clearTimeout(session.endingTimer)
  session.endingTimer = null
  for (const track of session.stream.getTracks()) track.stop()
}
function validScript(script: readonly AnimationShot[] | undefined, points: number): boolean {
  if (!script) return true
  return script.length >= 1 && script.length <= 12 && script.reduce((sum, shot) => sum + shot.duration, 0) <= 180
    && script.every(shot => ['overview', 'follow', 'checkpoint'].includes(shot.type) && Number.isFinite(shot.duration) && shot.duration >= 3 && shot.duration <= 30
      && (shot.type !== 'checkpoint' || Number.isInteger(shot.pointIndex) && shot.pointIndex! >= 0 && shot.pointIndex! < points))
}

export function TrackAnimation(props: TrackAnimationProps) {
  const path = useMemo(() => createPlaybackPath(props.track.coordinates), [props.track.coordinates])
  const [durationChoice, setDurationChoice] = useState<number>(30)
  const scriptValid = validScript(props.script, path.points.length)
  const duration = props.script && scriptValid ? props.script.reduce((sum, shot) => sum + shot.duration, 0) : durationChoice
  const [progress, setProgress] = useState(0)
  const currentProgress = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [captureRequest, setCaptureRequest] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [video, setVideo] = useState<Video | null>(null)
  const videoRef = useRef<Video | null>(null)
  const capture = useRef<Capture | null>(null)
  const frame = useRef<number | null>(null)
  const lastTimestamp = useRef<number | null>(null)
  const alive = useRef(true)
  const mime = useMemo(recordingMime, [])
  const title = clipTitle(props.track.name, props.track.filename)
  const available = path.points.length >= 2 && !mapError && scriptValid
  const canRecord = available && !!mime && !!canvas && typeof canvas.captureStream === 'function' && !captureError
  const shotIndex = useMemo(() => {
    if (!props.script || !scriptValid) return -1
    let elapsed = progress * duration
    for (let index = 0; index < props.script.length - 1; index++) {
      if (elapsed < props.script[index].duration) return index
      elapsed -= props.script[index].duration
    }
    return props.script.length - 1
  }, [props.script, scriptValid, progress, duration])
  const shot = shotIndex < 0 ? undefined : props.script?.[shotIndex]

  const clearVideo = useCallback(() => {
    if (videoRef.current) URL.revokeObjectURL(videoRef.current.url)
    videoRef.current = null
    if (alive.current) setVideo(null)
  }, [])
  const discardCapture = useCallback(() => {
    const session = capture.current
    if (!session) return
    capture.current = null
    session.discard = true
    session.recorder.ondataavailable = null; session.recorder.onstop = null; session.recorder.onerror = null
    try { if (session.recorder.state !== 'inactive') session.recorder.stop() } catch { /* tracks are still released */ }
    release(session)
    if (alive.current) {setRecording(false); setPreparing(false); setExporting(false)}
  }, [])
  const stopFrames = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null; lastTimestamp.current = null
  }, [])
  const setPosition = useCallback((next: number) => {
    currentProgress.current = Math.max(0, Math.min(1, next))
    lastTimestamp.current = null
    setProgress(currentProgress.current)
  }, [])
  const finishCapture = useCallback((session: Capture) => {
    if (capture.current !== session || session.discard) return
    capture.current = null
    session.recorder.ondataavailable = null; session.recorder.onstop = null; session.recorder.onerror = null
    release(session)
    if (!alive.current) return
    setRecording(false); setPreparing(false); setExporting(false)
    if (!session.chunks.length) {setError('录制未生成视频数据，请重试。'); return}
    try {
      const blob = new Blob(session.chunks, {type: session.recorder.mimeType || session.mime})
      clearVideo()
      const next = {url: URL.createObjectURL(blob), filename: clipboardSafeName(title) + '-动画.webm'}
      videoRef.current = next; setVideo(next)
      setNote('WebM 视频已生成，可以下载。视频保留地图标题、进度和地图署名。')
    } catch (reason) {setError('无法生成视频：' + (reason instanceof Error ? reason.message : String(reason)))}
  }, [clearVideo, title])
  const stopRecording = useCallback(() => {
    const session = capture.current
    if (!session || session.stopping) return
    if (!session.started) {
      discardCapture()
      setError('地图录制画面尚未就绪，请重试。')
      return
    }
    if (session.endingTimer !== null) clearTimeout(session.endingTimer)
    session.stopping = true
    setExporting(true)
    session.endingTimer = setTimeout(() => {
      if (capture.current !== session) return
      discardCapture()
      setError('浏览器未能完成视频封装，已释放录制资源，请重试。')
    }, 5000)
    try { if (session.recorder.state !== 'inactive') session.recorder.stop() }
    catch (reason) {
      discardCapture()
      setError('无法完成视频：' + (reason instanceof Error ? reason.message : String(reason)))
    }
  }, [discardCapture])

  useEffect(() => {
    alive.current = true
    return () => {alive.current = false; stopFrames(); discardCapture(); clearVideo()}
  }, [stopFrames, discardCapture, clearVideo])
  useEffect(() => {
    stopFrames(); discardCapture(); clearVideo()
    setPosition(0); setPlaying(false); setError(''); setNote('')
    return () => {stopFrames(); discardCapture(); clearVideo()}
  }, [props.track.id, props.track.coordinates, props.script, stopFrames, discardCapture, clearVideo, setPosition])
  useEffect(() => {
    if (!mapError) return
    stopFrames(); setPlaying(false); stopRecording()
  }, [mapError, stopFrames, stopRecording])
  useEffect(() => {
    if (!playing || !available) return
    let published = -Infinity
    const tick = (timestamp: number) => {
      const elapsed = lastTimestamp.current === null ? 0 : Math.max(0, timestamp - lastTimestamp.current)
      lastTimestamp.current = timestamp
      currentProgress.current = advancePlayback(currentProgress.current, elapsed, duration * 1000)
      if (timestamp - published >= 32 || currentProgress.current >= 1) {
        published = timestamp
        setProgress(currentProgress.current)
      }
      if (currentProgress.current >= 1) {
        frame.current = null; lastTimestamp.current = null
        setPlaying(false)
        const session = capture.current
        if (session?.started && !session.stopping) {
          session.awaitingFinalFrame = true
          setExporting(true)
          session.endingTimer = setTimeout(() => {
            if (capture.current !== session || !session.awaitingFinalFrame) return
            discardCapture()
            setError('终点画面加载超过 5 秒，已释放录制资源，请重试。')
          }, 5000)
        }
      } else frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return stopFrames
  }, [playing, available, duration, stopRecording, stopFrames, discardCapture])

  const onCanvas = useCallback((next: HTMLCanvasElement | null) => {if (alive.current) setCanvas(next)}, [])
  const onUnavailable = useCallback((message: string | null) => {if (alive.current) setMapError(message)}, [])
  const onCaptureError = useCallback((message: string | null) => {
    if (!alive.current) return
    setCaptureError(message)
    if (message && capture.current) {stopFrames(); setPlaying(false); stopRecording()}
  }, [stopFrames, stopRecording])
  const onCaptureFrame = useCallback((paintedProgress: number) => {
    const session = capture.current
    if (!session || session.stopping) return
    if (session.started) {
      if (session.awaitingFinalFrame && paintedProgress === 1) {
        session.awaitingFinalFrame = false
        if (session.endingTimer !== null) clearTimeout(session.endingTimer)
        // Let the 30 fps canvas stream copy the completed map frame before stop.
        session.endingTimer = setTimeout(stopRecording, 100)
      }
      return
    }
    if (paintedProgress !== 0) return
    // Start only after the zero-progress sources are loaded and actually rendered.
    if (session.endingTimer !== null) clearTimeout(session.endingTimer)
    session.endingTimer = null
    session.started = true
    try {
      session.recorder.start(1000)
      setPreparing(false); setPlaying(true)
    } catch (reason) {
      discardCapture()
      setError('无法开始录制：' + (reason instanceof Error ? reason.message : String(reason)))
    }
  }, [discardCapture, stopRecording])
  function playPause() {
    if (!available || exporting || preparing) return
    const session = capture.current
    try {
      if (playing) {
        stopFrames(); setPlaying(false)
        if (session?.recorder.state === 'recording') session.recorder.pause()
      } else {
        if (currentProgress.current >= 1) setPosition(0)
        if (session?.recorder.state === 'paused') session.recorder.resume()
        setPlaying(true)
      }
    } catch (reason) {
      discardCapture()
      setError('录制暂停或继续失败：' + (reason instanceof Error ? reason.message : String(reason)))
    }
  }
  function restart() {
    if (!available || capture.current || exporting) return
    stopFrames(); setPosition(0); setPlaying(true); setError('')
  }
  function startRecording() {
    if (!canRecord || !canvas || !mime || capture.current) return
    stopFrames(); setPlaying(false); clearVideo(); setError(''); setNote('')
    let stream: MediaStream | null = null
    try {
      stream = canvas.captureStream(30)
      if (!stream.getVideoTracks().length) throw new Error('浏览器没有提供可录制的画面轨道')
      const recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 6_000_000})
      const session: Capture = {recorder, stream, chunks: [], mime, started: false, awaitingFinalFrame: false, discard: false, stopping: false, released: false, endingTimer: null}
      capture.current = session
      recorder.ondataavailable = event => {if (capture.current === session && !session.discard && event.data.size) session.chunks.push(event.data)}
      recorder.onstop = () => finishCapture(session)
      recorder.onerror = () => {
        if (capture.current !== session) return
        discardCapture(); setError('浏览器录制失败，仍可继续播放动画或重试录制。')
      }
      session.endingTimer = setTimeout(() => {
        if (capture.current !== session || session.started) return
        discardCapture()
        setError('起点画面加载超过 5 秒，已释放录制资源，请重试。')
      }, 5000)
      setPosition(0)
      setRecording(true); setPreparing(true); setCaptureRequest(value => value + 1)
    } catch (reason) {
      if (capture.current) discardCapture()
      else for (const track of stream?.getTracks() ?? []) track.stop()
      setError('无法开始录制：' + (reason instanceof Error ? reason.message : String(reason)))
    }
  }
  function cancel() {
    stopFrames(); setPlaying(false); discardCapture(); clearVideo(); props.onCancel()
  }

  return <section className="trk-animation" aria-label="轨迹动画与视频">
    <style>{ANIMATION_CSS}</style>
    <header className="trk-animation-head">
      <div><h2>轨迹动画</h2><p>{title} · 按路程播放轨迹，不依赖文件中的录制时间。</p></div>
      <button type="button" onClick={cancel}>{props.backLabel || '返回轨迹详情'}</button>
    </header>
    {(error || mapError || !scriptValid) && <div role="alert" className="trk-animation-error">{error || mapError || '镜头脚本无效：需 1–12 个镜头，每个 3–30 秒，总时长不超过 180 秒，聚焦点索引必须有效。'}</div>}
    {note && <div role="status" className="trk-animation-note">{note}</div>}
    {path.points.length < 2 && <div role="alert" className="trk-animation-error">这条轨迹至少需要两个有效坐标点才能播放动画。</div>}
    <div className="trk-animation-stage">
      <AnimationMap points={props.track.coordinates} name={title} progress={progress} elapsedMs={progress * duration * 1000} onFrameRenderer={props.onFrameRenderer} basemap={props.basemap} onBasemap={props.onBasemap}
        onCanvas={onCanvas} onUnavailable={onUnavailable} onCaptureError={onCaptureError} onCaptureFrame={onCaptureFrame} captureRequest={captureRequest} disabledBasemap={recording || exporting}
        shot={shot} shotIndex={shotIndex} />
    </div>
    <div className="trk-animation-controls">
      <div className="trk-animation-actions">
        <button type="button" className="trk-animation-primary" disabled={!available || exporting || preparing} onClick={playPause}>{playing ? '暂停' : progress > 0 && progress < 1 ? '继续播放' : '播放'}</button>
        <button type="button" disabled={!available || recording || exporting} onClick={restart}>重新播放</button>
        <label>总时长<select aria-label="动画总时长" value={durationChoice} disabled={recording || exporting || !!props.script} onChange={event => {
          stopFrames(); setPlaying(false); setDurationChoice(Number(event.target.value)); setPosition(0)
        }}>{DURATIONS.map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
        {props.script && scriptValid && <span className="trk-animation-script-time">脚本共 {props.script.length} 个镜头 · {duration} 秒</span>}
        {recording ? <button type="button" disabled={exporting || preparing} onClick={() => {stopFrames(); setPlaying(false); stopRecording()}}>{preparing ? '准备录制…' : exporting ? '正在生成视频…' : '停止并导出'}</button>
          : <button type="button" disabled={!canRecord || exporting} onClick={startRecording}>录制并导出 WebM</button>}
        {video && <a className="trk-animation-download" href={video.url} download={video.filename}>下载 WebM</a>}
      </div>
      <label className="trk-animation-progress">播放进度
        <input aria-label="播放进度" type="range" min={0} max={1000} value={Math.round(progress * 1000)} disabled={!available || recording || exporting}
          onChange={event => setPosition(Number(event.target.value) / 1000)} />
      </label>
      <div className="trk-animation-status"><output aria-label="当前播放进度">{Math.round(progress * 100)}% · {Math.round(progress * duration)} / {duration} 秒</output>
        <span>{recording ? preparing ? '准备录制' : exporting ? '正在生成视频' : playing ? '正在录制' : '录制已暂停' : progress >= 1 ? '播放完成' : playing ? '正在播放' : '已暂停'}{shot ? ' · 镜头 ' + (shotIndex + 1) + ' / ' + props.script!.length + ' · ' + ({overview: '全景', follow: '跟随', checkpoint: '点位聚焦'}[shot.type]) : ''}</span>
      </div>
      <p>可拖动和缩放地图调整构图。录制从起点开始，只包含地图画面；标题、播放进度和地图署名保留在视频中。</p>
      {!mime && <p className="trk-animation-support" role="status">当前浏览器不支持 WebM 录制，仍可播放动画。</p>}
      {mime && !canvas && !captureError && !mapError && <p role="status">正在准备地图录制画面…</p>}
      {mime && canvas && typeof canvas.captureStream !== 'function' && <p className="trk-animation-support" role="status">当前浏览器不支持 canvas.captureStream，仍可播放动画。</p>}
      {captureError && <p className="trk-animation-support" role="status">{captureError}</p>}
    </div>
  </section>
}

const ANIMATION_CSS = `
.trk-animation{color:var(--trk-text);font:inherit;font-size:var(--trk-ui-font-size,13px)}.trk-animation *{box-sizing:border-box}.trk-animation h2{margin:0 0 8px;font-size:16px}.trk-animation p{font-size:var(--trk-ui-label-size,12px);line-height:1.7;margin:8px 0;color:var(--trk-muted)}.trk-animation button,.trk-animation select,.trk-animation-download{font:inherit;font-size:var(--trk-ui-label-size,12px);min-height:var(--trk-control-height,32px);border:1px solid var(--trk-border);border-radius:var(--trk-radius-sm);color:var(--trk-text);background:var(--trk-surface);padding:5px 9px}.trk-animation button{cursor:pointer}.trk-animation button:hover:not(:disabled){background:var(--trk-hover)}.trk-animation button:disabled,.trk-animation select:disabled{opacity:.45;cursor:not-allowed}.trk-animation button:focus-visible,.trk-animation select:focus-visible,.trk-animation a:focus-visible,.trk-animation input:focus-visible{outline:2px solid var(--trk-focus);outline-offset:3px}.trk-animation-head{display:flex;gap:8px;justify-content:space-between;align-items:flex-start;margin-bottom:0;padding:8px 10px;border:1px solid var(--trk-border);border-bottom:0;background:var(--trk-surface)}.trk-animation-head>button{flex-shrink:0}.trk-animation-stage{border:1px solid var(--trk-border);border-radius:0;overflow:hidden}.trk-animation-map{position:relative;width:100%;height:min(56vh,520px);min-height:320px;background:var(--trk-map-background)}.trk-animation-map .trk-map{position:absolute;inset:0;width:100%;height:100%}.trk-animation-basemaps{position:absolute;top:10px;left:10px;right:60px;display:flex;flex-wrap:wrap;gap:6px}.trk-animation-basemaps button{background:var(--trk-overlay);color:var(--trk-overlay-text);min-height:var(--trk-control-height,32px)}.trk-animation-basemaps button[aria-pressed=true]{color:var(--trk-text);border-color:var(--trk-accent);background-color:var(--trk-overlay);background-image:linear-gradient(var(--trk-active),var(--trk-active))}.trk-animation .trk-animation-basemaps button:hover:not(:disabled){background-color:var(--trk-overlay);background-image:linear-gradient(var(--trk-hover),var(--trk-hover))}.trk-animation-map-note{position:absolute;bottom:30px;left:10px;right:10px;background:var(--trk-overlay);color:var(--trk-overlay-text);border-radius:var(--trk-radius-sm);padding:6px 8px;font-size:var(--trk-ui-label-size,12px);line-height:1.6}.trk-animation-controls{padding:10px;border:1px solid var(--trk-border);border-top:0;background:var(--trk-surface)}.trk-animation-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.trk-animation-actions label{display:flex;align-items:center;gap:8px;font-size:var(--trk-ui-label-size,12px)}.trk-animation select{background:var(--trk-bg);min-height:var(--trk-input-height,30px);padding:4px 7px}.trk-animation .trk-animation-primary:hover:not(:disabled),.trk-animation-download:hover{background:var(--trk-primary-bg);color:var(--trk-on-accent)}.trk-animation .trk-animation-primary,.trk-animation-download{background:var(--trk-primary-bg);color:var(--trk-on-accent);border-color:var(--trk-accent);font-weight:650;text-decoration:none}.trk-animation-script-time{font-size:var(--trk-ui-label-size,12px);color:var(--trk-muted)}.trk-animation-progress{display:flex;align-items:center;gap:8px;font-size:var(--trk-ui-label-size,12px);margin-top:8px;font-variant-numeric:tabular-nums}.trk-animation-progress input{flex:1;min-width:0;min-height:var(--trk-control-height,32px);accent-color:var(--trk-accent);cursor:pointer}.trk-animation-status{display:flex;justify-content:space-between;gap:8px;font-size:var(--trk-ui-label-size,12px);color:var(--trk-muted);font-variant-numeric:tabular-nums}.trk-animation-error,.trk-animation-note{padding:8px 10px;margin-bottom:8px;border:1px solid var(--trk-danger-border);border-radius:var(--trk-radius-md);background:var(--trk-danger-bg);color:var(--trk-danger);font-size:var(--trk-ui-label-size,12px);line-height:1.7}.trk-animation-note{border-color:var(--trk-notice-border);background:var(--trk-notice-bg);color:var(--trk-notice)}.trk-animation .trk-animation-support{color:var(--trk-warning)}
@container(max-width:600px){.trk-animation-head{flex-direction:column}.trk-animation-actions>button,.trk-animation-download{flex:1;text-align:center}.trk-animation-map{height:420px}.trk-animation-status{flex-direction:column;gap:5px}}
@media(max-width:600px){.trk-animation-head{flex-direction:column}.trk-animation-actions>button,.trk-animation-download{flex:1}.trk-animation-status{flex-direction:column}.trk-animation-map{height:420px}}
@media(forced-colors:active){.trk-animation button,.trk-animation select,.trk-animation a{background:var(--trk-bg);color:var(--trk-text);border-color:var(--trk-border)}.trk-animation-error,.trk-animation-note,.trk-animation-map-note{background:var(--trk-bg);color:var(--trk-text);border-color:var(--trk-border)}.trk-animation-basemaps button[aria-pressed=true]{color:var(--trk-text);border:2px solid var(--trk-focus)}}

@container(max-width:760px){.trk-animation button,.trk-animation-download,.trk-animation-progress input,.trk-animation-basemaps button{min-height:44px}.trk-animation select{min-height:40px}.trk-animation-actions,.trk-animation-basemaps{gap:8px}}
@media(pointer:coarse){.trk-animation button,.trk-animation-download,.trk-animation-progress input,.trk-animation-basemaps button{min-height:44px}.trk-animation select{min-height:40px}.trk-animation-actions,.trk-animation-basemaps{gap:8px}}
`




