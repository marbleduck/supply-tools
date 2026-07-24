// Phase 2: main-thread app logic. Coordinates the Web Worker (worker.js)
// for the XFA path, falls back to pdf.js on the main thread for non-XFA
// PDFs (see worker.js for why), and renders per-file status + summary.
//
// Plain classic script (no import/export) - consistent with the rest of
// this codebase's file:// compatibility. da3161-config.js/da3161-parser.js
// are also loaded here (not just in the worker) so that (a) the pdf.js
// fallback has parseFlatText/rowsToCsv available on the main thread, and
// (b) if the worker fails to start at all in a given browser, processing
// can degrade gracefully to running synchronously on the main thread
// instead of the app simply not working.

(function () {
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const fileListEl = document.getElementById('fileList');
  const fileListSection = document.getElementById('fileListSection');
  const summarySection = document.getElementById('summarySection');
  const statTotalRows = document.getElementById('statTotalRows');
  const statMismatches = document.getElementById('statMismatches');
  const statAnomalies = document.getElementById('statAnomalies');
  const statErrors = document.getElementById('statErrors');
  const mismatchDisclosure = document.getElementById('mismatchDisclosure');
  const mismatchList = document.getElementById('mismatchList');
  const anomalyDisclosure = document.getElementById('anomalyDisclosure');
  const anomalyList = document.getElementById('anomalyList');
  const errorDisclosure = document.getElementById('errorDisclosure');
  const errorList = document.getElementById('errorList');
  // Phase 4: OCR low-confidence-serial warnings. Optional lookup (element
  // may not exist if index.html hasn't been updated) so this degrades
  // gracefully rather than throwing on startup.
  const ocrDisclosure = document.getElementById('ocrDisclosure');
  const ocrWarningList = document.getElementById('ocrWarningList');
  const downloadBtn = document.getElementById('downloadBtn');
  const previewSection = document.getElementById('previewSection');
  const previewTableWrap = document.getElementById('previewTableWrap');

  let allRows = [];
  let lastCsv = null;

  // ---------------------------------------------------------------
  // Worker lifecycle, with graceful degradation to main-thread
  // execution if the worker can't start in this browser/context.
  // ---------------------------------------------------------------
  let worker = null;
  let workerUsable = true;
  let nextRequestId = 0;
  const pending = new Map();

  function getWorker() {
    if (worker || !workerUsable) return worker;
    try {
      worker = new Worker('worker.b6c42d438c.js');
      worker.onmessage = (event) => {
        const { id } = event.data;
        const cb = pending.get(id);
        if (cb) { pending.delete(id); cb.resolve(event.data); }
      };
      worker.onerror = (event) => {
        // Irrecoverable worker failure (e.g. importScripts blocked). Fail
        // any in-flight requests so callers fall back to the main thread,
        // and stop trying to use the worker for subsequent files.
        console.warn('Worker failed, falling back to main-thread parsing:', event.message);
        workerUsable = false;
        for (const [, cb] of pending) cb.reject(new Error('worker unavailable'));
        pending.clear();
        worker = null;
      };
    } catch (e) {
      workerUsable = false;
      worker = null;
    }
    return worker;
  }

  function processInWorker(arrayBuffer, location) {
    const w = getWorker();
    if (!w) return Promise.reject(new Error('worker unavailable'));
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, arrayBuffer, location });
    });
  }

  // Synchronous main-thread equivalent of what worker.js does, used only
  // if the worker itself couldn't be started at all.
  async function processOnMainThread(arrayBuffer, location) {
    const { xmlText } = await extractXfaDatasets(arrayBuffer);
    if (xmlText) {
      const { rows, mismatches, anomalies } = parseXfaDatasets(xmlText, location);
      return { ok: true, via: 'xfa', rows, mismatches, anomalies };
    }
    return { ok: true, needsFallback: true };
  }

  // ---------------------------------------------------------------
  // pdf.js flat-text fallback (main thread only - see worker.js for why)
  // ---------------------------------------------------------------
  let pdfjsLibPromise = null;
  function getPdfjsLib() {
    if (!pdfjsLibPromise) {
      pdfjsLibPromise = import('./lib/vendor/pdf.0ca136ece0.mjs').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = './lib/vendor/pdf.worker.dde66d5cd4.mjs';
        return lib;
      });
    }
    return pdfjsLibPromise;
  }

  async function pdfToLines(arrayBuffer) {
    const pdfjsLib = await getPdfjsLib();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const pageTexts = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const tc = await page.getTextContent();
      const lines = new Map();
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5]);
        const x = it.transform[4];
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push({ x, str: it.str, width: it.width });
      }
      const ys = [...lines.keys()].sort((a, b) => b - a);
      pageTexts.push(ys.map((y) => lines.get(y).sort((a, b) => a.x - b.x).map((o) => o.str).join('')).join('\n'));
    }
    return pageTexts.join('\n');
  }

  // ---------------------------------------------------------------
  // Phase 4: OCR intake for scanned/image-only PDFs (main thread only -
  // same reasoning as the pdf.js flat-text fallback above: pdf.js's canvas
  // rendering and Tesseract.js's own Worker both need to be spun up from
  // here, not from inside worker.js). Only reached when a PDF has neither
  // XFA nor a real text layer - see the needsFallback branch in
  // handleFiles() below.
  // ---------------------------------------------------------------

  // Rasterizes one pdf.js page to a canvas at a scale tuned for OCR
  // accuracy (~300dpi equivalent - pdf.js's default viewport is 72dpi, so
  // scale 300/72 gets us there) without being wastefully large. Prefers
  // OffscreenCanvas (works without touching the DOM, and is what lets this
  // run without layout/paint side effects); falls back to a regular
  // <canvas> element for browsers/contexts without OffscreenCanvas.
  async function rasterizePdfPageToCanvas(page) {
    const scale = 300 / 72;
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  // Physically rotates a rasterized page canvas clockwise by 0/90/180/270
  // degrees - the correction OSD's detectOrientation() calls for (see
  // ocr.js for why that's per-page rather than once per document). Draws
  // onto a fresh canvas rather than mutating in place since a 90/270
  // rotation swaps width/height. No-ops (returns the same canvas) for 0,
  // the overwhelmingly common case, so unrotated documents pay no extra
  // canvas-alloc cost.
  function rotateCanvasClockwise(canvas, degrees) {
    const normalized = ((degrees % 360) + 360) % 360;
    if (normalized === 0) return canvas;
    const swapDims = normalized === 90 || normalized === 270;
    const w = canvas.width, h = canvas.height;
    const outW = swapDims ? h : w;
    const outH = swapDims ? w : h;
    const out = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(outW, outH)
      : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
    const ctx = out.getContext('2d');
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((normalized * Math.PI) / 180);
    ctx.drawImage(canvas, -w / 2, -h / 2);
    return out;
  }

  let tesseractVendorLoaded = false;
  function loadTesseractScript() {
    if (tesseractVendorLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'lib/vendor/tesseract/tesseract.min.js';
      script.onload = () => { tesseractVendorLoaded = true; resolve(); };
      script.onerror = () => reject(new Error('failed to load lib/vendor/tesseract/tesseract.min.js'));
      document.head.appendChild(script);
    });
  }

  // Rasterizes every page and OCRs it, returning the same shape
  // ocr.js's recognizePages() returns: { text, tokenConfidence }. Text
  // feeds into the existing parseFlatText() unchanged, per the spec -
  // this function's only job is producing that text plus a confidence map
  // for flagLowConfidenceSerials() to cross-reference afterward.
  async function ocrPdf(arrayBuffer, onProgress) {
    await loadTesseractScript();
    const pdfjsLib = await getPdfjsLib();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const pageTexts = [];
    const tokenConfidence = {};
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      if (onProgress) onProgress(pageNum, doc.numPages);
      const page = await doc.getPage(pageNum);
      let canvas = await rasterizePdfPageToCanvas(page);

      // Per-page OSD (see ocr.js's detectOrientation for why per-page, not
      // once for the whole file): a physically mis-fed scanner page comes
      // out rotated in the rasterized canvas even though the PDF's own
      // page-size metadata looks normal, and multi-page real scans have
      // been seen with orientation alternating page-to-page. Best-effort -
      // if OSD itself fails for any reason, recognize the page as-
      // rasterized rather than aborting the whole file over an
      // orientation-detection problem.
      try {
        const { orientationDegrees, orientationConfidence } = await detectOrientation(canvas, 'lib/vendor/');
        if (orientationDegrees && orientationConfidence > 1) {
          canvas = rotateCanvasClockwise(canvas, orientationDegrees);
        }
      } catch (osdErr) {
        console.warn(`OSD orientation detection failed on page ${pageNum}, proceeding unrotated:`, osdErr.message);
      }

      const result = await recognizePage(canvas, 'lib/vendor/');
      pageTexts.push(result.text);
      Object.assign(tokenConfidence, result.tokenConfidence);
    }
    return { text: pageTexts.join('\n'), tokenConfidence };
  }

  // ---------------------------------------------------------------
  // Per-file UI rows
  // ---------------------------------------------------------------
  function statusPillHtml(status) {
    const map = {
      queued: ['queued', '', 'Queued'],
      processing: ['processing', '<span class="spinner" aria-hidden="true"></span>', 'Processing'],
      done: ['done', '&#10003;', 'Done'],
      error: ['error', '&#10007;', 'Error'],
    };
    const [cls, icon, label] = map[status];
    return `<span class="status-pill ${cls}">${icon} ${label}</span>`;
  }

  function renderFileRow(fileState) {
    const row = fileState.el;
    row.querySelector('.status-slot').innerHTML = statusPillHtml(fileState.status);
    row.querySelector('.file-detail').textContent = fileState.detail || '';
  }

  function addFileRow(fileState) {
    const li = document.createElement('li');
    li.className = 'file-row';
    li.innerHTML = `
      <span class="file-name" title="${fileState.name}">${fileState.name}</span>
      <span class="file-detail"></span>
      <span class="status-slot"></span>
    `;
    fileListEl.appendChild(li);
    fileState.el = li;
    renderFileRow(fileState);
  }

  // ---------------------------------------------------------------
  // Main processing pipeline
  // ---------------------------------------------------------------
  async function handleFiles(fileObjs) {
    fileListSection.style.display = 'block';
    summarySection.style.display = 'none';
    previewSection.style.display = 'none';
    fileListEl.innerHTML = '';

    const states = fileObjs.map((file) => ({
      file, name: file.name, status: 'queued', detail: '', el: null,
    }));
    states.forEach(addFileRow);

    const rows = [], mismatches = [], anomalies = [], errors = [], ocrWarnings = [];

    for (const state of states) {
      state.status = 'processing';
      renderFileRow(state);

      const location = state.name.replace(/\.pdf$/i, '');
      try {
        const arrayBuffer = await state.file.arrayBuffer();
        let result;
        try {
          // No transfer list -> postMessage structured-clones the buffer,
          // so `arrayBuffer` here stays intact for the pdf.js fallback below
          // if this file turns out to have no XFA data.
          result = await processInWorker(arrayBuffer, location);
        } catch (workerErr) {
          result = await processOnMainThread(arrayBuffer, location);
        }

        if (result.ok && result.needsFallback) {
          try {
            const text = await pdfToLines(arrayBuffer);
            let r;
            if (text.trim()) {
              r = parseFlatText(text, location);
              rows.push(...r.rows); mismatches.push(...r.mismatches); anomalies.push(...r.anomalies);
              state.status = 'done';
              state.detail = `${r.rows.length} row(s) via flat-text fallback`;
            } else {
              // No XFA and no real text layer at all - this is the
              // scanned/image-only case. Route through OCR (Phase 4)
              // instead of reporting unprocessable.
              state.detail = 'Running OCR (no text layer found)…';
              renderFileRow(state);
              const { text: ocrText, tokenConfidence } = await ocrPdf(arrayBuffer, (pageNum, numPages) => {
                if (numPages > 1) {
                  state.detail = `Running OCR - page ${pageNum}/${numPages}…`;
                  renderFileRow(state);
                }
              });
              if (!ocrText.trim()) {
                throw new Error('no XFA data, no text layer, and OCR produced no text (image likely blank or unreadable)');
              }
              r = parseFlatText(ocrText, location);
              rows.push(...r.rows); mismatches.push(...r.mismatches); anomalies.push(...r.anomalies);
              ocrWarnings.push(...flagLowConfidenceSerials(r.rows, tokenConfidence));
              state.status = 'done';
              state.detail = `${r.rows.length} row(s) via OCR`;
            }
          } catch (fallbackErr) {
            state.status = 'error';
            state.detail = fallbackErr.message;
            errors.push(`${location}: ${fallbackErr.message}`);
          }
        } else if (result.ok) {
          rows.push(...result.rows); mismatches.push(...result.mismatches); anomalies.push(...result.anomalies);
          state.status = 'done';
          state.detail = `${result.rows.length} row(s)`;
        } else {
          state.status = 'error';
          state.detail = result.error;
          errors.push(`${location}: ${result.error}`);
        }
      } catch (e) {
        state.status = 'error';
        state.detail = e.message;
        errors.push(`${location}: failed to open/inspect PDF (${e.message})`);
      }
      renderFileRow(state);
    }

    allRows = rows;
    lastCsv = rowsToCsv(DA3161_CONFIG.csvHeader, rows);
    renderSummary(rows, mismatches, anomalies, errors, ocrWarnings);
  }

  function fillDisclosure(disclosureEl, listEl, items) {
    if (!items.length) { disclosureEl.style.display = 'none'; return; }
    disclosureEl.style.display = 'block';
    listEl.innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderSummary(rows, mismatches, anomalies, errors, ocrWarnings) {
    summarySection.style.display = 'block';
    statTotalRows.textContent = rows.length;
    statMismatches.textContent = mismatches.length;
    statAnomalies.textContent = anomalies.length;
    statErrors.textContent = errors.length;

    fillDisclosure(mismatchDisclosure, mismatchList, mismatches);
    fillDisclosure(anomalyDisclosure, anomalyList, anomalies);
    fillDisclosure(errorDisclosure, errorList, errors);
    if (ocrDisclosure) fillDisclosure(ocrDisclosure, ocrWarningList, ocrWarnings || []);

    downloadBtn.disabled = rows.length === 0;

    previewSection.style.display = 'block';
    let html = '<table class="preview-table"><thead><tr>' +
      DA3161_CONFIG.csvHeader.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    if (rows.length === 0) {
      html += `<tr><td colspan="${DA3161_CONFIG.csvHeader.length}" class="empty-state">No rows generated.</td></tr>`;
    } else {
      for (const row of rows.slice(0, 50)) {
        html += '<tr>' + row.map((c) => `<td title="${escapeHtml(c ?? '')}">${escapeHtml(c ?? '')}</td>`).join('') + '</tr>';
      }
    }
    html += '</tbody></table>';
    previewTableWrap.innerHTML = html;
  }

  downloadBtn.addEventListener('click', () => {
    if (!lastCsv) return;
    const blob = new Blob([lastCsv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'da3161_transfer_serials.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------------------------------------------------------------
  // Dropzone + file picker wiring
  // ---------------------------------------------------------------
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFiles([...e.target.files]);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (files.length) handleFiles(files);
  });

  // ---------------------------------------------------------------
  // Service Worker registration (Phase 4: offline after first load).
  // Service Worker registration itself requires a secure context (HTTPS,
  // or localhost for local testing) - browsers refuse it over plain
  // file:// or insecure http://, by design. That's fine: it's a pure
  // enhancement layered on top of an app that's already fully functional
  // (XFA path) without it. Guarded and non-fatal if unsupported/blocked.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service Worker registration failed (offline caching will not be available):', err.message);
      });
    });
  }
})();
