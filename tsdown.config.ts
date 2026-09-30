/**
 * Standalone tsdown build for cqai-dsh-plugin-track.
 *
 * Two halves, mirroring the dsh client-bundle contract:
 *
 *  - Node half   -> lib/index.js  (ESM; host-shared @deepseek-ai/* stay bare, so
 *                   the host runtime's own cordis Services are used rather than
 *                   a second copy bundled in here).
 *  - Client half -> lib/client.js (CJS browser bundle that registers itself via
 *                   `window.__ModuleLoader__.load({ id, factory })`, resolving
 *                   platform modules through the injected require).
 *
 * maplibre-gl and chart.js are *not* platform modules and cannot be resolved by
 * the injected require, so they must be inlined — hence `alwaysBundle`. Their
 * stylesheets are inlined as string constants by the `dsh-css-raw` plugin below
 * (resolved to an absolute path first, then read as text), which is the same
 * posture imagegen takes for its CSS.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { UserConfig } from 'tsdown'

/** Plugin id (package name) stamped into the __ModuleLoader__.load handoff. */
const ID = 'cqai-dsh-plugin-track'

/**
 * Modules that may be resolved by the DSH client loader. The emitted bundle
 * is checked after building so a transitive import cannot silently escape.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-renderer',
]

/** Third-party libraries and subpaths the client bundle carries itself. */
const CLIENT_INLINED: readonly string[] = [
  'maplibre-gl',
  'maplibre-gl/dist/maplibre-gl.css',
  'chart.js',
  'chart.js/helpers',
  'chartjs-plugin-zoom',
  'chartjs-plugin-crosshair',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css-raw:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const require = createRequire(import.meta.url)

const nodeConfig: UserConfig = {
  name: ID,
  entry: {index: 'src/index.ts'},
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: {entryFileNames: '[name].js'},
  deps: {neverBundle: [/^@deepseek-ai\//]},
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: {client: 'src/client/index.tsx'},
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: [...CLIENT_INLINED],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({MODE: process.env.NODE_ENV ?? 'production'}),
  },
  plugins: [{
    name: 'dsh-css-raw',
    /**
     * A stylesheet import becomes a module whose default export is the file's
     * text. The specifier is resolved to an absolute path here because a
     * virtual id would otherwise hide it from the bundler's own resolver.
     */
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      let file: string
      try {
        file = source.startsWith('.') && importer
          ? require.resolve(source, {paths: [importer]})
          : require.resolve(source)
      } catch {
        return null
      }
      return CSS_VIRTUAL_PREFIX + file + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const file = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(file)
      const css = await readFile(file, 'utf8')
      return `export default ${JSON.stringify(css)};`
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [nodeConfig, clientConfig]
