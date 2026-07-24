// Phase 2: dedicated Web Worker running the CPU-heavy part of parsing off
// the main thread, so the UI stays responsive across a batch of files.
//
// Deliberately a CLASSIC worker (no `{ type: 'module' }`), loading its
// dependencies via importScripts() rather than ES module imports. This is
// the same reasoning as Phase 0's file:// CORS fix: importScripts() uses
// the older, more permissive classic-script loading algorithm, not the
// module-fetch algorithm that browsers block under a file:// "null"
// origin. That keeps the common (XFA) path working with a plain
// double-click, no local server required.
//
// pdf.js (needed only for the flat-text fallback on non-XFA PDFs) is
// ES-module-only in this pdfjs-dist version and can't be loaded here via
// importScripts(). That fallback runs on the main thread instead - see
// app.js. This worker handles: XFA extraction + parsing (the common case,
// and 100% of the real Walker/Davis Hall samples), and reports back
// "needsFallback" for anything without XFA so the main thread can take over.
importScripts(
  'lib/vendor/pako_inflate.umd.min.5399434c66.js',
  'lib/md5.bf3f3de50d.js',
  'lib/xml-lite.fbeedbde13.js',
  'lib/pdf-xfa-parser.4fb65653dc.js',
  'lib/da3161-config.58cffd2f03.js',
  'lib/da3161-parser.9a9905affc.js'
);

self.onmessage = async (event) => {
  const { id, arrayBuffer, location } = event.data;
  try {
    const { xmlText } = await extractXfaDatasets(arrayBuffer);
    if (xmlText) {
      const { rows, mismatches, anomalies } = parseXfaDatasets(xmlText, location);
      self.postMessage({ id, ok: true, via: 'xfa', rows, mismatches, anomalies });
    } else {
      // No XFA data - hand back to the main thread for the pdf.js-based
      // flat-text fallback (see note above on why that can't happen here).
      // The main thread keeps its own copy of the file's bytes (it doesn't
      // transfer ownership when posting to this worker), so it can just
      // reuse that rather than this worker sending anything back.
      self.postMessage({ id, ok: true, needsFallback: true });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: e.message });
  }
};
