// DA 3161 field-name / pattern configuration.
//
// Isolated per the project outline's Phase 1 requirement: if a future DA
// 3161 template revision renames fields, this is the one place to update -
// the parsing logic in da3161-parser.js should not need to change.
//
// Every name/pattern here is ported directly from the reference Python
// script (parse_da3161_transfers.py) to keep behavior identical.

// `var` (not `const`) deliberately: top-level `var`/`function` become
// properties of the global object in both a classic <script> in a browser
// and Node's `vm` module, whereas `const`/`let` do not. Several other
// pieces of this codebase (browser harness, Node test driver) read this
// off the global/sandbox object by name, so it needs to actually attach.
var DA3161_CONFIG = {
  // XFA <Item> child element names (unprefixed, "no namespace" - see
  // phase0 findings for why plain tag-name lookups work here).
  fields: {
    itemNo: 'Item_No',
    stockNumber: 'Stock_Number',
    itemDescription: 'Item_Description',
    quantity: 'Quantity',
  },

  // XFA rich-text fields (Stock_Number, Item_Description) wrap their
  // content in an XHTML <body> with one <p> per line. This namespace is
  // declared explicitly in the source XML but, same as above, plain
  // tag-name lookups (getElementsByTagName) work fine without needing the
  // namespace URI.
  xhtml: {
    bodyTag: 'body',
    paragraphTag: 'p',
  },

  // Marks the start of the serial-number list within an Item_Description's
  // text lines. Originally just /SN:\s*/i, matching the Python reference
  // script's re.search(r"SN:\s*", ..., re.IGNORECASE) exactly. Broadened
  // after a real-world sample (305th->309th transfer) turned up "S/N:" as
  // a second, equally common marker the Python reference itself never
  // handled either (checked - same regex there, same gap) - this is a
  // deliberate improvement beyond strict Python parity, not a JS porting
  // bug. The slash is optional so both spellings match one pattern:
  // "SN: 123, 456" and "S/N: 123, 456" both split correctly. Still
  // requires the trailing colon - every real instance found so far
  // (Walker, Davis Hall, and this new sample) uses one, so widening
  // further than that is speculative until a real counter-example shows
  // up. If a future file has a description/serial-list boundary that
  // doesn't match either spelling, that's exactly the kind of ambiguous
  // case worth surfacing to a person rather than silently guessing at a
  // new pattern.
  serialListMarker: /S\/?N:\s*/i,

  // Flat-text fallback (non-XFA PDFs) line grammar - ported verbatim from
  // the Python script's ITEM_START_RE / QTY_LINE_RE. These assume
  // `pdftotext -layout`-style column alignment; pdf.js's getTextContent()
  // output may need retuning against a real flattened sample (see Phase 1
  // findings - unverified against a real non-XFA DA 3161 as of this port).
  flatText: {
    itemStartRe: /^\+?\s*-?\s*[▲]?\s*[▼]?\s*(\d{1,3})\s+(\S+)\s*$/,
    qtyLineRe: /^EA\s+(\d+)\s+[A-Z]{2,3}\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/,
  },

  // CSV output column order. Quantity was added after the first four
  // columns were already established - see da3161-parser.js's row-building
  // comments for why it's appended at the end rather than inserted earlier
  // (keeps every existing row[3]/row[4] positional reference, e.g. in
  // ocr.js and the test suites, pointing at Serial_Number/Location
  // unchanged).
  csvHeader: ['MPO', 'Material_Number', 'Material_Description', 'Serial_Number', 'Location', 'Quantity'],
};
