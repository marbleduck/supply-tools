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

// Clusters a set of words (already {text,confidence,x0,width,yCenter,
// height} shaped - see reconstructLinesFromWords) into visual text lines
// by 1-D clustering on vertical center (words don't share an exact
// y-coordinate the way pdf.js glyphs on one line do - ascenders/
// descenders/cap-height differ per word), then joins each line's words
// left-to-right. Returns lines in top-to-bottom order as
// [{ yCenter, text }]. Factored out of reconstructLinesFromWords so the
// same clustering logic can run once over the whole page (the simple,
// single-column case) or independently per x-zone (the grid-table case -
// see reconstructGridText below); the two cases used to be duplicated
// inline before real-world grid forms (dense bordered multi-column DA
// 3161 scans, not the single-column synthetic fixture this was originally
// validated against) showed the single-stream version gluing unrelated
// table cells onto one line whenever they shared a row.
function joinWordsIntoLines(wordList, medianHeight) {
  const rows = groupIntoRows(wordList, medianHeight);
  return rows.map((lineWords) => {
    const sortedWords = [...lineWords].sort((a, b) => a.x0 - b.x0);
    return {
      yCenter: sortedWords.reduce((s, x) => s + x.yCenter, 0) / sortedWords.length,
      text: sortedWords.map((w) => w.text).join(' '),
    };
  });
}

// Column-gap detection via row-wise voting: finds x-positions that are
// consistently a gap *within* many individual table rows, rather than
// unioning every word's x-range over the whole page at once (a page-wide
// projection profile - the more obvious first approach - turned out to be
// too fragile on a real dense DA 3161: a single word anywhere on the page
// that happens to straddle a real column gutter, e.g. an overlong item
// description or a wide digit run, silently erases that gutter for the
// entire page). Row-wise voting tolerates that kind of one-off bleed-
// through as long as the gutter still reads as a real gap in enough other
// rows - the standard approach for table-structure recognition, and the
// x-axis analogue of clustering lines by y-gaps in joinWordsIntoLines.
//
// Deliberately coarse: this only needs to find the page's *major* zone
// boundaries (see reconstructGridText's 3-zone collapse), not every
// individual grid column. Returns null when nothing that looks like real,
// recurring column structure is found (e.g. a simple single-column
// document like the original synthetic flat-text fixture, where no row
// has an internal gap wide enough to vote at all) - callers treat that as
// "not a grid page" and skip straight to the legacy single-stream
// reconstruction.
function detectColumnSpans(withCenters, medianHeight) {
  if (withCenters.length < 4) return null;

  const rows = groupIntoRows(withCenters, medianHeight);
  const minGap = Math.max(medianHeight * 1.2, 15);
  // A real recurring column boundary only needs enough independent rows'
  // gaps to overlap there - low enough to still catch boundaries that not
  // every row can vote for (e.g. a short item whose description doesn't
  // reach as far right as the qty/price columns), but high enough that
  // one or two coincidental gaps in short/sparse rows don't get mistaken
  // for a real gutter.
  const minVotes = Math.max(3, Math.round(rows.length * 0.15));

  // Sweep-line max-overlap: each row's internal gap becomes a +1/-1
  // interval event at its exact [start,end), then a single left-to-right
  // sweep finds the x-ranges covered by at least minVotes rows at once.
  // This replaced an earlier version that bucketed each gap by its
  // midpoint and voted per-bucket - which sounds equivalent but isn't: a
  // real column's gutter is a fixed x-range, but the *midpoint* of any
  // one row's gap shifts with that row's own content width (a short MPO
  // vs a long one, a short description vs a long one), so votes for the
  // same real gutter smeared across many adjacent buckets instead of
  // piling up in one - confirmed on a real page where the true boundary
  // needed 9 votes to pass the threshold but no single bucket ever
  // collected more than 8. Exact interval overlap counting doesn't have
  // that smearing problem: every row's gap interval still *contains* the
  // true gutter regardless of where that row's content happens to end.
  const events = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    const rowSorted = [...row].sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < rowSorted.length; i++) {
      const gapStart = rowSorted[i - 1].x0 + Math.max(rowSorted[i - 1].width || 0, 1);
      const gapEnd = rowSorted[i].x0;
      if (gapEnd - gapStart >= minGap) {
        events.push([gapStart, 1]);
        events.push([gapEnd, -1]);
      }
    }
  }
  if (!events.length) return null;
  events.sort((a, b) => a[0] - b[0]);

  let coverage = 0;
  let regionStart = null;
  const cuts = [];
  for (const [x, delta] of events) {
    const prevCoverage = coverage;
    coverage += delta;
    if (prevCoverage < minVotes && coverage >= minVotes) regionStart = x;
    if (prevCoverage >= minVotes && coverage < minVotes && regionStart !== null) {
      cuts.push((regionStart + x) / 2); // midpoint of the high-coverage region
      regionStart = null;
    }
  }
  if (!cuts.length) return null;

  const pageMinX = Math.min(...withCenters.map((w) => w.x0));
  const pageMaxX = Math.max(...withCenters.map((w) => w.x0 + (w.width || 0)));
  const edges = [pageMinX - 1, ...cuts, pageMaxX + 1];
  const spans = [];
  for (let i = 0; i < edges.length - 1; i++) {
    spans.push({ x0: edges[i], x1: edges[i + 1], count: 0 });
  }
  for (const w of withCenters) {
    const cx = w.x0 + (w.width || 0) / 2;
    for (const s of spans) {
      if (cx >= s.x0 && cx < s.x1) { s.count++; break; }
    }
  }
  const nonEmpty = spans.filter((s) => s.count > 0);
  return nonEmpty.length >= 2 ? nonEmpty : null;
}

// Row-clustering helper shared by detectColumnSpans (needs word-level
// grouping to compute each row's *internal* gaps) and joinWordsIntoLines
// (needs the same grouping to then join each row into one text line) -
// factored out so the y-tolerance clustering logic exists in exactly one
// place.
function groupIntoRows(wordList, medianHeight) {
  if (!wordList.length) return [];
  const yTolerance = Math.max(medianHeight * 0.6, 6);
  const sorted = [...wordList].sort((a, b) => a.yCenter - b.yCenter);
  const rows = [];
  let current = [];
  let currentY = null;
  for (const w of sorted) {
    if (current.length === 0 || Math.abs(w.yCenter - currentY) <= yTolerance) {
      current.push(w);
      currentY = current.reduce((s, x) => s + x.yCenter, 0) / current.length;
    } else {
      rows.push(current);
      current = [w];
      currentY = w.yCenter;
    }
  }
  if (current.length) rows.push(current);
  return rows;
}

// Assigns one word to the column span whose x-range contains its
// horizontal center; if it falls in a gap (an OCR box that slightly
// overshoots a gutter), snaps to whichever span edge is closer instead of
// being dropped.
function assignSpanIndex(word, spans) {
  const cx = word.x0 + (word.width || 0) / 2;
  for (let i = 0; i < spans.length; i++) {
    if (cx >= spans[i].x0 && cx <= spans[i].x1) return i;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const d = cx < spans[i].x0 ? spans[i].x0 - cx : cx - spans[i].x1;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Reconstructs a dense multi-column DA 3161 grid table (Item No / Stock
// No / Item Description / Unit / Quantity / Code / Supply Action / Unit
// Price / Total Cost, all in adjacent table columns on the same printed
// row) into the same per-field-per-line text shape parseFlatText's
// existing grammar already expects - so the well-tested state machine in
// da3161-parser.js needs no changes at all; only the OCR side needed to
// stop gluing columns together.
//
// Root cause this fixes (see phase4-findings.md's OCR-vs-real-scan
// writeup): the old single-stream reconstruction joined every word on a
// shared y-band left-to-right regardless of which table column it came
// from, so an item's number+MPO, its description, and its unit/qty/price
// summary - genuinely different table columns that happen to sit on the
// same visual row for a short item - all landed on one glued line, e.g.
// "+ 1 70153N EA 1 LT 1 815.00 815.00". Neither itemStartRe (expects just
// "<itemNo> <mpo>", nothing after) nor qtyLineRe (expects a line starting
// with "EA" and nothing before it) can ever match that.
//
// Fix: collapse the detected column spans into 3 logical zones - Zone A
// (Item No + Stock No, one or more leftmost spans), Zone C (Unit/Qty/
// Code/Action/Price/Total, one or more rightmost spans), Zone B
// (everything between - Item Description plus the "SN:"/serial list,
// which prints under whichever column it happens to visually land in).
// Zone A vs Zone C is the split that actually matters for grammar
// correctness: it's what keeps the item-start line free of trailing
// price/qty noise, and keeps the qty line free of leading description/
// serial noise. Zone B doesn't need finer separation - parseFlatText's
// marker-scanning already treats everything between the matnum line and
// the qty line as an unordered bag of description/serial lines.
//
// How many spans belong to Zone A vs Zone C isn't fixed - it depends on
// how finely detectColumnSpans happened to split the page (a coarser
// split might merge Item No and Stock No into one span; a finer one, as
// commonly happens on a clean scan, separates them into two). Rather than
// assume "exactly the first/last span," each zone is *grown* outward from
// its edge of the page, span by span, until the merged zone's own lines
// actually satisfy the grammar it's supposed to produce (itemStartRe for
// A, qtyLineRe for C) - self-calibrating to whatever granularity this
// particular page's column detection found.
//
// Item boundaries are found by scanning Zone A alone for itemStartRe
// matches (item numbers are always the leftmost column, so isolating Zone
// A first is what makes them findable at all - on the glued original
// line they're inseparable from the qty/price tail). Each other zone's
// lines are then attributed to whichever item's y-range they fall
// closest to (midpoint between consecutive item-start y-positions), and
// emitted in the fixed field order the grammar requires: Zone A's lines
// (item#+mpo, then matnum) first, then Zone B's lines (description/SN/
// serials, in original top-to-bottom order - order among these doesn't
// matter to the state machine), then Zone C's line(s) last (the qty/price
// summary, which must terminate the item).
//
// Falls back to the plain single-stream reconstruction (via the caller)
// if Zone A never matches itemStartRe at all - either this isn't really a
// grid page, or OCR was too noisy to read any item numbers, and a
// confidently-wrong grid parse would be worse than the old behavior.
// A real DA 3161's column-header row ("STOCK NO. | ITEM DESCRIPTION |
// QUANTITY | ... | UNIT PRICE | TOTAL COST", plus the "12. ITEM ..." line
// above it) reprints at the top of *every* page, not just the first. Item
// descriptions are free text and, in both real samples this was tested
// against, never contain the words "DESCRIPTION" and "QUANTITY" together -
// a real product name like "SMART SDC450 DOCUMENT CAMERA" doesn't - so
// that pairing is a reliable, narrow signal for "this line is page chrome,
// not item content." This matters specifically because of the "orphan"
// handling below: without filtering it out first, a continuation page's
// repeated header row sits in the exact same position (above that page's
// first item-start line) as genuine leftover serial-list content from a
// previous page, and would otherwise get glued into whichever item comes
// first on the page - confirmed on a real sample where an item's
// description ended up with the entire column-header text prepended.
function isHeaderBoilerplate(text) {
  const upper = text.toUpperCase();
  if (/DESCRIPTION/.test(upper) && /QUANTITY/.test(upper)) return true;
  if (/^\d{1,2}\.\s*ITEM\b/.test(upper)) return true;
  return false;
}

// Grows a zone inward from one edge of the page (left edge for Zone A,
// right edge for Zone C), span by span, stopping as soon as the merged
// zone's own reconstructed lines satisfy `testRe` on at least one line.
// Returns the number of spans claimed from that edge (0 if `testRe` never
// matched even merging every span but one - the caller treats that as
// "this zone doesn't exist on this page").
function growZoneSpanCount(withCenters, spans, medianHeight, fromLeft, testRe) {
  const order = fromLeft
    ? spans.map((_, i) => i)
    : spans.map((_, i) => spans.length - 1 - i);
  for (let n = 1; n <= spans.length - 1; n++) {
    const claimed = new Set(order.slice(0, n));
    const zoneWords = withCenters.filter((w) => claimed.has(assignSpanIndex(w, spans)));
    const lines = joinWordsIntoLines(zoneWords, medianHeight);
    if (lines.some((l) => testRe.test(l.text.trim()))) return n;
  }
  return 0;
}

// If a reconstructed line contains the "SN:"/"S/N:" serial-list marker
// partway through (not at the very start), splits it into two lines at
// that point. Needed because a real scan's Stock No. column sometimes
// prints the material number and the SN: annotation on the same visual
// line ("673001C923311 | sN: A102FW17A0999", confirmed on a real sample) -
// left glued together, that whole string would get consumed verbatim as
// the matnum field (parseFlatText takes "the next line after item-start"
// unconditionally as matnum, no marker-scanning on that specific line),
// silently losing the serial entirely instead of just misreading it.
// Splitting here, before parseFlatText ever sees the text, means the
// matnum line stays clean and the marker+serial portion becomes its own
// line where the existing marker-scanning loop finds it normally - no
// changes to parseFlatText itself. Also strips common trailing column-
// border OCR noise (stray "|") off the pre-marker portion.
function splitGluedMarkerLines(lines) {
  const marker = DA3161_CONFIG.serialListMarker;
  const out = [];
  for (const line of lines) {
    const m = marker.exec(line);
    if (m && m.index > 0) {
      const before = line.slice(0, m.index).replace(/[|,]+\s*$/, '').trim();
      const after = line.slice(m.index).trim();
      if (before) out.push(before);
      out.push(after);
    } else {
      out.push(line);
    }
  }
  return out;
}

// Locates the Item No column among the spans not already claimed by Zone
// C. Not simply "span 0": a real scan can have a narrow decorative/margin
// column (a printed "+" placeholder mark, a checkbox, a row-border
// artifact) sitting to the left of the actual item numbers, which would
// otherwise get mistaken for the leftmost real column - confirmed on a
// real sample where span 0 was consistently just a stray "+" and the
// clean sequential item numbers ("1","2","3"...) were actually in span 1.
// Tries each plausible narrow window near the left edge (1-2 adjacent
// spans, starting at each of the first few spans) and keeps whichever
// produces the most lines that look like a bare item number - the real
// column should win by a clear margin since it's the only one with
// several short numeric-only lines.
function findItemNoSpanIdx(withCenters, spans, medianHeight, excludeFromIdx) {
  const bareItemNoRe = /^\+?\s*-?\s*\d{1,3}\s*$/;
  let best = null;
  let bestCount = 1; // require at least 2 matches to accept a candidate
  const maxStart = Math.min(3, excludeFromIdx - 1);
  for (let start = 0; start <= maxStart; start++) {
    for (let width = 1; width <= 2 && start + width <= excludeFromIdx; width++) {
      const idxSet = new Set(Array.from({ length: width }, (_, i) => start + i));
      const zoneWords = withCenters.filter((w) => idxSet.has(assignSpanIndex(w, spans)));
      const lines = joinWordsIntoLines(zoneWords, medianHeight);
      const count = lines.filter((l) => bareItemNoRe.test(l.text.trim())).length;
      if (count > bestCount) { bestCount = count; best = idxSet; }
    }
  }
  return best;
}

function reconstructGridText(withCenters, spans, medianHeight) {
  const itemStartRe = DA3161_CONFIG.flatText.itemStartRe;
  const qtyLineRe = DA3161_CONFIG.flatText.qtyLineRe;
  const bareItemNoRe = /^\+?\s*-?\s*\d{1,3}\s*$/;

  const cCount = growZoneSpanCount(withCenters, spans, medianHeight, false, qtyLineRe);
  if (!cCount || cCount >= spans.length - 1) return null;
  const cSpanIdx = new Set(Array.from({ length: cCount }, (_, i) => spans.length - 1 - i));

  const aSpanIdx = findItemNoSpanIdx(withCenters, spans, medianHeight, spans.length - cCount);
  if (!aSpanIdx) return null;

  // Zone B is strictly *between* Zone A and Zone C - not simply "every
  // span neither claimed" - because a span to the left of Zone A can be
  // pure noise rather than real content (confirmed on a real sample: a
  // narrow decorative column of stray "+" marks sat to the left of the
  // actual item numbers). Letting that noise into Zone B was polluting
  // the same-row "mpo companion" search below - a line like "+ 70153N"
  // has two tokens, so it never matched the single-token check meant to
  // isolate a bare MPO, and no companion was ever found for any item.
  // Simplest fix: anything outside the [Zone A, Zone C] span range is
  // just dropped, not attributed to Zone B.
  const aMax = Math.max(...aSpanIdx);
  const cMin = Math.min(...cSpanIdx);
  const zoneAWords = withCenters.filter((w) => aSpanIdx.has(assignSpanIndex(w, spans)));
  const zoneBWords = withCenters.filter((w) => {
    const idx = assignSpanIndex(w, spans);
    return idx > aMax && idx < cMin;
  });
  const zoneCWords = withCenters.filter((w) => cSpanIdx.has(assignSpanIndex(w, spans)));

  const dropBoilerplate = (lines) => lines.filter((l) => !isHeaderBoilerplate(l.text));
  const zoneALines = dropBoilerplate(joinWordsIntoLines(zoneAWords, medianHeight));
  const zoneBLinesAll = dropBoilerplate(joinWordsIntoLines(zoneBWords, medianHeight));
  const zoneCLines = dropBoilerplate(joinWordsIntoLines(zoneCWords, medianHeight));

  const itemStartCandidates = [];
  zoneALines.forEach((line, idx) => {
    if (bareItemNoRe.test(line.text.trim())) itemStartCandidates.push(idx);
  });
  if (!itemStartCandidates.length) return null; // signal: not a usable grid page

  // Build each item's actual start line by borrowing the Zone B line that
  // shares its row (within normal line-clustering tolerance) as the mpo
  // companion - each Zone B line can only be borrowed once, so two items
  // can never accidentally claim the same content.
  const yTolerance = Math.max(medianHeight * 0.6, 6);
  const usedZoneBIdx = new Set();
  const itemStartLines = itemStartCandidates.map((idx) => {
    const aLine = zoneALines[idx];
    const itemNo = aLine.text.trim().replace(/[^\d]/g, '');
    let bestIdx = -1;
    let bestDist = Infinity;
    zoneBLinesAll.forEach((bLine, bIdx) => {
      if (usedZoneBIdx.has(bIdx) || /\s/.test(bLine.text.trim())) return; // mpo is one token
      const d = Math.abs(bLine.yCenter - aLine.yCenter);
      if (d <= yTolerance && d < bestDist) { bestDist = d; bestIdx = bIdx; }
    });
    let text = itemNo;
    if (bestIdx >= 0) {
      usedZoneBIdx.add(bestIdx);
      text = `${itemNo} ${zoneBLinesAll[bestIdx].text.trim()}`;
    }
    return { yCenter: aLine.yCenter, text };
  });

  // The synthesized line has to actually satisfy itemStartRe - if no
  // same-row companion was found for some item (noisy OCR on that one
  // row, or a bulk item like a 64-serial run whose row layout doesn't
  // follow the usual pattern), drop just that item rather than the whole
  // page: one unrecoverable item is a normal, tolerable loss (parseFlatText
  // already accepts imperfect OCR elsewhere - see flagLowConfidenceSerials);
  // discarding every *other* item on the page over one bad row would trade
  // a small, known gap for a much bigger one.
  const validItemStartLines = itemStartLines.filter((l) => itemStartRe.test(l.text));
  if (!validItemStartLines.length) return null;

  const zoneBLines = zoneBLinesAll.filter((_, bIdx) => !usedZoneBIdx.has(bIdx));

  const boundaries = validItemStartLines.map((l) => l.yCenter);
  // Block 0's lower bound is deliberately the same cutoff the "orphan"
  // window below uses as ITS upper bound (not -Infinity) - the two
  // windows must partition the page, not overlap it. An earlier version
  // of this used -Infinity for both, which double-counted: every Zone B/C
  // line above the first item-start got emitted once as orphan content
  // *and* again inside block 0's own range, duplicating that item's
  // description/serials outright (confirmed on a real sample page). The
  // tradeoff is that a first-on-page item whose own title prints slightly
  // above its item-start line loses that title line to the orphan bucket
  // instead - harmless when the orphan bucket is otherwise empty
  // (parseFlatText just skips unmatched lines while scanning for the next
  // itemStartRe match), and correct when the orphan bucket is genuinely a
  // previous page's unfinished item.
  //
  // The cutoff itself is boundaries[0] *minus one row's worth of
  // tolerance*, not boundaries[0] exactly: Zone A and Zone C get
  // line-clustered independently (see joinWordsIntoLines), so "the same
  // visual row" can come out with slightly different y-centers in each
  // zone (a fraction of a pixel to a few pixels apart) - confirmed on a
  // real sample where item 1's own qty/price line clustered to a y just
  // *below* item 1's item-start line's y, which without this margin
  // pushed it into the orphan bucket ahead of item 1 instead of into item
  // 1's own block, breaking that item's qty line entirely.
  const leadingCutoff = boundaries[0] - yTolerance;
  const blockStart = (i) => (i === 0 ? leadingCutoff : (boundaries[i - 1] + boundaries[i]) / 2);
  const blockEnd = (i) => (i === boundaries.length - 1 ? Infinity : (boundaries[i] + boundaries[i + 1]) / 2);
  const linesInRange = (lines, lo, hi) => lines.filter((l) => l.yCenter >= lo && l.yCenter < hi);

  const outLines = [];

  // Any Zone B/C content above this page's first item-start line belongs
  // to an item whose block began on a previous page (a long serial list
  // continuing across a page break, e.g. a 60+ serial run for one bulk
  // item) - emit it as-is, ahead of any block on this page, so it keeps
  // accumulating in parseFlatText's ongoing state machine (which runs
  // once over the whole multi-page joined text) instead of being dropped.
  const orphanLines = [
    ...linesInRange(zoneBLines, -Infinity, leadingCutoff),
    ...linesInRange(zoneCLines, -Infinity, leadingCutoff),
  ].sort((a, b) => a.yCenter - b.yCenter);
  for (const l of orphanLines) outLines.push(l.text);

  for (let i = 0; i < validItemStartLines.length; i++) {
    outLines.push(validItemStartLines[i].text);

    const lo = blockStart(i);
    const hi = blockEnd(i);
    for (const l of linesInRange(zoneBLines, lo, hi)) outLines.push(l.text);
    for (const l of linesInRange(zoneCLines, lo, hi)) outLines.push(l.text);
  }

  return splitGluedMarkerLines(outLines).join('\n');
}

// Groups Tesseract's word list into visual text lines and joins them into
// a single reconstructed text block, analogous to app.js's pdfToLines()
// but built from OCR bounding boxes (y0/y1/x0/x1 per word) instead of
// pdf.js glyph transforms.
//
// Column-aware since Phase 4's real-scan testing (see
// phase4-findings.md): a real DA 3161 is a dense bordered multi-column
// grid, not the single-column layout the original version of this
// function assumed, and naively joining every word on a shared row left-
// to-right regardless of table column glued unrelated fields together
// badly enough that parseFlatText extracted 0 rows from real scans.
// detectColumnSpans() looks for that grid structure page-wide; when it
// finds real column separation, reconstructGridText() rebuilds the text
// per-item using the zone logic documented on that function. When it
// doesn't (e.g. a genuinely single-column flattened form, or a grid page
// too noisy to locate any item numbers on), this falls back to exactly
// the original single-stream behavior - byte-for-byte the same as before
// this rewrite - so simple documents are unaffected.
//
// Returns { text, tokenConfidence } where tokenConfidence maps
// UPPERCASED word text -> lowest confidence seen for that exact word
// anywhere on the page (0-100, Tesseract's own scale), computed once over
// every word regardless of which reconstruction path ran. Used later to
// flag low-confidence serials without needing to duplicate parseFlatText's
// state machine.
function reconstructLinesFromWords(words) {
  if (!words || !words.length) return { text: '', tokenConfidence: {} };

  const withCenters = words
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({
      text: w.text,
      confidence: w.confidence,
      x0: w.bbox.x0,
      width: w.bbox.x1 - w.bbox.x0,
      yCenter: (w.bbox.y0 + w.bbox.y1) / 2,
      height: w.bbox.y1 - w.bbox.y0,
    }));
  if (!withCenters.length) return { text: '', tokenConfidence: {} };

  const heights = withCenters.map((w) => w.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;

  const tokenConfidence = {};
  for (const w of withCenters) {
    const key = w.text.toUpperCase();
    if (!(key in tokenConfidence) || w.confidence < tokenConfidence[key]) {
      tokenConfidence[key] = w.confidence;
    }
  }

  const spans = detectColumnSpans(withCenters, medianHeight);
  let text = null;
  if (spans && spans.length >= 2) {
    text = reconstructGridText(withCenters, spans, medianHeight);
  }
  if (text === null) {
    text = joinWordsIntoLines(withCenters, medianHeight).map((l) => l.text).join('\n');
  }

  return { text, tokenConfidence };
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

// Runs Tesseract's OSD (orientation and script detection) against one page
// image and returns the detected rotation. Real scanned multi-page forms
// aren't guaranteed to have every page fed into the scanner the same way -
// confirmed firsthand on a real scanned DA 3161 where page orientation
// alternated page-to-page (consistent with duplex/two-sided scanning), not
// just "the whole document is rotated once" - so this is called per page
// (see app.js's ocrPdf()), not once for the whole file.
//
// `orientationDegrees` follows Tesseract's own convention: rotate the
// image clockwise by this many degrees to make it upright. Only 0/90/180/
// 270 are meaningful values - OSD detects gross page orientation, not fine
// skew (a much smaller, separate problem this doesn't attempt to fix).
//
// OSD needs Tesseract's Legacy engine (the LSTM-only "fast" model used for
// the actual text recognition pass in recognizePage() above has no OSD
// support at all), so this points at a second, separately vendored core
// build (lib/vendor/tesseract-core-full/, Legacy-capable) and a dedicated
// osd.traineddata (lib/vendor/tessdata/osd.traineddata.gz) - both sourced
// from the same tesseract.js-core npm package already vendored for the
// main engine, still never fetched from a CDN.
async function detectOrientation(imageSource, vendorBaseUrl) {
  const TesseractLib = (typeof self !== 'undefined' && self.Tesseract) || (typeof window !== 'undefined' && window.Tesseract);
  if (!TesseractLib) throw new Error('Tesseract global not found - is lib/vendor/tesseract/tesseract.min.js loaded?');

  const base = vendorBaseUrl.endsWith('/') ? vendorBaseUrl : vendorBaseUrl + '/';
  const worker = await TesseractLib.createWorker('osd', 0, {
    workerPath: base + 'tesseract/worker.min.js',
    corePath: base + 'tesseract-core-full/',
    langPath: base + 'tessdata/',
    cacheMethod: 'none',
    logger: () => {},
  });
  try {
    const { data } = await worker.detect(imageSource);
    return {
      orientationDegrees: data.orientation_degrees,
      orientationConfidence: data.orientation_confidence,
    };
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
