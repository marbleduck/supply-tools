// Minimal, dependency-free XML parser used in place of the browser's
// DOMParser.
//
// Why this exists: `DOMParser` is a DOM API - it genuinely does not exist
// inside a Web Worker (workers have no DOM at all, by design). The XFA
// path's Web Worker (worker.js) needs to parse the extracted XFA datasets
// XML into a tree so da3161-parser.js can walk it the same way regardless
// of which thread it runs on. Rather than round-tripping the (potentially
// large) XML text back to the main thread just to get access to a real
// DOMParser, this implements just enough of a DOM-like API - `tagName`,
// `children`, `textContent`, `getElementsByTagName()` - to parse the XFA
// datasets XML format actually produced by these forms (verified against
// all 26 real Walker/Davis Hall samples plus the synthetic test files).
//
// Plain classic script (no import/export), same file:// / Worker-loading
// reasoning as the rest of this codebase.

function parseXmlLite(xmlText) {
  const len = xmlText.length;
  let pos = 0;

  function peekIs(s) { return xmlText.startsWith(s, pos); }
  function skipWs() { while (pos < len && /\s/.test(xmlText[pos])) pos++; }

  function skipMisc() {
    while (true) {
      skipWs();
      if (peekIs('<?')) { const e = xmlText.indexOf('?>', pos); pos = e < 0 ? len : e + 2; }
      else if (peekIs('<!--')) { const e = xmlText.indexOf('-->', pos); pos = e < 0 ? len : e + 3; }
      else if (peekIs('<!')) { const e = xmlText.indexOf('>', pos); pos = e < 0 ? len : e + 1; }
      else break;
    }
  }

  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent) => {
      if (ent[0] === '#') {
        const isHex = ent[1] === 'x' || ent[1] === 'X';
        const code = parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      }
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      return named[ent] !== undefined ? named[ent] : whole;
    });
  }

  class XmlElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.nodes = []; // ordered mix of string (text) | XmlElement, document order
    }
    get children() {
      return this.nodes.filter((n) => n instanceof XmlElement);
    }
    get textContent() {
      let out = '';
      for (const n of this.nodes) out += n instanceof XmlElement ? n.textContent : n;
      return out;
    }
    getElementsByTagName(name) {
      const results = [];
      const walk = (el) => {
        for (const n of el.nodes) {
          if (n instanceof XmlElement) {
            if (n.tagName === name) results.push(n);
            walk(n);
          }
        }
      };
      walk(this);
      return results;
    }
  }

  function parseElement() {
    pos++; // consume '<'
    const nameMatch = /^[^\s/>]+/.exec(xmlText.slice(pos));
    if (!nameMatch) throw new Error(`parseXmlLite: malformed tag at position ${pos}`);
    const tagName = nameMatch[0];
    pos += tagName.length;

    // Attributes (parsed structurally but discarded - nothing downstream
    // needs attribute values, only element structure/text).
    while (true) {
      skipWs();
      if (peekIs('/>')) { pos += 2; return new XmlElement(tagName); }
      if (peekIs('>')) { pos += 1; break; }
      const attrMatch = /^[^\s=/>]+/.exec(xmlText.slice(pos));
      if (!attrMatch) { pos++; continue; } // defensive: avoid infinite loop on malformed input
      pos += attrMatch[0].length;
      skipWs();
      if (peekIs('=')) {
        pos++;
        skipWs();
        const quote = xmlText[pos];
        if (quote === '"' || quote === "'") {
          pos++;
          const end = xmlText.indexOf(quote, pos);
          pos = end < 0 ? len : end + 1;
        }
      }
    }

    const el = new XmlElement(tagName);
    while (pos < len) {
      if (peekIs('</')) {
        const closeMatch = /^<\/[^\s>]+\s*>/.exec(xmlText.slice(pos));
        pos = closeMatch ? pos + closeMatch[0].length : len;
        break;
      }
      if (peekIs('<!--')) { const e = xmlText.indexOf('-->', pos); pos = e < 0 ? len : e + 3; continue; }
      if (peekIs('<![CDATA[')) {
        const e = xmlText.indexOf(']]>', pos + 9);
        el.nodes.push(xmlText.slice(pos + 9, e < 0 ? len : e));
        pos = e < 0 ? len : e + 3;
        continue;
      }
      if (peekIs('<')) { el.nodes.push(parseElement()); continue; }
      const nextLt = xmlText.indexOf('<', pos);
      const textEnd = nextLt < 0 ? len : nextLt;
      const raw = xmlText.slice(pos, textEnd);
      pos = textEnd;
      if (raw) el.nodes.push(decodeEntities(raw));
    }
    return el;
  }

  skipMisc();
  if (xmlText[pos] !== '<') throw new Error('parseXmlLite: expected root element, found none');
  const root = parseElement();

  return {
    documentElement: root,
    getElementsByTagName(name) {
      const results = root.tagName === name ? [root] : [];
      results.push(...root.getElementsByTagName(name));
      return results;
    },
  };
}
