/**
 * MapLibre's stylesheet, as a string.
 *
 * The desktop shell gives a plugin bundle no way to ship a loose `.css` asset,
 * so the stylesheet is folded into the bundle instead: `tsdown.config.ts`'s
 * `dsh-css-raw` plugin resolves the import to an absolute path and returns the
 * file's text as this module's default export, and `MapView` mounts it in a
 * `<style>` element. That is the same posture the imagegen plugin takes for its
 * CSS Modules, minus the CSS Modules.
 */
import maplibre from 'maplibre-gl/dist/maplibre-gl.css'

export const MAP_STYLE: string = maplibre
