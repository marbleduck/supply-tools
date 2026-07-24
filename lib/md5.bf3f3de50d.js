// Compact, dependency-free MD5 implementation (RFC 1321), operating on a
// Uint8Array and returning a Uint8Array(16) digest. Written from the spec
// because Web Crypto's SubtleCrypto does not implement MD5 (by design -
// it's considered broken for security purposes), but the PDF Standard
// Security Handler's key-derivation algorithm (Algorithm 2 / ISO 32000-1
// Annex 7.6.3.3) mandates MD5 specifically for compatibility.
function md5(bytes) {
  function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
  function toWords(bytes) {
    const words = new Array(Math.ceil(bytes.length / 4)).fill(0);
    for (let i = 0; i < bytes.length; i++) {
      words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    }
    return words;
  }
  const K = new Int32Array([
    -680876936,-389564586,606105819,-1044525330,-176418897,1200080426,-1473231341,-45705983,
    1770035416,-1958414417,-42063,-1990404162,1804603682,-40341101,-1502002290,1236535329,
    -165796510,-1069501632,643717713,-373897302,-701558691,38016083,-660478335,-405537848,
    568446438,-1019803690,-187363961,1163531501,-1444681467,-51403784,1735328473,-1926607734,
    -378558,-2022574463,1839030562,-35309556,-1530992060,1272893353,-155497632,-1094730640,
    681279174,-358537222,-722521979,76029189,-640364487,-421815835,530742520,-995338651,
    -198630844,1126891415,-1416354905,-57434055,1700485571,-1894986606,-1051523,-2054922799,
    1873313359,-30611744,-1560198380,1309151649,-145523070,-1120210379,718787259,-343485551
  ]);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];

  const origLen = bytes.length;
  const bitLenLo = (origLen * 8) >>> 0;
  const bitLenHi = Math.floor(origLen / 0x20000000);

  const modLen = (origLen + 1) % 64;
  let padLen = modLen <= 56 ? (56 - modLen) : (120 - modLen);
  const total = origLen + 1 + padLen + 8;
  const padded = new Uint8Array(total);
  padded.set(bytes, 0);
  padded[origLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(total - 8, bitLenLo, true);
  dv.setUint32(total - 4, bitLenHi, true);

  const words = toWords(padded);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + words[chunk + g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, a0, true);
  outDv.setUint32(4, b0, true);
  outDv.setUint32(8, c0, true);
  outDv.setUint32(12, d0, true);
  return out;
}
