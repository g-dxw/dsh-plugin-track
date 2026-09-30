/**
 * GPX XML → plain-object reader.
 *
 * Upstream used `isomorphic-xml2js` (with `explicitArray: false` and a numeric
 * attribute processor) and handed the resulting tree straight to the model
 * classes. This is that reader, rewritten on top of the platform `DOMParser`
 * the renderer already ships: no runtime dependency, and the shape produced is
 * the same one the ported constructors expect.
 *
 * Three details of the xml2js contract matter and are reproduced here:
 *   - `explicitArray: false` — a tag that occurs once is a single value, a tag
 *     that occurs more than once becomes an array.
 *   - attributes live under `$`, and numeric-looking values are coerced to
 *     numbers (`lat` / `lon` / `ele` must not arrive as strings, or every
 *     haversine call silently yields NaN).
 *   - when a tag carries attributes *and* text, the text lands under `_`.
 */

/** Loosely-typed tree; the model constructors narrow it as they copy fields. */
export interface GpxObject {
  /** The `<gpx>` element's own attributes, as written rather than as declared. */
  $?: Record<string, unknown>
  metadata?: any
  wpt?: any
  rte?: any
  trk?: any
}

const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4
const ELEMENT_NODE = 1
/** Guard against a hostile file nesting us into a stack overflow. */
const MAX_DEPTH = 64

/** Numbers as numbers, everything else trimmed — the `attrValueProcessors` rule. */
function coerce(raw: string): string | number {
  const text = raw.trim()
  if (!text) return ''
  const value = Number(text)
  return isNaN(value) ? text : value
}

function readElement(element: Element, depth: number): any {
  if (depth > MAX_DEPTH) throw new Error('GPX 文件嵌套层级过深')

  const node: Record<string, any> = {}
  const attributes = element.attributes
  if (attributes.length) {
    const attrs: Record<string, string | number> = {}
    for (const attribute of Array.from(attributes)) attrs[attribute.name] = coerce(attribute.value)
    node.$ = attrs
  }

  let text = ''
  let hasChild = false
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
      text += child.nodeValue ?? ''
      continue
    }
    if (child.nodeType !== ELEMENT_NODE) continue
    hasChild = true
    const key = (child as Element).nodeName
    const value = readElement(child as Element, depth + 1)
    if (!(key in node)) node[key] = value
    else if (Array.isArray(node[key])) node[key].push(value)
    else node[key] = [node[key], value]
  }

  if (!hasChild) {
    const trimmed = text.trim()
    // A bare leaf is its own value; a leaf with attributes keeps the text under
    // `_`, exactly as xml2js does.
    if (!node.$) return trimmed ? coerce(trimmed) : undefined
    if (trimmed) node._ = coerce(trimmed)
  }

  return node
}

/**
 * Read a GPX document into the plain-object tree the model classes consume.
 * Throws a message the panel can show verbatim when the file is not GPX.
 */
export function parseGpxXml(source: string): GpxObject {
  // Firefox-era writers emitted `xmlns=""` inside the document body, which
  // breaks namespace resolution; comments carry no data and only get in the way.
  const cleaned = source.replace(/\sxmlns=""/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const document = new DOMParser().parseFromString(cleaned, 'application/xml')

  const problem = document.getElementsByTagName('parsererror')[0] ?? document.querySelector('parsererror')
  if (problem) throw new Error('不是合法的 GPX 文件：XML 语法错误')

  const root = document.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'gpx') throw new Error('不是合法的 GPX 文件：缺少 <gpx> 根元素')

  const tree = readElement(root, 0)
  return {$: tree.$, metadata: tree.metadata, wpt: tree.wpt, rte: tree.rte, trk: tree.trk}
}
