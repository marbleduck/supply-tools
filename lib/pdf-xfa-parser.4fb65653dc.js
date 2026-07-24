// Phase 0 prototype: extract the raw XFA "datasets" XML stream from a DA
// FORM 3161 PDF, entirely client-side, entirely from raw bytes.
//
// Handles what real-world Acrobat/LiveCycle-generated PDFs of this kind
// turned out to need (discovered while building this prototype):
//   - Cross-reference STREAMS (not classic plain-text xref tables)
//   - Object streams (/Type /ObjStm) - dictionaries compressed together
//   - Incremental updates (/Prev chain) from digital-signature workflows
//   - Standard Security Handler encryption, R4 / AESV2, empty user password
//     (these PDFs are encrypted with a blank user password - openable, but
//     genuinely encrypted; a naive reader that ignores /Encrypt will get
//     ciphertext garbage back instead of XML)
//
// No pdf.js / pdf-lib dependency: this file IS the "raw object graph walk"
// pdf.js's public API turned out not to expose. Only dependency: pako
// (Flate/zlib inflate) and the local md5.js (Web Crypto has no MD5).
//
// Plain classic script (no import/export) - loaded via <script src> in
// index.html so this works when the page is opened directly from disk
// (file://). ES module imports of other local files get blocked by CORS
// under the file:// "null" origin in Chrome/Safari; classic scripts aren't
// subject to that restriction. md5.js must be loaded before this file.

const PAD = new Uint8Array([
  0x28,0xbf,0x4e,0x5e,0x4e,0x75,0x8a,0x41,0x64,0x00,0x4e,0x56,0xff,0xfa,0x01,0x08,
  0x2e,0x2e,0x00,0xb6,0xd0,0x68,0x3e,0x80,0x2f,0x0c,0xa9,0xfe,0x64,0x53,0x69,0x7a
]);

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function u32le(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

async function computeFileKey({ O, P, ID0, R, lengthBytes, encryptMetadata }) {
  let input = concatBytes(PAD, O, u32le(P), ID0);
  if (R >= 4 && !encryptMetadata) input = concatBytes(input, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(input);
  if (R >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, lengthBytes));
  }
  return hash.subarray(0, lengthBytes);
}

function computeObjectKey(fileKey, objNum, genNum) {
  const input = concatBytes(
    fileKey,
    new Uint8Array([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff]),
    new Uint8Array([genNum & 0xff, (genNum >> 8) & 0xff]),
    new Uint8Array([0x73, 0x41, 0x6c, 0x54]) // "sAlT"
  );
  const hash = md5(input);
  return hash.subarray(0, Math.min(fileKey.length + 5, 16));
}

async function aesCbcDecrypt(objectKey, bytes) {
  const iv = bytes.subarray(0, 16);
  const ciphertext = bytes.subarray(16);
  const key = await crypto.subtle.importKey('raw', objectKey, { name: 'AES-CBC' }, false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  return new Uint8Array(plainBuf);
}

function undoPngPredictor(data, columns) {
  const rowLen = columns + 1;
  const numRows = Math.floor(data.length / rowLen);
  const out = new Uint8Array(numRows * columns);
  let prevRow = new Uint8Array(columns);
  for (let r = 0; r < numRows; r++) {
    const rowStart = r * rowLen;
    const filterType = data[rowStart];
    const row = data.subarray(rowStart + 1, rowStart + 1 + columns);
    const outRow = new Uint8Array(columns);
    for (let i = 0; i < columns; i++) {
      const raw = row[i];
      const left = i > 0 ? outRow[i - 1] : 0;
      const up = prevRow[i];
      let val;
      if (filterType === 2) val = (raw + up) & 0xff;
      else if (filterType === 0) val = raw;
      else if (filterType === 1) val = (raw + left) & 0xff;
      else throw new Error(`Unsupported PNG predictor filter type ${filterType}`);
      outRow[i] = val;
    }
    outRow.set(outRow);
    out.set(outRow, r * columns);
    prevRow = outRow;
  }
  return out;
}

// True byte<->char transparency (1 byte -> exactly one code point 0-255).
// NOTE: TextDecoder('iso-8859-1') is NOT safe for this - per the WHATWG
// Encoding Standard, browsers/Node implement the "iso-8859-1"/"latin1"
// labels as aliases for *windows-1252*, which remaps bytes 0x80-0x9F to
// different (sometimes >0xFF) Unicode code points (e.g. byte 0x87 becomes
// U+2021). That silently corrupts any raw binary content - like the
// encrypted /O, /U, /ID string values - parsed out of the dictionary text.
function bytesToRawString(bytes) {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

class PdfFile {
  constructor(bytes) {
    this.buf = bytes;
    this.txt = bytesToRawString(bytes); // 1 byte <-> 1 char, true identity mapping
    this.xref = new Map();
    this.trailer = null;
    this.fileKey = null;
    this.objStmCache = new Map();
  }

  skipWs(pos) {
    const t = this.txt;
    while (pos < t.length) {
      const c = t[pos];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { pos++; continue; }
      if (c === '%') { while (pos < t.length && t[pos] !== '\n' && t[pos] !== '\r') pos++; continue; }
      break;
    }
    return pos;
  }

  parseValue(pos) {
    pos = this.skipWs(pos);
    const t = this.txt;
    const c = t[pos];
    if (c === '<' && t[pos + 1] === '<') return this.parseDict(pos);
    if (c === '[') return this.parseArray(pos);
    if (c === '/') return this.parseName(pos);
    if (c === '(') return this.parseLiteralString(pos);
    if (c === '<') return this.parseHexString(pos);
    if (/[0-9+\-.]/.test(c)) return this.parseNumberOrRef(pos);
    if (t.startsWith('true', pos)) return { value: true, end: pos + 4 };
    if (t.startsWith('false', pos)) return { value: false, end: pos + 5 };
    if (t.startsWith('null', pos)) return { value: null, end: pos + 4 };
    throw new Error(`Unexpected token at ${pos}: ${JSON.stringify(t.slice(pos, pos + 20))}`);
  }

  parseName(pos) {
    let end = pos + 1;
    const t = this.txt;
    let name = '';
    while (end < t.length && !/[\s\/\[\]<>()%]/.test(t[end])) {
      if (t[end] === '#' && /[0-9a-fA-F]{2}/.test(t.slice(end + 1, end + 3))) {
        name += String.fromCharCode(parseInt(t.slice(end + 1, end + 3), 16));
        end += 3;
      } else {
        name += t[end];
        end++;
      }
    }
    return { value: { __name: name }, end };
  }

  parseNumberOrRef(pos) {
    const t = this.txt;
    const m = /^[+\-]?\d+(\.\d+)?/.exec(t.slice(pos));
    const numStr = m[0];
    let end = pos + numStr.length;
    if (!numStr.includes('.')) {
      const rest = t.slice(end);
      const refMatch = /^\s+(\d+)\s+(R)\b/.exec(rest);
      if (refMatch) return { value: { __ref: [parseInt(numStr, 10), parseInt(refMatch[1], 10)] }, end: end + refMatch[0].length };
    }
    return { value: parseFloat(numStr), end };
  }

  parseLiteralString(pos) {
    const t = this.txt;
    let end = pos + 1, depth = 1, out = [];
    while (end < t.length && depth > 0) {
      const c = t[end];
      if (c === '\\') {
        const n = t[end + 1];
        const escMap = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (escMap[n] !== undefined) { out.push(escMap[n]); end += 2; }
        else if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(t.slice(end + 1))[0];
          out.push(String.fromCharCode(parseInt(oct, 8) & 0xff));
          end += 1 + oct.length;
        } else if (n === '\n') { end += 2; }
        else { out.push(n); end += 2; }
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) { end++; break; } }
      out.push(c); end++;
    }
    return { value: { __string: out.join('') }, end };
  }

  parseHexString(pos) {
    const t = this.txt;
    const end = t.indexOf('>', pos);
    const hex = t.slice(pos + 1, end).replace(/\s/g, '');
    let bytes = '';
    for (let i = 0; i < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
    return { value: { __string: bytes }, end: end + 1 };
  }

  parseArray(pos) {
    let p = pos + 1;
    const arr = [];
    while (true) {
      p = this.skipWs(p);
      if (this.txt[p] === ']') { p++; break; }
      const { value, end } = this.parseValue(p);
      arr.push(value); p = end;
    }
    return { value: { __array: arr }, end: p };
  }

  parseDict(pos) {
    let p = pos + 2;
    const dict = {};
    while (true) {
      p = this.skipWs(p);
      if (this.txt[p] === '>' && this.txt[p + 1] === '>') { p += 2; break; }
      const { value: key, end: keyEnd } = this.parseName(p);
      p = this.skipWs(keyEnd);
      const { value, end } = this.parseValue(p);
      dict[key.__name] = value; p = end;
    }
    let afterDict = this.skipWs(p);
    if (this.txt.startsWith('stream', afterDict)) {
      let streamStart = afterDict + 6;
      if (this.txt[streamStart] === '\r' && this.txt[streamStart + 1] === '\n') streamStart += 2;
      else if (this.txt[streamStart] === '\n') streamStart += 1;
      const lengthEntry = dict['Length'];
      let streamLen;
      if (typeof lengthEntry === 'number') streamLen = lengthEntry;
      else {
        const esIdx = this.txt.indexOf('endstream', streamStart);
        streamLen = esIdx - streamStart;
        while (streamLen > 0 && (this.txt[streamStart + streamLen - 1] === '\n' || this.txt[streamStart + streamLen - 1] === '\r')) streamLen--;
      }
      const rawStreamBytes = this.buf.subarray(streamStart, streamStart + streamLen);
      const endstreamIdx = this.txt.indexOf('endstream', streamStart + streamLen);
      p = endstreamIdx + 'endstream'.length;
      return { value: { __dict: dict, __rawStream: rawStreamBytes }, end: p };
    }
    return { value: { __dict: dict }, end: p };
  }

  // Dispatches to whichever xref format this section actually uses. All 26
  // real DA 3161 samples use cross-reference STREAMS (Acrobat/LiveCycle
  // output), but non-XFA/flattened PDFs from other tools (e.g. reportlab,
  // or older Acrobat versions) commonly use the classic plain-text xref
  // table instead - both need to work so the "no XFA -> fall back to text"
  // path doesn't crash before it even gets a chance to check for XFA.
  parseXrefSection(offset, seen = new Set()) {
    if (seen.has(offset)) return;
    seen.add(offset);
    const p = this.skipWs(offset);
    if (this.txt.startsWith('xref', p)) {
      this.parseClassicXrefSection(p, seen);
    } else {
      this.parseXrefStreamSection(p, seen);
    }
  }

  parseClassicXrefSection(pos, seen) {
    const t = this.txt;
    let p = pos + 4; // skip "xref"
    while (true) {
      p = this.skipWs(p);
      if (t.startsWith('trailer', p)) { p += 'trailer'.length; break; }
      const subMatch = /^(\d+)\s+(\d+)/.exec(t.slice(p));
      if (!subMatch) break;
      const startNum = parseInt(subMatch[1], 10);
      const count = parseInt(subMatch[2], 10);
      p += subMatch[0].length;
      p = this.skipWs(p);
      for (let j = 0; j < count; j++) {
        // Each entry is exactly 20 bytes: 10-digit offset, ' ', 5-digit gen,
        // ' ', 'n'/'f', then a 2-byte EOL (spec-mandated fixed width).
        const entry = t.slice(p, p + 20);
        const objNum = startNum + j;
        if (!this.xref.has(objNum)) {
          const type = entry[17];
          if (type === 'n') {
            this.xref.set(objNum, { type: 1, offset: parseInt(entry.slice(0, 10), 10), gen: parseInt(entry.slice(11, 16), 10) });
          } else {
            this.xref.set(objNum, { type: 0 });
          }
        }
        p += 20;
      }
    }
    p = this.skipWs(p);
    const { value } = this.parseValue(p);
    const dict = value.__dict;
    if (!this.trailer) this.trailer = dict;
    if (dict['Prev'] !== undefined) this.parseXrefSection(dict['Prev'], seen);
  }

  parseXrefStreamSection(offset, seen) {
    const t = this.txt;
    const objHeaderMatch = /^(\d+)\s+(\d+)\s+obj/.exec(t.slice(offset));
    if (!objHeaderMatch) throw new Error(`No object header at xref offset ${offset}`);
    const afterHeader = offset + objHeaderMatch[0].length;
    const { value } = this.parseValue(afterHeader);
    const dict = value.__dict;
    const rawStream = value.__rawStream;
    if (!this.trailer) this.trailer = dict;

    const W = dict['W'].__array.map(v => v);
    const [w0, w1, w2] = W;
    const size = dict['Size'];
    let index = dict['Index'] ? dict['Index'].__array : [0, size];

    let data = globalThis.pako.inflate(rawStream);
    const decodeParms = dict['DecodeParms'];
    const predictor = decodeParms ? decodeParms.__dict['Predictor'] : null;
    const columns = decodeParms ? (decodeParms.__dict['Columns'] || (w0 + w1 + w2)) : (w0 + w1 + w2);
    if (predictor && predictor >= 10) data = undoPngPredictor(data, columns);

    let p = 0;
    const rowLen = w0 + w1 + w2;
    for (let i = 0; i < index.length; i += 2) {
      const startNum = index[i], count = index[i + 1];
      for (let j = 0; j < count; j++) {
        const objNum = startNum + j;
        const row = data.subarray(p, p + rowLen);
        p += rowLen;
        let idx = 0;
        const readField = (width, defaultVal) => {
          if (width === 0) return defaultVal;
          let v = 0;
          for (let k = 0; k < width; k++) v = v * 256 + row[idx++];
          return v;
        };
        const type = readField(w0, 1);
        const field2 = readField(w1, 0);
        const field3 = readField(w2, 0);
        if (!this.xref.has(objNum)) {
          if (type === 0) this.xref.set(objNum, { type: 0 });
          else if (type === 1) this.xref.set(objNum, { type: 1, offset: field2, gen: field3 });
          else if (type === 2) this.xref.set(objNum, { type: 2, streamObjNum: field2, index: field3 });
        }
      }
    }
    if (dict['Prev'] !== undefined) this.parseXrefSection(dict['Prev'], seen);
  }

  loadXref() {
    const t = this.txt;
    const idx = t.lastIndexOf('startxref');
    const m = /startxref\s+(\d+)/.exec(t.slice(idx));
    this.parseXrefSection(parseInt(m[1], 10));
  }

  async setupEncryption() {
    const encRef = this.trailer['Encrypt'];
    if (!encRef) return;
    const encDict = (await this.resolveRef(encRef.__ref)).__dict;
    const O = new Uint8Array([...encDict['O'].__string].map(c => c.charCodeAt(0)));
    const P = encDict['P'];
    const R = encDict['R'];
    const idArr = this.trailer['ID'].__array;
    const ID0 = new Uint8Array([...idArr[0].__string].map(c => c.charCodeAt(0)));
    const lengthBits = encDict['Length'] || 40;
    const lengthBytes = lengthBits / 8;
    const encryptMetadata = encDict['EncryptMetadata'] !== false;
    this.fileKey = await computeFileKey({ O, P, ID0, R, lengthBytes, encryptMetadata });
    this.encMeta = { R, lengthBytes };
  }

  async decryptIfNeeded(bytes, objNum, gen) {
    if (!this.fileKey) return bytes;
    const key = computeObjectKey(this.fileKey, objNum, gen);
    return aesCbcDecrypt(key, bytes);
  }

  async resolveRef([objNum]) {
    const entry = this.xref.get(objNum);
    if (!entry) throw new Error(`No xref entry for object ${objNum}`);
    if (entry.type === 1) {
      const { value } = this.parseValue(entry.offset + `${objNum} ${entry.gen} obj`.length);
      return value;
    }
    if (entry.type === 2) return this.getFromObjStm(entry.streamObjNum, entry.index);
    throw new Error(`Unsupported xref entry type for object ${objNum}`);
  }

  async getRawStreamBytes(objNum) {
    const entry = this.xref.get(objNum);
    if (entry.type !== 1) throw new Error('expected direct object for raw stream access');
    const { value } = this.parseValue(entry.offset + `${objNum} ${entry.gen} obj`.length);
    return this.decryptIfNeeded(value.__rawStream, objNum, entry.gen);
  }

  async getFromObjStm(streamObjNum, index) {
    if (!this.objStmCache.has(streamObjNum)) {
      const entry = this.xref.get(streamObjNum);
      const { value } = this.parseValue(entry.offset + `${streamObjNum} ${entry.gen} obj`.length);
      const decrypted = await this.decryptIfNeeded(value.__rawStream, streamObjNum, entry.gen);
      const inflated = globalThis.pako.inflate(decrypted);
      const n = value.__dict['N'];
      const first = value.__dict['First'];
      const headerTxt = bytesToRawString(inflated.subarray(0, first));
      const nums = headerTxt.trim().split(/\s+/).map(Number);
      const offsets = [];
      for (let i = 0; i < n; i++) offsets.push({ num: nums[i * 2], off: nums[i * 2 + 1] });
      const fullBuf = new Uint8Array(first + inflated.length - first);
      fullBuf.set(inflated.subarray(first), first);
      const subParser = new PdfFile(fullBuf);
      const parsed = new Map();
      for (let i = 0; i < offsets.length; i++) {
        const { value: v } = subParser.parseValue(first + offsets[i].off);
        parsed.set(offsets[i].num, v);
      }
      this.objStmCache.set(streamObjNum, parsed);
    }
    const cache = this.objStmCache.get(streamObjNum);
    const entriesInOrder = [...cache.entries()];
    return entriesInOrder[index][1];
  }
}

// Public entry point. Mirrors the reference Python script's
// extract_xfa_datasets(): returns { xmlText: null } (not a throw) when the
// PDF genuinely has no AcroForm/XFA/datasets entry, so callers can fall back
// to the flat-text path - same "return None" contract as the Python
// original. Throws only for genuine parse failures (corrupt/unexpected
// structure), matching the Python script's try/except split between "no
// XFA" and "failed to open/inspect".
async function extractXfaDatasets(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const pdf = new PdfFile(bytes);
  pdf.loadXref();
  await pdf.setupEncryption();

  const rootRef = pdf.trailer['Root'].__ref;
  const root = (await pdf.resolveRef(rootRef)).__dict;
  if (!root['AcroForm']) return { xmlText: null };
  const acroFormRef = root['AcroForm'].__ref;
  const acroForm = (await pdf.resolveRef(acroFormRef)).__dict;
  if (!acroForm['XFA']) return { xmlText: null };
  const xfaArr = acroForm['XFA'].__array;

  let datasetsRef = null;
  for (let i = 0; i < xfaArr.length; i += 2) {
    if (xfaArr[i].__string === 'datasets') { datasetsRef = xfaArr[i + 1].__ref; break; }
  }
  if (!datasetsRef) return { xmlText: null };

  const [datasetsObjNum] = datasetsRef;
  const rawDecrypted = await pdf.getRawStreamBytes(datasetsObjNum);
  const xmlBytes = globalThis.pako.inflate(rawDecrypted);
  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
  return { xmlText, datasetsObjNum, rootRef, acroFormRef, encrypted: !!pdf.fileKey };
}
