// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest'
import {observeOpenMontageBoardTheme, syncOpenMontageBoardTheme, syncOpenMontageBoardVisibility} from '../src/client/openmontage-board-theme.ts'

afterEach(() => {document.body.innerHTML = ''; vi.restoreAllMocks()})
function setup(background = 'rgb(248, 250, 252)') {
  const scope = document.createElement('section'), frame = document.createElement('iframe')
  frame.src = 'http://127.0.0.1:54321/p/test-project'
  scope.append(frame); document.body.append(scope)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({backgroundColor: background, colorScheme: 'light'} as CSSStyleDeclaration))
  return {scope, frame, post, styles}
}

it.each([
  ['rgb(248, 250, 252)', 'light'], ['rgb(17, 23, 34)', 'dark'],
  ['color(srgb 0.96 0.97 0.99)', 'light'], ['color(srgb 0.07 0.09 0.13)', 'dark'],
  ['color(display-p3 0.96 0.97 0.99)', 'light'],
  ['rgb(96% 97% 99%)', 'light'],
])('sends only appearance with exact board origin for %s', (background, theme) => {
  const {frame, scope, post} = setup(background)
  syncOpenMontageBoardTheme(frame, scope)
  expect(post).toHaveBeenCalledExactlyOnceWith({type: 'track-openmontage-theme', theme}, 'http://127.0.0.1:54321')
  expect(scope.children).toHaveLength(1)
})

it('does not send theme data to arbitrary iframe addresses', () => {
  const {frame, scope, post} = setup()
  frame.src = 'https://example.org/p/test-project'
  syncOpenMontageBoardTheme(frame, scope)
  expect(post).not.toHaveBeenCalled()
})

it('follows host appearance changes without reloading the board and disposes its observer', async () => {
  const {frame, scope, post, styles} = setup(), url = frame.src
  const dispose = observeOpenMontageBoardTheme(frame, scope)
  styles.mockReturnValue({backgroundColor: 'rgb(17, 23, 34)', colorScheme: 'dark'} as CSSStyleDeclaration)
  document.body.dataset.theme = 'dark'
  await Promise.resolve(); await Promise.resolve()
  expect(post).toHaveBeenLastCalledWith({type: 'track-openmontage-theme', theme: 'dark'}, 'http://127.0.0.1:54321')
  expect(frame.src).toBe(url)
  dispose(); const previous = post.mock.calls.length
  document.body.dataset.theme = 'light'
  await Promise.resolve(); await Promise.resolve()
  expect(post).toHaveBeenCalledTimes(previous)
  delete document.body.dataset.theme
})

it('informs the board when hidden without changing project identity or starting playback', () => {
  const {frame, scope, post, styles} = setup()
  scope.className = 'trk-om-board'
  styles.mockReturnValue({display: 'none'} as CSSStyleDeclaration)
  syncOpenMontageBoardVisibility(frame)
  expect(post).toHaveBeenLastCalledWith({type: 'track-openmontage-visibility', visible: false}, 'http://127.0.0.1:54321')
  styles.mockReturnValue({display: 'block'} as CSSStyleDeclaration)
  syncOpenMontageBoardVisibility(frame)
  expect(post).toHaveBeenLastCalledWith({type: 'track-openmontage-visibility', visible: true}, 'http://127.0.0.1:54321')
  expect(frame.src).toContain('/p/test-project')
})
