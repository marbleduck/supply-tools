// Phase 4: OCR intake for scanned/image-only DA 3161 PDFs.
//
// Only invoked when a PDF has neither an XFA datasets stream nor a usable
// text layer (see app.js's handleFiles() - this is the exact case that
// used to be reported as "unprocessable"). Feeds OCR output into the
// *existing* flat-text parser (parseFlatText in da3161-parser.js) rather
// than a new parser, per the spec - this module's only job is producing
// the same line-based text shape pdfToLines() produces from a real text
// layer, just sourced from Tesseract.js word boxes instead.
//
// Deliberately split into two halves:
//   - reconstructLinesFromWords() is pure and synchronous - easy to unit
//     test without spinning up a Tesseract worker (see phase4/test/).
//   - recognizePage() does the actual OCR (async, loads a Tesseract
//     worker pointed at the vendored local core/lang files - never a CDN,
//     per the hard "no data leaves the browser" constraint).
//
// Plain classic script (no import/export), consistent with the rest of
// this codebase's file:// / Worker compatibility requirements.

// Groups Tesseract's word list into visual text lines and joins each line
// into a single string, analogous to app.js's pdfToLines() but built from
// OCR bounding boxes (y0/y1 per word) instead of pdf.js glyph transforms.
// Words don't share an exact y-coordinate the way pdf.js glyphs on one
// line do (ascenders/descenders/cap-height differ per word), so lines are
// found by 1-D clustering on vertical center, not an exact-match bucket.
//
// Returns { text, tokenConfidence } where tokenConfidence maps
// UPPERCASED word text -> lowest confidence seen for that exact word
// anywhere on the page (0-100, Tesseract's own scale). Used later to flag
// low-confidence serials without needing to duplicate parseFlatText's
// state machine.
function reconstructLinesFromWords(words) {
  if (!words || !words.length) return { text: '', tokenConfidence: {} };

  const withCenters = words
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({
      text: w.text,
      confidence: w.confidence,
      x0: w.bbox.x0,
      yCenter: (w.bbox.y0 + w.bbox.y1) / 2,
      height: w.bbox.y1 - w.bbox.y0,
    }));
  if (!withCenters.length) return { text: '', tokenConfidence: {} };

  const heights = withCenters.map((w) => w.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;
  const yTolerance = Math.max(medianHeight * 0.6, 6);

  const sorted = [...withCenters].sort((a, b) => a.yCenter - b.yCenter);
  const lines = [];
  let current = [];
  let currentY = null;
  for (const w of sorted) {
    if (current.length === 0 || Math.abs(w.yCenter - currentY) <= yTolerance) {
      current.push(w);
      // Running average keeps the cluster's reference y stable as more
      // words join, instead of drifting toward whichever word came last.
      currentY = current.reduce((s, x) => s + x.yCenter, 0) / current.length;
    } else {
      lines.push(current);
      current = [w];
      currentY = w.yCenter;
    }
  }
  if (current.length) lines.push(current);

  const tokenConfidence = {};
  const lineTexts = lines.map((lineWords) => {
    lineWords.sort((a, b) => a.x0 - b.x0);
    for (const w of lineWords) {
      const key = w.text.toUpperCase();
      if (!(key in tokenConfidence) || w.confidence < tokenConfidence[key]) {
        tokenConfidence[key] = w.confidence;
      }
    }
    return lineWords.map((w) => w.text).join(' ');
  });

  return { text: lineTexts.join('\n'), tokenConfidence };
}

// Cross-references parseFlatText's output serials against tokenConfidence
// (see reconstructLinesFromWords) and produces warning strings for any
// serial whose underlying OCR word(s) were read below `threshold`
// confidence. Matches by exact uppercased token text - a serial produced
// by cleanSerials' fixConcat/mergeBroken repair (i.e. one that doesn't
// correspond 1:1 to a single original OCR word) won't be found here and
// is silently not flagged; that's a known v1 limitation (documented in
// phase4-findings.md), not an oversight - precisely attributing confidence
// through the concat/merge repair would require threading confidence
// through cleanSerials itself, which stays untouched deliberately so
// non-OCR callers (the real text-layer paths) are unaffected.
function flagLowConfidenceSerials(rows, tokenConfidence, threshold) {
  const limit = threshold == null ? 75 : threshold;
  const warnings = [];
  for (const row of rows) {
    const sn = row[3];
    if (!sn) continue;
    const key = sn.toUpperCase();
    if (key in tokenConfidence && tokenConfidence[key] < limit) {
      warnings.push(
        `${row[4]}: low-confidence OCR read for serial "${sn}" (${tokenConfidence[key].toFixed(0)}% confidence) - verify against the source scan`
      );
    }
  }
  return warnings;
}

// Runs Tesseract.js against one page image and returns reconstructed
// line-text + confidence data. `imageSource` is anything Tesseract.js's
// recognize() accepts (canvas, ImageData, Blob, data URL, etc. - in the
// browser this is a canvas from rasterizePdfPageToCanvas() in app.js; in
// Node tests it's a file path).
//
// vendorBaseUrl points at phase2/lib/vendor/ - every path Tesseract needs
// (workerPath, corePath, langPath) is derived from it so nothing is ever
// fetched from a CDN, matching the same vendoring approach already used
// for pdf.js/pako.
async function recognizePage(imageSource, vendorBaseUrl) {
  const TesseractLib = (typeof self !== 'undefined' && self.Tesseract) || (typeof window !== 'undefined' && window.Tesseract);
  if (!TesseractLib) throw new Error('Tesseract global not found - is lib/vendor/tesseract/tesseract.min.js loaded?');

  const base = vendorBaseUrl.endsWith('/') ? vendorBaseUrl : vendorBaseUrl + '/';
  const worker = await TesseractLib.createWorker('eng', 1, {
    workerPath: base + 'tesseract/worker.min.js',
    corePath: base + 'tesseract-core/',
    langPath: base + 'tessdata/',
    cacheMethod: 'none', // local files only; no benefit to the browser's own HTTP/IndexedDB caching layer here
    logger: () => {},
  });
  try {
    const { data } = await worker.recognize(imageSource);
    const { text, tokenConfidence } = reconstructLinesFromWords(data.words);
    return { text, tokenConfidence, pageConfidence: data.confidence };
  } finally {
    await worker.terminate();
  }
}

// Multi-page convenience wrapper: OCRs each page image in order and joins
// them the same way app.js's pdfToLines() joins multi-page pdf.js output
// (blank-line separated), merging tokenConfidence maps across pages.
async function recognizePages(imageSources, vendorBaseUrl) {
  const pageTexts = [];
  const tokenConfidence = {};
  let minPageConfidence = 100;
  for (const src of imageSources) {
    const result = await recognizePage(src, vendorBaseUrl);
    pageTexts.push(result.text);
    Object.assign(tokenConfidence, result.tokenConfidence);
    minPageConfidence = Math.min(minPageConfidence, result.pageConfidence);
  }
  return { text: pageTexts.join('\n'), tokenConfidence, minPageConfidence };
}
