import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listResourceTemplates, removeResourceTemplate, saveResourceTemplate } from '../src/resource-templates-store.ts'

let env: NodeJS.ProcessEnv
beforeEach(() => {env = {DSH_HOME: mkdtempSync(join(tmpdir(), 'track-resource-templates-'))}})
afterEach(() => {rmSync(env.DSH_HOME!, {recursive: true, force: true})})
const input = {name: '自然光线', prompt: '保留山脊和人物，平衡曝光', category: '徒步', tags: ['自然', '自然'], mode: 'edit'}
const file = () => join(env.DSH_HOME!, 'track-resource-templates', 'templates.json')
describe('empty user-owned resource template library', () => {
  it('starts empty without writing built-in presets', () => {
    expect(listResourceTemplates(env)).toEqual([])
    expect(existsSync(file())).toBe(false)
  })
  it('persists create/edit/copy/remove with versions and stable original creation time', () => {
    const first = saveResourceTemplate(input, env)
    expect(first).toMatchObject({...input, tags: ['自然'], version: 1})
    expect(listResourceTemplates(env)).toEqual([first])
    const edited = saveResourceTemplate({...first, prompt: '保留真实地点，增强夕阳层次'}, env)
    expect(edited).toMatchObject({id: first.id, version: 2, createdAt: first.createdAt})
    const copied = saveResourceTemplate({...edited, id: undefined, name: edited.name + '副本'}, env)
    expect(copied.id).not.toBe(first.id)
    expect(copied.version).toBe(1)
    expect(removeResourceTemplate(first.id, env)).toEqual([copied])
    expect(listResourceTemplates(env)).toEqual([copied])
  })
  it('preserves reference authors and canonical safe URLs when copied and edited', () => {
    const source = {kind: 'etubao', sourceId: 'handraw', caseId: 'case-1', sourceLabel: '@作者', sourceUrl: 'https://example.com/author', homepage: 'https://example.com/'}
    const first = saveResourceTemplate({...input, source}, env)
    const edited = saveResourceTemplate({...first, name: '我的手绘旅行海报'}, env)
    expect(edited.source).toEqual(source)
    expect(listResourceTemplates(env)[0].source).toEqual(source)
  })
  it.each([
    {...input, id: '../outside'}, {...input, mode: 'unknown'}, {...input, name: ' '}, {...input, prompt: ''},
    {...input, prompt: 'x'.repeat(12001)}, {...input, tags: ['x'.repeat(41)]},
    {...input, source: {kind: 'etubao', sourceId: 'a', caseId: '1', sourceUrl: 'javascript:alert(1)'}},
    {...input, source: {kind: 'etubao', sourceId: 'a', caseId: '1', sourceUrl: 'https://name:secret@example.com/'}},
  ])('rejects invalid fields before creating a store', value => {
    expect(() => saveResourceTemplate(value, env)).toThrow()
    expect(existsSync(file())).toBe(false)
  })
  it('does not overwrite corrupt on-disk data or tampered template fields', () => {
    saveResourceTemplate(input, env)
    writeFileSync(file(), '{broken', 'utf8')
    expect(() => listResourceTemplates(env)).toThrow('无法读取')
    expect(() => saveResourceTemplate(input, env)).toThrow('无法读取')
    expect(readFileSync(file(), 'utf8')).toBe('{broken')
  })
  it('does not recreate a deleted template under a caller supplied id', () => {
    const first = saveResourceTemplate(input, env)
    removeResourceTemplate(first.id, env)
    expect(() => saveResourceTemplate({...first, prompt: 'new'}, env)).toThrow('不存在')
    expect(listResourceTemplates(env)).toEqual([])
  })
})
