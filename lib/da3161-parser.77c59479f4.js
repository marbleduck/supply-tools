// Phase 1: port of parse_da3161_transfers.py's parsing logic to JS.
//
// This is a line-by-line port, not a from-scratch reimplementation - see
// da3161-config.js for field names/patterns pulled out of the logic below,
// per the outline's requirement. Every helper here has a direct Python
// counterpart (named in each comment) and was validated by diffing JS
// output against the reference script's own output (not just against the
// pre-supplied known-good CSVs) for both the Walker and Davis Hall sets -
// see phase1-findings.md.
//
// Plain classic script (no import/export) - same file:// CORS reasoning as
// phase0's harness. Depends on: DA3161_CONFIG (da3161-config.js), and
// extractXfaDatasets/PdfFile (pdf-xfa-parser.js) for the XFA path.

// ---------------------------------------------------------------------
// Serial-list repair helpers (Python: raw_tokens / fix_concat /
// merge_broken / clean_serials)
// ---------------------------------------------------------------------

// Python: re.split(r"[,\s]+", text)
function rawTokens(text) {
  return text.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
}

// Python: Counter(len(t) for t in tokens).most_common(1)[0][0]
// Ties broken by first-seen length, matching CPython's stable
// Counter.most_common() ordering (dict/Counter preserve insertion order).
function dominantLength(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t.length, (counts.get(t.length) || 0) + 1);
  let bestLen = null, bestCount = -1;
  for (const [len, cnt] of counts) {
    if (cnt > bestCount) { bestCount = cnt; bestLen = len; }
  }
  return bestLen;
}

// Python: fix_concat(tokens, common_len)
function fixConcat(tokens, commonLen) {
  const fixed = [];
  for (const t of tokens) {
    if (commonLen && t.length === commonLen * 2) {
      const half = Math.floor(t.length / 2);
      fixed.push(t.slice(0, half));
      fixed.push(t.slice(half));
    } else {
      fixed.push(t);
    }
  }
  return fixed;
}

// Python: merge_broken(tokens, common_len)
function mergeBroken(tokens, commonLen) {
  const merged = [];
  let buffer = [], bufLen = 0;
  for (const t of tokens) {
    if (commonLen && t.length === commonLen) {
      if (buffer.length) {
        merged.push(buffer.join(' ')); // leftover, flush as anomaly
        buffer = []; bufLen = 0;
      }
      merged.push(t);
    } else {
      buffer.push(t);
      bufLen += t.length;
      if (commonLen && bufLen === commonLen) {
        merged.push(buffer.join(' '));
        buffer = []; bufLen = 0;
      }
    }
  }
  if (buffer.length) merged.push(buffer.join(' '));
  return merged;
}

// Python: clean_serials(raw_text) -> (serials, anomalies)
function cleanSerials(rawText) {
  let tokens = rawTokens(rawText);
  if (!tokens.length) return { serials: [], anomalies: [] };
  const commonLen = dominantLength(tokens);
  tokens = fixConcat(tokens, commonLen);
  tokens = mergeBroken(tokens, commonLen);
  const anomalies = tokens.filter(t => t.includes(' '));
  return { serials: tokens, anomalies };
}

// ---------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------

// Python's lxml `.find("Tag")` only searches direct children - match that
// exactly rather than using getElementsByTagName (which would also match
// same-named descendants, which .find() would not).
function directChild(el, tagName) {
  if (!el) return null;
  for (const child of el.children) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

function directChildren(el, tagName) {
  if (!el) return [];
  return [...el.children].filter(c => c.tagName === tagName);
}

// Python's `.find(f".//{ns}body")` - first body anywhere in the subtree.
function firstDescendant(el, tagName) {
  if (!el) return null;
  const found = el.getElementsByTagName(tagName);
  return found.length ? found[0] : null;
}

// ---------------------------------------------------------------------
// Path 1: XFA <Item> parsing (Python: parse_xfa_datasets)
// ---------------------------------------------------------------------

function parseXfaDatasets(xmlText, location) {
  const rows = [], mismatches = [], anomalies = [];
  const F = DA3161_CONFIG.fields;
  const X = DA3161_CONFIG.xhtml;

  // parseXmlLite (xml-lite.js), not the browser's DOMParser: DOMParser is a
  // DOM API and does not exist inside a Web Worker, and this function needs
  // to run in worker.js. parseXmlLite throws on malformed XML directly
  // (no separate parsererror element to check for, unlike DOMParser).
  const doc = parseXmlLite(xmlText);

  const items = [...doc.getElementsByTagName('Item')];
  for (const item of items) {
    const itemNoEl = directChild(item, F.itemNo);
    const itemNo = itemNoEl && itemNoEl.textContent ? itemNoEl.textContent : '';

    // --- Stock Number: two lines, MPO then Material Number ---
    let mpo = '', matnum = '';
    const stockEl = directChild(item, F.stockNumber);
    if (stockEl) {
      const body = firstDescendant(stockEl, X.bodyTag);
      if (body) {
        const texts = directChildren(body, X.paragraphTag)
          .map(p => p.textContent.trim())
          .filter(Boolean);
        if (texts.length >= 1) mpo = texts[0];
        if (texts.length >= 2) matnum = texts[1];
      }
    }

    // --- Item Description: description lines + "SN: ..." serial list ---
    const descLines = [], serialTextParts = [];
    const descEl = directChild(item, F.itemDescription);
    if (descEl) {
      const body = firstDescendant(descEl, X.bodyTag);
      if (body) {
        let collecting = false;
        for (const p of directChildren(body, X.paragraphTag)) {
          const text = p.textContent.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const m = DA3161_CONFIG.serialListMarker.exec(text);
          if (m) {
            const before = text.slice(0, m.index).trim();
            const after = text.slice(m.index + m[0].length).trim();
            if (before && !collecting) descLines.push(before);
            collecting = true;
            if (after) serialTextParts.push(after);
          } else if (collecting) {
            serialTextParts.push(text);
          } else {
            descLines.push(text);
          }
        }
      }
    }
    const materialDesc = descLines.join('\n');

    const qtyEl = directChild(item, F.quantity);
    let qtyNum = null;
    if (qtyEl && qtyEl.textContent) {
      const parsed = parseFloat(qtyEl.textContent);
      if (!Number.isNaN(parsed)) qtyNum = Math.trunc(parsed);
    }

    if (!mpo && !matnum && !descLines.length && !serialTextParts.length) {
      continue; // empty placeholder row in the form template
    }

    const { serials, anomalies: itemAnomalies } = cleanSerials(serialTextParts.join(' '));

    // Quantity column (appended after Location, not inserted earlier in
    // the row - every existing row[3]/row[4] reference elsewhere in this
    // codebase, ocr.js's low-confidence-serial flagging included, assumes
    // Serial_Number/Location stay at indices 3/4, so a new column has to
    // go at the end to avoid silently breaking those). Each serialized
    // row represents exactly one physical item, hence quantity 1; the
    // single row generated when no serials were found at all instead
    // reports the raw XFA Quantity value, since that's the only quantity
    // information available for that item. If Quantity itself is missing/
    // unparseable in the source (qtyNum stays null), this is left blank
    // rather than guessing - consistent with how MPO/Material_Number stay
    // blank elsewhere when genuinely absent from the source.
    let nGenerated;
    if (serials.length) {
      for (const sn of serials) rows.push([mpo, matnum, materialDesc, sn, location, 1]);
      nGenerated = serials.length;
    } else {
      rows.push([mpo, matnum, materialDesc, '', location, qtyNum !== null ? qtyNum : '']);
      nGenerated = 1;
    }

    if (qtyNum !== null && qtyNum !== nGenerated) {
      const firstDescLine = materialDesc ? materialDesc.split('\n')[0] : '';
      mismatches.push(
        `${location} Item ${itemNo} (${firstDescLine}): qty=${qtyNum} generated=${nGenerated} serials=[${serials.map(s => `'${s}'`).join(', ')}]`
      );
    }
    for (const sn of itemAnomalies) {
      anomalies.push(`${location} Item ${itemNo}: anomalous serial text as found in source: "${sn}"`);
    }
  }

  return { rows, mismatches, anomalies };
}

// ---------------------------------------------------------------------
// Path 2: flat / non-XFA PDF fallback (Python: parse_flat_text)
// ---------------------------------------------------------------------

function parseFlatText(text, location) {
  const rows = [], mismatches = [], anomalies = [];
  const { itemStartRe, qtyLineRe } = DA3161_CONFIG.flatText;

  const lines = text.split(/\r\n|\r|\n/).map(l => l.replace(/\s+$/, ''));
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const m = itemStartRe.exec(lines[i].trim());
    if (!m) { i++; continue; }
    const itemNo = m[1], mpo = m[2];
    i++;
    if (i >= n) break;
    const matnum = lines[i].trim();
    i++;

    const descLines = [], serialTextParts = [];
    let collecting = false;
    let qtyNum = null;
    while (i < n) {
      const stripped = lines[i].trim();
      const qm = qtyLineRe.exec(stripped);
      if (qm) {
        qtyNum = parseInt(qm[1], 10);
        i++;
        break;
      }
      if (!stripped) { i++; continue; }
      const sm = DA3161_CONFIG.serialListMarker.exec(stripped);
      if (sm) {
        const before = stripped.slice(0, sm.index).trim();
        const after = stripped.slice(sm.index + sm[0].length).trim();
        if (before && !collecting) descLines.push(before);
        collecting = true;
        if (after) serialTextParts.push(after);
      } else if (collecting) {
        serialTextParts.push(stripped);
      } else {
        descLines.push(stripped);
      }
      i++;
    }

    const materialDesc = descLines.join('\n');
    if (!mpo && !matnum && !descLines.length) continue;

    const { serials, anomalies: itemAnomalies } = cleanSerials(serialTextParts.join(' '));

    // Same Quantity-column convention as parseXfaDatasets above - see that
    // function's comment for the full reasoning (append-only column
    // ordering, 1 per serialized row, raw qty when no serials found).
    let nGenerated;
    if (serials.length) {
      for (const sn of serials) rows.push([mpo, matnum, materialDesc, sn, location, 1]);
      nGenerated = serials.length;
    } else {
      rows.push([mpo, matnum, materialDesc, '', location, qtyNum !== null ? qtyNum : '']);
      nGenerated = 1;
    }

    if (qtyNum !== null && qtyNum !== nGenerated) {
      const firstDescLine = materialDesc ? materialDesc.split('\n')[0] : '';
      mismatches.push(
        `${location} Item ${itemNo} (${firstDescLine}): qty=${qtyNum} generated=${nGenerated} serials=[${serials.map(s => `'${s}'`).join(', ')}]`
      );
    }
    for (const sn of itemAnomalies) {
      anomalies.push(`${location} Item ${itemNo}: anomalous serial text as found in source: "${sn}"`);
    }
  }

  return { rows, mismatches, anomalies };
}

// ---------------------------------------------------------------------
// CSV generation (Python: csv.writer - QUOTE_MINIMAL default behavior)
// ---------------------------------------------------------------------

function csvField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(header, rows) {
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  // Python's csv.writer terminates every row with \r\n by default.
  return lines.join('\r\n') + '\r\n';
}
