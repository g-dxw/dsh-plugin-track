// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BasemapControls, MapCredits, MapSettingsProvider, testMapConnection, useMapSettings } from '../src/client/map-settings.tsx'
import { DEFAULT_MAP_SETTINGS, DEFAULT_SANDBOX_COLORS, LEGACY_BASEMAP_KEY, MAP_SETTINGS_KEY, SANDBOX_LABEL_SIZE_MIN, SANDBOX_LABEL_SIZE_MAX, SANDBOX_LABEL_HEIGHT_MIN, SANDBOX_LABEL_HEIGHT_MAX, PLACEMARK_POINT_SIZE_MIN, PLACEMARK_POINT_SIZE_MAX, PLACEMARK_POINT_RADIUS_MIN, PLACEMARK_POINT_RADIUS_MAX, readMapSettings, sanitizeSandboxLabelSize, sanitizeSandboxLabelHeight, sanitizePlacemarkPointSize, sanitizePlacemarkPointRadius, sanitizeLighting, sanitizeSandboxColors, sanitizeMapSettings, writeMapSettings } from '../src/track/map-settings.ts'
import { basemapCredits, OSM_STYLE, styleFor, terrainProviderFor, VECTOR_STYLE } from '../src/track/basemaps.ts'

const defaultPointSettings = {
  terrainPlacemarkMode: 'point', sandboxPlacemarkMode: 'marker', placemarkPointSize: 24,
  placemarkPointColor: '#c83532', placemarkGroupColor: '#2563eb', placemarkPointRadius: 50,
  placemarkPointShowCount: true, placemarkPointShowName: false,
} as const

afterEach(() => {vi.restoreAllMocks(); localStorage.clear()})

describe('versioned map settings and provider definitions', () => {
  beforeEach(() => localStorage.clear())
  it('migrates a legacy basemap without losing it and writes both keys', () => {
    localStorage.setItem(LEGACY_BASEMAP_KEY, 'satellite')
    const migrated = readMapSettings()
    expect(migrated.basemap).toBe('satellite'); expect(migrated.lighting).toEqual(DEFAULT_MAP_SETTINGS.lighting)
    const saved = writeMapSettings({...migrated, quality: 'fine', exaggeration: 2})
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(saved)
    expect(localStorage.getItem(LEGACY_BASEMAP_KEY)).toBe('satellite')
  })
  it('ignores malformed and future versions while keeping a valid legacy preference', () => {
    localStorage.setItem(LEGACY_BASEMAP_KEY, 'terrain')
    for (const value of ['{', JSON.stringify({version: 2, basemap: 'osm'})]) {
      localStorage.setItem(MAP_SETTINGS_KEY, value)
      expect(readMapSettings().basemap).toBe('terrain')
    }
  })
  it('clamps finite controls and rejects invalid values and keyless paid services', () => {
    const settings = sanitizeMapSettings({basemap: 'maptiler-outdoor', terrainProvider: 'maptiler', exaggeration: Infinity, quality: 'unknown', buildings: 'yes', lighting: {azimuth: -20, elevation: 100, intensity: 100, ambient: NaN, shadows: false}})
    expect(settings.basemap).toBe('vector'); expect(settings.terrainProvider).toBe('mapterhorn')
    expect(settings.exaggeration).toBe(1.25); expect(settings.quality).toBe('standard'); expect(settings.buildings).toBe(false)
    expect(settings.lighting).toEqual({azimuth: 0, elevation: 85, intensity: 5, ambient: 0.65, shadows: false})
    expect(sanitizeLighting(null)).toEqual({azimuth: 118, elevation: 85, intensity: 4.1, ambient: 0.65, shadows: true})
  })
  it('fills independent native-point and sandbox-marker defaults in old settings without replacing existing styling', () => {
    expect(DEFAULT_MAP_SETTINGS).toMatchObject(defaultPointSettings)
    const old = {version: 1, basemap: 'terrain', routeColor: '#224466', sandboxLabelColor: '#abcdef', sandboxConnectorColor: '#654321', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, sandboxPlacemarks: false, sandboxMarkerPaletteVersion: 3}
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(old))
    expect(readMapSettings()).toMatchObject({...old, ...defaultPointSettings})
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(old)
  })
  it('accepts the two display modes independently and persists shared point styles without touching marker styling', () => {
    const original = sanitizeMapSettings({basemap: 'terrain', routeColor: '#224466', sandboxLabelColor: '#abcdef', sandboxConnectorColor: '#654321', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, sandboxPlacemarks: false})
    for (const field of ['terrainPlacemarkMode', 'sandboxPlacemarkMode'] as const) {
      for (const mode of ['point', 'marker'] as const) expect(sanitizeMapSettings({...original, [field]: mode})).toEqual({...original, [field]: mode})
    }
    const saved = writeMapSettings({...original, terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#abcdef', placemarkPointRadius: 12})
    expect(saved).toEqual({...original, terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#abcdef', placemarkPointRadius: 12})
    expect(readMapSettings()).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(saved)
    const changed = writeMapSettings({...saved, terrainPlacemarkMode: 'point'})
    expect(readMapSettings()).toEqual({...saved, terrainPlacemarkMode: 'point'})
    expect(changed.sandboxPlacemarkMode).toBe('point')
    expect(changed.sandboxMarkerPaletteVersion).toBe(3)
  })
  it('recovers malformed display modes per view without changing unrelated preferences', () => {
    const original = sanitizeMapSettings({terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointRadius: 12, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#abcdef', sandboxLabelHeight: 1.8})
    for (const mode of [undefined, null, '', 'Point', ' marker ', 'number', true, 0, {}, []]) {
      expect(sanitizeMapSettings({...original, terrainPlacemarkMode: mode})).toEqual({...original, terrainPlacemarkMode: 'point'})
      expect(sanitizeMapSettings({...original, sandboxPlacemarkMode: mode})).toEqual({...original, sandboxPlacemarkMode: 'marker'})
    }
  })
  it('accepts strict point count and name flags and persists each preference independently of style and modes', () => {
    const original = sanitizeMapSettings({terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointRadius: 12, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#abcdef', sandboxLabelColor: '#123456', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, placemarkPointShowCount: false, placemarkPointShowName: true})
    for (const field of ['placemarkPointShowCount', 'placemarkPointShowName'] as const) {
      for (const value of [false, true]) expect(sanitizeMapSettings({...original, [field]: value})).toEqual({...original, [field]: value})
    }
    const countOnly = writeMapSettings({...original, placemarkPointShowCount: true})
    expect(readMapSettings()).toEqual({...original, placemarkPointShowCount: true})
    const nameOnly = writeMapSettings({...countOnly, placemarkPointShowName: false})
    expect(readMapSettings()).toEqual({...original, placemarkPointShowCount: true, placemarkPointShowName: false})
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(nameOnly)
    expect(nameOnly.sandboxMarkerPaletteVersion).toBe(3)
  })
  it('restores legacy count and name defaults for malformed flags without coercion or loss of styling', () => {
    const original = sanitizeMapSettings({terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointRadius: 12, sandboxLabelColor: '#123456', sandboxLabelSize: 22, sandboxLabelHeight: 1.8, placemarkPointShowCount: false, placemarkPointShowName: true})
    for (const value of [undefined, null, 'false', 'true', 0, 1, {}, [], NaN, Infinity]) {
      expect(sanitizeMapSettings({...original, placemarkPointShowCount: value})).toEqual({...original, placemarkPointShowCount: true})
      expect(sanitizeMapSettings({...original, placemarkPointShowName: value})).toEqual({...original, placemarkPointShowName: false})
      localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify({...original, placemarkPointShowCount: value, placemarkPointShowName: value}))
      expect(readMapSettings()).toEqual({...original, placemarkPointShowCount: true, placemarkPointShowName: false})
    }
    expect(original).toMatchObject({placemarkPointShowCount: false, placemarkPointShowName: true})
  })
  it('clamps and rounds shared point sizes and preserves zero-radius square tiles', () => {
    expect(PLACEMARK_POINT_SIZE_MIN).toBe(12); expect(PLACEMARK_POINT_SIZE_MAX).toBe(64)
    expect(PLACEMARK_POINT_RADIUS_MIN).toBe(0); expect(PLACEMARK_POINT_RADIUS_MAX).toBe(50)
    for (const [value, expected] of [[-10, 12], [11.9, 12], [12, 12], [24.4, 24], [24.5, 25], [63.6, 64], [64, 64], [100, 64]]) {
      expect(sanitizePlacemarkPointSize(value)).toBe(expected)
      expect(sanitizeMapSettings({placemarkPointSize: value}).placemarkPointSize).toBe(expected)
    }
    for (const [value, expected] of [[-10, 0], [0, 0], [.4, 0], [.5, 1], [24.4, 24], [24.5, 25], [49.6, 50], [50, 50], [100, 50]]) {
      expect(sanitizePlacemarkPointRadius(value)).toBe(expected)
      expect(sanitizeMapSettings({placemarkPointRadius: value}).placemarkPointRadius).toBe(expected)
    }
  })
  it('uses point size and radius defaults for malformed values without replacing other preferences', () => {
    const original = sanitizeMapSettings({terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointRadius: 12, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#abcdef', sandboxLabelHeight: 1.8})
    for (const value of [undefined, null, '24', true, {}, [], NaN, Infinity, -Infinity]) {
      expect(sanitizePlacemarkPointSize(value)).toBe(24)
      expect(sanitizePlacemarkPointRadius(value)).toBe(50)
      expect(sanitizeMapSettings({...original, placemarkPointSize: value})).toEqual({...original, placemarkPointSize: 24})
      expect(sanitizeMapSettings({...original, placemarkPointRadius: value})).toEqual({...original, placemarkPointRadius: 50})
    }
  })
  it('normalizes point and group colors independently while preserving all other preferences', () => {
    const original = sanitizeMapSettings({routeColor: '#224466', sandboxLabelHeight: 1.8, placemarkPointSize: 41, placemarkPointRadius: 12})
    const colors = sanitizeMapSettings({...original, placemarkPointColor: ' #AaBbCc ', placemarkGroupColor: ' #DdEeFf '})
    expect(colors).toEqual({...original, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#ddeeff'})
    for (const value of [undefined, null, 123456, '#fff', '#12345678', 'red', 'rgb(1,2,3)', 'var(--map-bg)']) {
      expect(sanitizeMapSettings({...colors, placemarkPointColor: value})).toEqual({...colors, placemarkPointColor: '#c83532'})
      expect(sanitizeMapSettings({...colors, placemarkGroupColor: value})).toEqual({...colors, placemarkGroupColor: '#2563eb'})
    }
    expect(readMapSettings()).toEqual(DEFAULT_MAP_SETTINGS)
  })
  it('persists sandbox text size without changing other preferences', () => {
    const original = sanitizeMapSettings({basemap: 'terrain', routeColor: '#abcdef', sandboxLabelColor: '#224466', sandboxConnectorColor: '#654321', sandboxPlacemarks: false})
    const saved = writeMapSettings({...original, sandboxLabelSize: 24})
    expect(saved).toEqual({...original, sandboxLabelSize: 24})
    expect(readMapSettings()).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(saved)
    expect(DEFAULT_MAP_SETTINGS.sandboxLabelSize).toBe(16)
  })
  it('clamps and rounds finite sandbox text sizes through the shared scene and settings sanitizer', () => {
    expect(SANDBOX_LABEL_SIZE_MIN).toBe(10); expect(SANDBOX_LABEL_SIZE_MAX).toBe(32)
    for (const [value, expected] of [[-10, 10], [9.9, 10], [10, 10], [15.4, 15], [15.5, 16], [24.7, 25], [31.6, 32], [32, 32], [100, 32]]) {
      expect(sanitizeSandboxLabelSize(value)).toBe(expected)
      expect(sanitizeMapSettings({sandboxLabelSize: value}).sandboxLabelSize).toBe(expected)
    }
  })
  it('uses the default text size for missing or malformed values while preserving unrelated preferences', () => {
    const original = sanitizeMapSettings({routeColor: '#abcdef', sandboxLabelColor: '#224466', sandboxConnectorColor: '#654321', sandboxLabelSize: 24})
    for (const sandboxLabelSize of [undefined, null, '24', true, {}, [], NaN, Infinity, -Infinity]) {
      expect(sanitizeSandboxLabelSize(sandboxLabelSize)).toBe(16)
      expect(sanitizeMapSettings({...original, sandboxLabelSize})).toEqual({...original, sandboxLabelSize: 16})
    }
  })
  it('persists the relative sandbox text height without changing other preferences', () => {
    const original = sanitizeMapSettings({basemap: 'terrain', routeColor: '#abcdef', sandboxLabelColor: '#224466', sandboxConnectorColor: '#654321', sandboxLabelSize: 24, sandboxPlacemarks: false})
    const saved = writeMapSettings({...original, sandboxLabelHeight: 1.7})
    expect(saved).toEqual({...original, sandboxLabelHeight: 1.7})
    expect(readMapSettings()).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(saved)
    expect(DEFAULT_MAP_SETTINGS.sandboxLabelHeight).toBe(1)
  })
  it('clamps relative sandbox text height and rounds to one decimal through the shared sanitizer', () => {
    expect(SANDBOX_LABEL_HEIGHT_MIN).toBe(.2); expect(SANDBOX_LABEL_HEIGHT_MAX).toBe(3)
    for (const [value, expected] of [[-10, .2], [.19, .2], [.2, .2], [.25, .3], [1.24, 1.2], [1.25, 1.3], [1.7, 1.7], [2.96, 3], [3, 3], [100, 3]]) {
      expect(sanitizeSandboxLabelHeight(value)).toBe(expected)
      expect(sanitizeMapSettings({sandboxLabelHeight: value}).sandboxLabelHeight).toBe(expected)
    }
  })
  it('restores the default height for missing or malformed values independently of other preferences', () => {
    const original = sanitizeMapSettings({routeColor: '#abcdef', sandboxLabelColor: '#224466', sandboxConnectorColor: '#654321', sandboxLabelSize: 24, sandboxLabelHeight: 1.7})
    for (const sandboxLabelHeight of [undefined, null, '1.7', true, {}, [], NaN, Infinity, -Infinity]) {
      expect(sanitizeSandboxLabelHeight(sandboxLabelHeight)).toBe(1)
      expect(sanitizeMapSettings({...original, sandboxLabelHeight})).toEqual({...original, sandboxLabelHeight: 1})
    }
  })
  it('normalizes persisted six-digit colors and recovers malformed fields independently', () => {
    const colors = {sides: '#abcdef', background: '#012aef'}
    const saved = writeMapSettings(sanitizeMapSettings({
      sandboxColors: {sides: ' #AbCdEf ', background: ' #012AEF '}, routeColor: ' #Aa11Bb ',
      sandboxLabelColor: ' #CcDdEe ', sandboxConnectorColor: ' #Ff9900 ',
    }))
    expect(saved.routeColor).toBe('#aa11bb')
    expect(readMapSettings().routeColor).toBe('#aa11bb')
    expect(saved.sandboxLabelColor).toBe('#ccddee')
    expect(saved.sandboxConnectorColor).toBe('#ff9900')
    expect(readMapSettings()).toEqual(saved)
    expect(saved.sandboxColors).toEqual(colors)
    expect(readMapSettings().sandboxColors).toEqual(colors)
    for (const invalid of [null, 123456, '#fff', '#12345678', 'red', 'rgb(1, 2, 3)', 'var(--map-bg)']) {
      expect(sanitizeMapSettings({...saved, routeColor: invalid})).toEqual({...saved, routeColor: DEFAULT_MAP_SETTINGS.routeColor})
      expect(sanitizeMapSettings({...saved, sandboxLabelColor: invalid})).toEqual({...saved, sandboxLabelColor: DEFAULT_MAP_SETTINGS.sandboxLabelColor})
      expect(sanitizeMapSettings({...saved, sandboxConnectorColor: invalid})).toEqual({...saved, sandboxConnectorColor: DEFAULT_MAP_SETTINGS.sandboxConnectorColor})
      expect(sanitizeSandboxColors({sides: invalid, background: colors.background})).toEqual({
        sides: DEFAULT_SANDBOX_COLORS.sides, background: colors.background,
      })
      expect(sanitizeSandboxColors({sides: colors.sides, background: invalid})).toEqual({
        sides: colors.sides, background: DEFAULT_SANDBOX_COLORS.background,
      })
    }
    expect(DEFAULT_SANDBOX_COLORS).toEqual({sides: '#707070', background: '#bacaaa'})
    expect(DEFAULT_MAP_SETTINGS.routeColor).toBe('#1bb1a7')
    expect(DEFAULT_MAP_SETTINGS.sandboxLabelColor).toBe('#ffffff')
    expect(DEFAULT_MAP_SETTINGS.sandboxConnectorColor).toBe('#ffffff')
    expect(DEFAULT_MAP_SETTINGS.sandboxMarkerPaletteVersion).toBe(3)
  })
  it('fills sandbox appearance defaults in old version-one preferences without losing view or service settings', () => {
    const old = {
      version: 1, basemap: 'maptiler-outdoor', maptilerKey: 'legacy-key', terrainProvider: 'maptiler',
      exaggeration: 2.4, quality: 'fine', buildings: true,
      lighting: {azimuth: 126, elevation: 54, intensity: 3.5, ambient: 1.2, shadows: false},
    }
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(old))
    const restored = readMapSettings()
    expect(restored).toEqual({...old, ...defaultPointSettings, tiandituKey: '', routeColor: DEFAULT_MAP_SETTINGS.routeColor, sandboxLabelColor: DEFAULT_MAP_SETTINGS.sandboxLabelColor, sandboxLabelSize: DEFAULT_MAP_SETTINGS.sandboxLabelSize, sandboxLabelHeight: DEFAULT_MAP_SETTINGS.sandboxLabelHeight, sandboxConnectorColor: DEFAULT_MAP_SETTINGS.sandboxConnectorColor, sandboxMarkerPaletteVersion: 3, sandboxColors: DEFAULT_SANDBOX_COLORS, sandboxBackground: 'solid', sandboxPlacemarks: true})
    writeMapSettings({...restored, quality: 'eco'})
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual({
      ...old, ...defaultPointSettings, quality: 'eco', tiandituKey: '', routeColor: DEFAULT_MAP_SETTINGS.routeColor, sandboxLabelColor: DEFAULT_MAP_SETTINGS.sandboxLabelColor, sandboxLabelSize: DEFAULT_MAP_SETTINGS.sandboxLabelSize, sandboxLabelHeight: DEFAULT_MAP_SETTINGS.sandboxLabelHeight, sandboxConnectorColor: DEFAULT_MAP_SETTINGS.sandboxConnectorColor, sandboxMarkerPaletteVersion: 3, sandboxColors: DEFAULT_SANDBOX_COLORS, sandboxBackground: 'solid', sandboxPlacemarks: true,
    })
  })
  it('fills missing sandbox marker colors independently of a custom route color in old version-one settings', () => {
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify({version: 1, basemap: 'terrain', routeColor: '#aabbcc'}))
    const restored = readMapSettings()
    expect(restored).toMatchObject({version: 1, basemap: 'terrain', routeColor: '#aabbcc', sandboxLabelColor: '#ffffff', sandboxLabelSize: 16, sandboxLabelHeight: 1, sandboxConnectorColor: '#ffffff', sandboxMarkerPaletteVersion: 3})
    const saved = writeMapSettings({...restored, sandboxLabelColor: '#123456'})
    expect(readMapSettings()).toEqual(saved)
    expect(saved.routeColor).toBe('#aabbcc')
    expect(saved.sandboxConnectorColor).toBe('#ffffff')
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!).version).toBe(1)
  })
  it.each([
    {routeColor: ' #3DC5FF ', sandboxConnectorColor: ' #3dC5fF '},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#ffb347'},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#ffb347', sandboxMarkerPaletteVersion: 2},
  ])('migrates the persisted previous default palette once to teal and white: %j', colors => {
    const old = {version: 1, basemap: 'terrain', ...colors, sandboxLabelColor: '#abcdef', quality: 'fine', sandboxPlacemarks: false, sandboxLabelSize: 24, sandboxLabelHeight: 1.7, terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#123456', placemarkPointRadius: 12, placemarkPointShowCount: false, placemarkPointShowName: true}
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(old))
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const restored = readMapSettings()
    expect(restored).toMatchObject({routeColor: '#1bb1a7', sandboxConnectorColor: '#ffffff', sandboxMarkerPaletteVersion: 3, sandboxLabelColor: '#abcdef', quality: 'fine', sandboxPlacemarks: false, sandboxLabelSize: 24, sandboxLabelHeight: 1.7, terrainPlacemarkMode: 'marker', sandboxPlacemarkMode: 'point', placemarkPointSize: 41, placemarkPointColor: '#aabbcc', placemarkGroupColor: '#123456', placemarkPointRadius: 12, placemarkPointShowCount: false, placemarkPointShowName: true})
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(restored)
    expect(setItem).toHaveBeenCalledOnce()
    expect(setItem).toHaveBeenCalledWith(MAP_SETTINGS_KEY, JSON.stringify(restored))
    expect(readMapSettings()).toEqual(restored)
    expect(setItem).toHaveBeenCalledOnce()
    const laterChoice = writeMapSettings({...restored, routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff'})
    expect(laterChoice.sandboxMarkerPaletteVersion).toBe(3)
    expect(readMapSettings()).toEqual(laterChoice)
    expect(readMapSettings()).toMatchObject({routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff'})
  })
  it.each([
    {routeColor: '#224466', sandboxConnectorColor: '#3dc5ff'},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#654321'},
    {routeColor: '#224466', sandboxConnectorColor: '#654321'},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff', sandboxMarkerPaletteVersion: 2},
    {routeColor: '#224466', sandboxConnectorColor: '#ffb347', sandboxMarkerPaletteVersion: 2},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff', sandboxMarkerPaletteVersion: 3},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#ffb347', sandboxMarkerPaletteVersion: 3},
  ])('preserves custom and explicitly chosen matching colors in persisted preferences: %j', colors => {
    const old = {version: 1, basemap: 'terrain', ...colors}
    localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(old))
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    expect(readMapSettings()).toMatchObject({...colors, sandboxMarkerPaletteVersion: 3})
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(old)
    expect(setItem).not.toHaveBeenCalled()
  })
  it.each([
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff'},
    {routeColor: '#3dc5ff', sandboxConnectorColor: '#ffb347'},
  ])('never migrates previous default color pairs through sanitizing or new writes: %j', colors => {
    const old = {version: 1, ...colors, sandboxMarkerPaletteVersion: 2}
    const sanitized = sanitizeMapSettings(old)
    expect(sanitized).toMatchObject({...colors, sandboxMarkerPaletteVersion: 3})
    expect(old).toEqual({version: 1, ...colors, sandboxMarkerPaletteVersion: 2})
    const saved = writeMapSettings(sanitized)
    expect(readMapSettings()).toEqual(saved)
    expect(readMapSettings()).toMatchObject(colors)
    expect(JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)!)).toEqual(saved)
  })
  it('uses the migrated in-memory palette when legacy preference storage refuses the write', () => {
    const old = {version: 1, basemap: 'terrain', routeColor: '#3dc5ff', sandboxConnectorColor: '#3dc5ff', sandboxLabelColor: '#abcdef'}
    const storage = {getItem: () => JSON.stringify(old), setItem: vi.fn(() => {throw new Error('denied')})}
    expect(readMapSettings(storage)).toMatchObject({basemap: 'terrain', routeColor: '#1bb1a7', sandboxConnectorColor: '#ffffff', sandboxLabelColor: '#abcdef', sandboxMarkerPaletteVersion: 3, sandboxLabelHeight: 1})
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(old.routeColor).toBe('#3dc5ff'); expect(old.sandboxConnectorColor).toBe('#3dc5ff')
  })
  it('persists a supported background mode and recovers invalid stored modes without losing colors', () => {
    const sandboxColors = {sides: '#2468ac', background: '#102030'}
    const saved = writeMapSettings(sanitizeMapSettings({sandboxBackground: 'environment', sandboxColors}))
    expect(readMapSettings()).toEqual(saved)
    expect(saved.sandboxBackground).toBe('environment')
    for (const sandboxBackground of ['unknown', 'Environment', ' environment ', null, true]) {
      localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify({...saved, sandboxBackground}))
      expect(readMapSettings()).toEqual({...saved, sandboxBackground: 'solid'})
    }
    expect(readMapSettings().sandboxColors).toEqual(sandboxColors)
  })
  it('retains explicit hidden map markers and restores shared visibility for invalid stored values', () => {
    const saved = writeMapSettings(sanitizeMapSettings({
      sandboxPlacemarks: false, sandboxBackground: 'environment',
      sandboxColors: {sides: '#2468ac', background: '#102030'},
    }))
    expect(saved.sandboxPlacemarks).toBe(false)
    expect(readMapSettings()).toEqual(saved)
    for (const sandboxPlacemarks of ['false', 0, null, {}]) {
      localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify({...saved, sandboxPlacemarks}))
      expect(readMapSettings()).toEqual({...saved, sandboxPlacemarks: true})
    }
  })
  it('keeps keys encoded in provider URLs and returns the right DEM encoding and zoom', () => {
    const settings = sanitizeMapSettings({maptilerKey: ' a&b?c ', basemap: 'maptiler-streets', terrainProvider: 'maptiler'})
    expect(styleFor('maptiler-streets', settings)).toBe('https://api.maptiler.com/maps/streets-v4/style.json?key=a%26b%3Fc')
    expect(terrainProviderFor(settings)).toMatchObject({id: 'maptiler', encoding: 'mapbox', tileSize: 512, maxzoom: 14})
    expect(terrainProviderFor(settings).url).toContain('terrain-rgb-v2/tiles.json?key=a%26b%3Fc')
    expect(terrainProviderFor()).toMatchObject({id: 'mapterhorn', encoding: 'terrarium', tileSize: 512, maxzoom: 12})
    expect(styleFor('maptiler-outdoor')).toBe(VECTOR_STYLE); expect(styleFor('osm')).toBe(OSM_STYLE)
    expect(basemapCredits('osm').map(credit => credit.label)).toEqual(['© OpenStreetMap contributors'])
  })
  it('survives refused storage without mutating defaults', () => {
    const storage = {getItem: () => {throw new Error('denied')}, setItem: () => {throw new Error('denied')}}
    expect(readMapSettings(storage)).toEqual(DEFAULT_MAP_SETTINGS)
    expect(writeMapSettings(sanitizeMapSettings({quality: 'eco'}), storage).quality).toBe('eco')
    expect(DEFAULT_MAP_SETTINGS.quality).toBe('standard')
  })
})

let node: HTMLDivElement, root: Root
let state: ReturnType<typeof useMapSettings>
function SettingsConsumer() {
  state = useMapSettings()
  const [count, setCount] = useState(0)
  return createElement('div', {},
    createElement('button', {onClick: state.openSettings}, '地图设置'),
    createElement('button', {onClick: () => setCount(count + 1)}, `编辑草稿 ${count}`),
    createElement('output', {}, `${state.settings.basemap}/${state.settings.quality}`))
}
function button(text: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
async function click(element: HTMLElement) {await act(async () => element.click())}
async function select(element: HTMLSelectElement, value: string) {await act(async () => {element.value = value; element.dispatchEvent(new Event('change', {bubbles: true}))})}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', {bubbles: true}))})
}
function field(label: string) {return [...node.querySelectorAll('label')].find(value => value.textContent?.startsWith(label))!}
async function render() {await act(async () => root.render(createElement(MapSettingsProvider, {}, createElement(SettingsConsumer))))}

describe('settings dialog and standalone map preferences', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear()
    node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node)
  })
  afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals()})
  it('keeps drafts unapplied on cancel, traps focus, handles Escape and restores focus', async () => {
    await render(); const opener = button('地图设置'); opener.focus(); await click(opener)
    const dialog = node.querySelector<HTMLElement>('[role=dialog]')!
    const first = field('地图源').querySelector('select')!
    expect(document.activeElement).toBe(first)
    await select(first, 'osm')
    expect(state.settings.basemap).toBe('vector')
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true, bubbles: true, cancelable: true})))
    expect(document.activeElement).toBe(button('保存应用'))
    await act(async () => button('保存应用').dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true})))
    expect(document.activeElement).toBe(first)
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    expect(node.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(opener)
    expect(localStorage.getItem(MAP_SETTINGS_KEY)).toBeNull()
  })
  it('saves only global map services while preserving view preferences and the editor draft', async () => {
    const original = writeMapSettings(sanitizeMapSettings({
      exaggeration: 2.4, quality: 'fine', buildings: true,
      lighting: {azimuth: 126, elevation: 54, intensity: 3.5, ambient: 1.2, shadows: false},
      sandboxColors: {sides: '#2468ac', background: '#102030'},
      sandboxBackground: 'environment' as const,
      sandboxPlacemarks: false,
    }))
    await render(); await click(button('编辑草稿 0')); await click(button('地图设置'))
    const dialog = node.querySelector<HTMLElement>('[role=dialog]')!
    expect(dialog.querySelectorAll('select')).toHaveLength(2)
    expect(dialog.querySelectorAll('input')).toHaveLength(2)
    expect(dialog.querySelector('input[type=range],input[type=checkbox]')).toBeNull()
    expect(field('沙盘质量')).toBeUndefined()
    expect(field('地形倍率')).toBeUndefined()
    await input(field('MapTiler Key').querySelector('input')!, 'secret-key')
    expect(field('MapTiler Key').querySelector('input')!.type).toBe('password')
    const tianditu = dialog.querySelector<HTMLInputElement>('input[aria-describedby$="-tianditu-hint"]')!
    await input(tianditu, ' tianditu-test-key ')
    expect(tianditu.type).toBe('password')
    await select(field('地图源').querySelector('select')!, 'maptiler-outdoor')
    await select(field('高程来源').querySelector('select')!, 'maptiler')
    expect(state.settings).toEqual(original)
    await click(button('保存应用'))
    expect(state.settings).toEqual({...original, basemap: 'maptiler-outdoor', terrainProvider: 'maptiler', maptilerKey: 'secret-key', tiandituKey: 'tianditu-test-key'})
    expect(button('编辑草稿 1')).toBeTruthy(); expect(readMapSettings()).toEqual(state.settings)
  })
  it('does not roll back view preferences changed while the global settings dialog is open', async () => {
    await render(); await click(button('地图设置'))
    await select(field('地图源').querySelector('select')!, 'osm')
    const latest = {
      routeColor: '#aabbcc', sandboxLabelColor: '#123456', sandboxLabelSize: 24, sandboxConnectorColor: '#654321',
      exaggeration: 2.7, quality: 'eco' as const, buildings: true,
      lighting: {azimuth: 221, elevation: 68, intensity: 4.2, ambient: 0.9, shadows: false},
      sandboxColors: {sides: '#2468ac', background: '#102030'},
      sandboxBackground: 'environment' as const,
      sandboxPlacemarks: false,
    }
    await act(async () => state.updateSettings(latest))
    await click(button('保存应用'))
    expect(state.settings).toEqual({...DEFAULT_MAP_SETTINGS, ...latest, basemap: 'osm'})
    expect(readMapSettings()).toEqual(state.settings)
  })
  it('blocks keyless MapTiler save and restores only global defaults upon applying', async () => {
    const original = writeMapSettings(sanitizeMapSettings({
      basemap: 'maptiler-outdoor', maptilerKey: 'saved-key', terrainProvider: 'maptiler',
      exaggeration: 2.2, quality: 'fine', buildings: true,
      lighting: {azimuth: 82, elevation: 61, intensity: 3.8, ambient: 1.1, shadows: false},
      sandboxColors: {sides: '#2468ac', background: '#102030'},
      sandboxBackground: 'environment' as const,
      sandboxPlacemarks: false,
    }))
    await render(); await click(button('地图设置'))
    await input(field('MapTiler Key').querySelector('input')!, '')
    await select(field('地图源').querySelector('select')!, 'maptiler-streets')
    expect(button('保存应用').disabled).toBe(true); expect(node.querySelector('[role=alert]')?.textContent).toContain('MapTiler Key')
    await click(button('恢复默认'))
    expect(state.settings).toEqual(original); expect(readMapSettings()).toEqual(original)
    await click(button('保存应用'))
    expect(state.settings).toEqual({
      ...original, basemap: DEFAULT_MAP_SETTINGS.basemap,
      maptilerKey: DEFAULT_MAP_SETTINGS.maptilerKey, terrainProvider: DEFAULT_MAP_SETTINGS.terrainProvider,
    })
    expect(readMapSettings()).toEqual(state.settings)
  })
  it('shares standalone layer preferences and retry without exposing global settings', async () => {
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(BasemapControls, {basemap: 'vector', onBasemap})))
    await click(button('矢量')); await click(button('矢量'))
    expect(onBasemap).toHaveBeenCalledTimes(2)
    expect(node.querySelector<HTMLOptionElement>('option[value="maptiler-streets"]')!.disabled).toBe(true)
    expect([...node.querySelectorAll('button')].some(element => ['设置', '地图设置'].includes(element.getAttribute('aria-label') ?? element.textContent ?? ''))).toBe(false)
    await act(async () => window.dispatchEvent(new CustomEvent('cqai-track:map-settings-open', {detail: {handled: false}})))
    expect(node.querySelector('[role=dialog]')).toBeNull()
    await select(node.querySelector<HTMLSelectElement>('select[aria-label="其他地图源"]')!, 'osm')
    expect(onBasemap).toHaveBeenLastCalledWith('osm'); expect(readMapSettings().basemap).toBe('osm')
  })
  it('keeps compact map options selected and preserves retry with keyless providers disabled', async () => {
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(BasemapControls, {basemap: 'terrain', onBasemap})))
    const compact = node.querySelector<HTMLSelectElement>('select[aria-label="地图源"]')!
    expect(compact.value).toBe('terrain'); expect(compact.style.minHeight).toBe('var(--trk-input-height,30px)')
    expect([...compact.options].map(option => option.value)).toEqual(['vector', 'terrain', 'satellite', 'none', 'osm', 'maptiler-streets', 'maptiler-outdoor', 'maptiler-satellite', 'retry-current'])
    expect([...compact.options].filter(option => option.value.startsWith('maptiler-')).every(option => option.disabled)).toBe(true)
    await select(compact, 'retry-current'); expect(onBasemap).toHaveBeenLastCalledWith('terrain')
    await select(compact, 'osm'); expect(onBasemap).toHaveBeenLastCalledWith('osm'); expect(readMapSettings().basemap).toBe('osm')
  })
  it('enables paid compact options with a key and disables all controls during capture', async () => {
    writeMapSettings(sanitizeMapSettings({maptilerKey: 'test-key', basemap: 'maptiler-outdoor'}))
    const onBasemap = vi.fn()
    await act(async () => root.render(createElement(BasemapControls, {basemap: 'maptiler-outdoor', onBasemap})))
    const compact = node.querySelector<HTMLSelectElement>('select[aria-label="地图源"]')!
    expect(compact.value).toBe('maptiler-outdoor')
    expect([...compact.options].filter(option => option.value.startsWith('maptiler-')).every(option => !option.disabled)).toBe(true)
    await act(async () => root.render(createElement(BasemapControls, {basemap: 'maptiler-outdoor', onBasemap, disabled: true})))
    expect(compact.disabled).toBe(true)
    expect(node.querySelector('button[aria-label="地图设置"]')).toBeNull()
    expect([...node.querySelectorAll('button')].every(element => element.disabled)).toBe(true)
  })
  it('merges consecutive updates from independent map hooks before React rerenders', async () => {
    const hooks: ReturnType<typeof useMapSettings>[] = []
    function Probe({index}: {index: number}) {hooks[index] = useMapSettings(); return null}
    await act(async () => root.render(createElement('div', {}, createElement(Probe, {index: 0}), createElement(Probe, {index: 1}))))
    await act(async () => {hooks[0].updateSettings({quality: 'fine'}); hooks[1].updateSettings({exaggeration: 2})})
    expect(hooks[0].settings).toMatchObject({quality: 'fine', exaggeration: 2})
    expect(hooks[1].settings).toEqual(hooks[0].settings)
    expect(readMapSettings()).toEqual(hooks[0].settings)
  })
  it('credits actual terrain without a texture and includes MapTiler logo', async () => {
    writeMapSettings(sanitizeMapSettings({maptilerKey: 'key', terrainProvider: 'maptiler'}))
    await act(async () => root.render(createElement(MapCredits, {basemap: 'satellite', terrain: true, texture: false})))
    expect(node.textContent).toContain('© MapTiler'); expect(node.textContent).not.toContain('Esri')
    expect(node.querySelector('img')?.getAttribute('src')).toBe('https://api.maptiler.com/resources/logo.svg')
  })
  it('credits the free style actually used for a keyless standalone MapTiler selection', async () => {
    await act(async () => root.render(createElement(MapCredits, {basemap: 'maptiler-streets'})))
    expect(node.textContent).toContain('OpenFreeMap'); expect(node.textContent).not.toContain('MapTiler')
    expect(node.querySelector('img')).toBeNull()
  })
  it('keeps captured MapTiler attribution and a readable proportional logo after shared settings change', async () => {
    const captured = sanitizeMapSettings({maptilerKey: 'captured-key', terrainProvider: 'maptiler', basemap: 'maptiler-streets'})
    writeMapSettings(sanitizeMapSettings(null))
    await act(async () => root.render(createElement(MapCredits, {basemap: 'maptiler-streets', terrain: true, settings: captured})))
    expect(node.textContent).toContain('© MapTiler'); expect(node.textContent).not.toContain('OpenFreeMap'); expect(node.textContent).not.toContain('Mapterhorn')
    const logo = node.querySelector('img')!
    expect(logo.getAttribute('width')).toBe('67'); expect(logo.getAttribute('height')).toBe('20')
    expect(logo.parentElement!.style.background).toBe('rgb(255, 255, 255)')
  })
  it('cancels every pending connection request when closed and retains the original settings', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      const signal = options.signal as AbortSignal; signals.push(signal)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true}))
    }))
    await render(); await click(button('地图设置')); await click(button('连接测试'))
    const dialog = node.querySelector<HTMLElement>('[role=dialog]')!
    expect(dialog.getAttribute('aria-busy')).toBe('true'); expect(document.activeElement).toBe(dialog)
    expect(button('取消').disabled).toBe(false); expect(button('保存应用').disabled).toBe(true)
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})))
    expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(node.querySelector('[role=dialog]')).toBeNull(); expect(state.settings).toEqual(DEFAULT_MAP_SETTINGS)
  })
  it('reports a key error without exposing URLs or credentials', async () => {
    writeMapSettings(sanitizeMapSettings({maptilerKey: 'private-value', basemap: 'maptiler-streets'}))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('https://api.maptiler.com/?key=private-value')))
    await render(); await click(button('地图设置')); await click(button('连接测试'))
    expect(node.querySelector('[role=alert]')?.textContent).toContain('Key 或域名限制')
    expect(node.textContent).not.toContain('private-value')
  })
})

describe('connection metadata validation', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('tests the selected MapTiler style and DEM with the cancellation signal', async () => {
    const fetcher = vi.fn().mockResolvedValue({ok: true, json: async () => ({tiles: ['https://tiles.test']})})
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    await testMapConnection(sanitizeMapSettings({maptilerKey: 'key', basemap: 'maptiler-outdoor', terrainProvider: 'maptiler'}), signal)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([, options]) => options.signal === signal && options.credentials === 'omit')).toBe(true)
  })
  it('rejects invalid metadata instead of claiming connectivity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, json: async () => ({error: 'unexpected'})}))
    await expect(testMapConnection(sanitizeMapSettings({maptilerKey: 'key', basemap: 'maptiler-streets', terrainProvider: 'maptiler'}), new AbortController().signal)).rejects.toThrow('返回的数据无效')
  })
})
