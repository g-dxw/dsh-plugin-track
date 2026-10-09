// @vitest-environment jsdom
import {act, createElement, useState} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {EditorConfirmationDialog, useEditorNavigation, type EditorNavigationHandle, type EditorNavigationOptions} from '../src/client/editor-navigation.tsx'

let host: HTMLDivElement, root: Root, options: EditorNavigationOptions, handle: EditorNavigationHandle | null
let next: Mock<() => void>, registered: Mock<(value: EditorNavigationHandle | null) => void>
function Harness() {
  const navigation = useEditorNavigation(options)
  return createElement('div', null, createElement('button', {onClick: () => navigation.requestLeave(next)}, '切换场景'), navigation.dialog)
}
function button(text: string) {const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!result) throw new Error(`Missing button ${text}`); return result}
async function render(patch: Partial<EditorNavigationOptions> = {}) {options = {...options, ...patch}; await act(async () => root.render(createElement(Harness)))}
async function click(text: string) {await act(async () => button(text).click())}
async function key(element: Element, value: string, shiftKey = false) {await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', {key: value, shiftKey, bubbles: true, cancelable: true})))}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes}); return {promise, resolve}}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  handle = null; next = vi.fn(); registered = vi.fn(value => {handle = value})
  options = {active: true, dirty: false, busy: false, save: vi.fn(async () => true), discard: vi.fn(), onRegister: registered}
})
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals()})

describe('shared editor navigation', () => {
  it('registers only an active editor and leaves a clean draft without saving', async () => {
    await render(); expect(handle).toMatchObject({busy: false})
    await click('切换场景'); expect(next).toHaveBeenCalledTimes(1); expect(options.save).not.toHaveBeenCalled()
    await render({active: false}); expect(registered).toHaveBeenLastCalledWith(null)
    await click('切换场景'); expect(next).toHaveBeenCalledTimes(1)
    await render({active: true}); expect(handle).toMatchObject({busy: false})
  })
  it('keeps a dirty draft in place until a decision, and cancels with trigger focus restored', async () => {
    await render({dirty: true}); const trigger = button('切换场景'); trigger.focus(); await click('切换场景')
    expect(next).not.toHaveBeenCalled(); expect(options.save).not.toHaveBeenCalled(); expect(options.discard).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('保存后继续'))
    await click('取消'); expect(host.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(trigger)
    await click('切换场景'); await key(button('保存后继续'), 'Escape')
    expect(host.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(trigger)
  })
  it('discards only after an explicit decision and makes no save call', async () => {
    await render({dirty: true}); await click('切换场景'); await click('放弃本次修改')
    expect(options.discard).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1)
    expect(options.save).not.toHaveBeenCalled(); expect(host.querySelector('[role=dialog]')).toBeNull()
  })
  it('waits for a confirmed save, dedupes repeated requests and traps focus while busy', async () => {
    const save = deferred<boolean>(); options.save = vi.fn(() => save.promise)
    await render({dirty: true}); await click('切换场景'); await click('保存后继续')
    const dialog = host.querySelector<HTMLElement>('[role=dialog]')!
    expect(options.save).toHaveBeenCalledTimes(1); expect(handle?.busy).toBe(true); expect(next).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(dialog)
    expect([...dialog.querySelectorAll('button')].every(item => item.disabled)).toBe(true)
    await act(async () => handle?.requestLeave(next)); await key(dialog, 'Tab'); await key(dialog, 'Escape')
    expect(document.activeElement).toBe(dialog); expect(host.querySelector('[role=dialog]')).toBe(dialog)
    await act(async () => save.resolve(true))
    expect(next).toHaveBeenCalledTimes(1); expect(options.save).toHaveBeenCalledTimes(1); expect(host.querySelector('[role=dialog]')).toBeNull()
  })
  it('retains the destination and dialog after false or rejected saves and can retry', async () => {
    const save = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('保存冲突')).mockResolvedValueOnce(true)
    await render({dirty: true, save}); await click('切换场景'); await click('保存后继续')
    expect(host.querySelector('[role=dialog]')).not.toBeNull(); expect(host.textContent).toContain('当前修改已保留'); expect(next).not.toHaveBeenCalled()
    await click('保存后继续'); expect(host.textContent).toContain('保存冲突'); expect(next).not.toHaveBeenCalled()
    await click('保存后继续'); expect(next).toHaveBeenCalledTimes(1); expect(options.discard).not.toHaveBeenCalled()
  })
  it('blocks requests during export or an external save and ignores a stale save after deactivation', async () => {
    await render({dirty: true, busy: true}); expect(handle?.busy).toBe(true); await click('切换场景')
    expect(host.querySelector('[role=dialog]')).toBeNull(); expect(next).not.toHaveBeenCalled()
    const save = deferred<boolean>(); await render({busy: false, save: vi.fn(() => save.promise)})
    await click('切换场景'); await click('保存后继续'); await render({active: false})
    await act(async () => save.resolve(true)); expect(next).not.toHaveBeenCalled(); expect(registered).toHaveBeenLastCalledWith(null)
  })
  it('cycles keyboard focus within the pending decision', async () => {
    await render({dirty: true}); await click('切换场景')
    await key(button('保存后继续'), 'Tab', true); expect(document.activeElement).toBe(button('取消'))
    await key(button('取消'), 'Tab'); expect(document.activeElement).toBe(button('保存后继续'))
  })
  it('uses a separate action confirmation that traps focus and never commits on cancel', async () => {
    const confirm = vi.fn()
    function ConfirmationHarness({busy = false}: {busy?: boolean}) {
      const [open, setOpen] = useState(false)
      return createElement('div', null, createElement('button', {onClick: () => setOpen(true)}, '重建'), open && createElement(EditorConfirmationDialog, {title: '重建工程？', description: '将重置镜头关键帧', confirmLabel: '确认重建工程', busy, onConfirm: () => {confirm(); setOpen(false)}, onCancel: () => setOpen(false)}))
    }
    await act(async () => root.render(createElement(ConfirmationHarness)))
    const trigger = button('重建'); trigger.focus(); await click('重建')
    expect(document.activeElement).toBe(button('确认重建工程')); await key(button('确认重建工程'), 'Tab', true)
    expect(document.activeElement).toBe(button('取消')); await key(button('取消'), 'Escape')
    expect(confirm).not.toHaveBeenCalled(); expect(host.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(trigger)
    await click('重建'); await act(async () => root.render(createElement(ConfirmationHarness, {busy: true})))
    const dialog = host.querySelector<HTMLElement>('[role=dialog]')!; expect(document.activeElement).toBe(dialog)
    await key(dialog, 'Escape'); await key(dialog, 'Tab'); expect(host.querySelector('[role=dialog]')).toBe(dialog)
    await act(async () => root.render(createElement(ConfirmationHarness, {busy: false}))); await click('确认重建工程')
    expect(confirm).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(trigger)
  })
})
