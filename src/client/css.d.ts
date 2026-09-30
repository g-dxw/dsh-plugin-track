/**
 * Plain stylesheet imports.
 *
 * `tsdown.config.ts` resolves any `*.css` specifier to an absolute path and
 * loads it as a module whose default export is the file's text (the
 * `dsh-css-raw` plugin). TypeScript has to be told the same thing, or
 * `tsc --noEmit` fails on `import maplibreCss from 'maplibre-gl/dist/..css'`.
 *
 * This shim only ever matches a bare `.css` import. A `.module.css` import is
 * the imagegen plugin's `dsh-css-modules-inline`, which this plugin does not
 * use and does not need covered.
 */
declare module '*.css' {
  const css: string
  export default css
}
