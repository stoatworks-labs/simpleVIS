/**
 * A tiny order-preserving XML tree, and a tolerant loader for the XML that
 * real MVR and GDTF files actually contain.
 *
 * Why this exists rather than calling a parser directly at each site:
 *
 *  1. **Real files are not well-formed.** Every file examined from MA
 *     Lighting's own library — `GeneralSceneDescription.xml` inside an `.mvr`
 *     and `description.xml` inside a `.gdtf` — ends with a trailing NUL byte
 *     after the closing tag, a C string terminator that leaked into the output.
 *     A strict parser rejects the whole document over one byte. `loadXml`
 *     strips it (and a BOM) rather than every caller learning this the hard way.
 *
 *  2. **Order matters in places.** A GDTF geometry tree interleaves
 *     `Geometry`, `Beam`, `Axis` and `GeometryReference` siblings, and their
 *     order is meaningful. A name-keyed object loses that, so the tree below
 *     keeps children in document order.
 *
 * Keeping the dependency behind this one file also means the parser can be
 * swapped without touching the MVR or GDTF modules.
 */

import { XMLParser } from 'fast-xml-parser';

/** One element. Text is the concatenated direct text content, trimmed. */
export interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

const ATTR_KEY = ':@';
const TEXT_KEY = '#text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  trimValues: true,
  // Everything in MVR/GDTF is either an enum, a name, a UUID or a
  // delimited numeric blob. Letting the parser guess types turns "0123" into
  // 123 and "1.5" into a float we then have to re-stringify, and it mangles
  // fixture names that happen to look numeric. Keep it all as text.
  parseAttributeValue: false,
  parseTagValue: false,
  alwaysCreateTextNode: false,
});

/** Raw shape fast-xml-parser emits in preserveOrder mode. */
type RawNode = Record<string, unknown> & { [ATTR_KEY]?: Record<string, string> };

function convert(raw: RawNode): XmlNode | null {
  let name: string | null = null;
  let kids: RawNode[] = [];

  for (const key of Object.keys(raw)) {
    if (key === ATTR_KEY) continue;
    name = key;
    const value = raw[key];
    kids = Array.isArray(value) ? (value as RawNode[]) : [];
    break;
  }
  if (name === null || name === TEXT_KEY) return null;

  const children: XmlNode[] = [];
  const textParts: string[] = [];

  for (const kid of kids) {
    if (TEXT_KEY in kid) {
      const t = kid[TEXT_KEY];
      if (t !== undefined && t !== null && String(t).length > 0) textParts.push(String(t));
      continue;
    }
    const child = convert(kid);
    if (child) children.push(child);
  }

  return {
    name,
    attrs: raw[ATTR_KEY] ?? {},
    children,
    text: textParts.join('').trim(),
  };
}

/**
 * Parse a document and return its root element.
 *
 * Accepts a string or raw bytes. Bytes are decoded as UTF-8, which is what
 * both formats mandate. Trailing NULs, a BOM and surrounding whitespace are
 * tolerated — see the note at the top of this file.
 */
export function loadXml(source: string | Uint8Array): XmlNode {
  let text = typeof source === 'string' ? source : new TextDecoder('utf-8').decode(source);

  // Strip a BOM, then any trailing NUL/whitespace. The NUL is the one that
  // matters: it is present in every MA-written file seen so far.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/[\0\s]+$/, '');

  const forest = parser.parse(text) as RawNode[];
  for (const raw of forest) {
    // Skip the XML declaration and any processing instructions.
    if ('?xml' in raw) continue;
    const node = convert(raw);
    if (node) return node;
  }
  throw new Error('XML document contains no root element');
}

/* ---------------------------------------------------------------- helpers */

/** Direct children with the given tag name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** First direct child with the given tag name, or undefined. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/**
 * Follow a chain of child names, e.g. `path(root, 'FixtureType', 'Models')`.
 * Returns undefined if any link is missing.
 */
export function path(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  let cur = node;
  for (const name of names) {
    if (!cur) return undefined;
    cur = child(cur, name);
  }
  return cur;
}

/** Trimmed text of a named child, or '' when the child is absent. */
export function childText(node: XmlNode, name: string): string {
  return child(node, name)?.text ?? '';
}

/** Attribute value, or '' when absent. GDTF uses '' and "absent" alike. */
export function attr(node: XmlNode, name: string): string {
  return node.attrs[name] ?? '';
}

/** Attribute parsed as a float. Returns `fallback` when absent or unparseable. */
export function attrNum(node: XmlNode, name: string, fallback: number): number {
  const raw = node.attrs[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Every descendant with the given name, depth-first, document order. */
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}
