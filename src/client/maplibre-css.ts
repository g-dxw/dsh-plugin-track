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

// Form-button spacing must not squeeze MapLibre's 29px navigation icons.
export const MAP_STYLE: string = maplibre + `
.trk .maplibregl-ctrl-group,.trk .maplibregl-ctrl-attrib{background:var(--trk-overlay);color:var(--trk-overlay-text);border-radius:var(--trk-radius-sm);box-shadow:0 0 0 1px var(--trk-border)}
.trk .maplibregl-ctrl-group button{min-height:0;padding:0;border:0;border-radius:0;background:transparent;color:inherit}
.trk .maplibregl-ctrl-group button+button{border-top:1px solid var(--trk-border)}
.trk .maplibregl-ctrl-group button:hover:not(:disabled){background:var(--trk-hover)}
.trk .maplibregl-ctrl-attrib a{color:var(--trk-overlay-text)}
.trk .maplibregl-ctrl-attrib{font-size:calc(var(--trk-font-size)*.7857)}
.trk .maplibregl-ctrl-attrib-button{background-color:transparent}
body[data-ds-dark-theme] .trk .maplibregl-ctrl-icon,body[data-ds-dark-theme] .trk .maplibregl-ctrl-attrib-button{filter:invert(1)}
`
