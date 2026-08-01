const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const {
  parseNumber, cellText, findHeaderRow, guessNameColumn,
  looksLikeSku, isSanePrice, refineSkuColumn,
} = require('../lib/normalize');
const { describeMap } = require('./excel');
const { extractDescriptions } = require('./descriptions');

const SKU_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9][A-Za-z0-9\-\/.]{3,23}$/;
const PRICE_RE = /^[¥$￥]?\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,4})?$/;

// 兜底方案:PDF 有文字但表格结构对不齐时,按制表符/多空格切列再猜。
// 置信度只给 medium —— 列错位时可能挑到错误的数字。
function parseLine(line, confidence) {
  const cols = line.trim().split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
  if (cols.length < 2) return null;

  let sku = null;
  let skuIdx = -1;
  const candidates = [];

  cols.forEach((clean, i) => {
    if (sku === null && looksLikeSku(clean) && /\d/.test(clean) && SKU_RE.test(clean)) {
      sku = clean;
      skuIdx = i;
      return;
    }
    if (PRICE_RE.test(clean)) {
      const n = parseNumber(clean);
      if (n === null) return;
      candidates.push({
        n,
        // 带货币符号或小数点的更像单价;光秃秃的整数往往是数量
        currency: /[¥$￥]/.test(clean),
        decimal: /\.\d/.test(clean),
      });
    }
  });

  if (!sku || !candidates.length) return null;

  const priced =
    candidates.find((c) => c.currency) ||
    candidates.find((c) => c.decimal) ||
    candidates[0];
  if (!isSanePrice(priced.n)) return null;

  // 首列若是中文文字且不是货号,基本就是品名
  const first = cols[0];
  const name =
    skuIdx !== 0 && !PRICE_RE.test(first) && /[一-龥]/.test(first) ? first : null;

  // MOQ 故意留空:这条路径下剩余的整数通常是合同数量,不是起订量,
  // 猜错比留空更糟 —— 报价时会按错误的起订量算。
  return { sku, price: priced.n, moq: null, name, confidence };
}

function parseTextToRows(text, confidence) {
  const rows = [];
  const proseLines = [];
  for (const line of text.split('\n')) {
    const parsed = parseLine(line, confidence);
    if (parsed) rows.push(parsed);
    else if (line.trim()) proseLines.push(line);
  }

  const { bySku, contractTerms } = extractDescriptions(proseLines, rows.map((r) => r.sku));
  for (const row of rows) {
    if (bySku[row.sku]) row.description = bySku[row.sku];
  }

  return { rows, contractTerms };
}

/**
 * PDF 里有真实表格结构时(多数电子版采购合同/订单导出件都有),
 * 走和 Excel 完全相同的表头识别逻辑,准确度高得多,置信度给 high。
 */
function rowsFromTable(table) {
  if (!table || table.length < 2) return null;

  const header = findHeaderRow(table, Math.min(table.length, 10));
  if (!header) return null;

  const map = { ...header.map };
  const dataRows = table.slice(header.rowIndex + 1);
  const colCount = Math.max(...table.map((r) => r.length), 0);

  refineSkuColumn(table[header.rowIndex] || [], dataRows, map);

  let guessedName = false;
  if (map.name === undefined) {
    const guess = guessNameColumn(dataRows, new Set(Object.values(map)), colCount);
    if (guess !== undefined) {
      map.name = guess;
      guessedName = true;
    }
  }

  const rows = [];
  for (const row of dataRows) {
    const skuRaw = cellText(row[map.sku]).trim();
    const price = parseNumber(row[map.price]);
    if (!skuRaw || !looksLikeSku(skuRaw) || !isSanePrice(price)) continue;

    const name = map.name !== undefined ? cellText(row[map.name]).trim() : '';
    const moq = map.moq !== undefined ? parseNumber(row[map.moq]) : null;

    rows.push({
      sku: skuRaw,
      price,
      moq: moq !== null && moq > 0 ? Math.round(moq) : null,
      name: name || null,
      confidence: 'high',
    });
  }

  return rows.length ? { rows, report: describeMap(map, guessedName) } : null;
}

async function parsePdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText();
    const text = textResult.text || '';

    if (text.trim().length < 40) {
      return { scanned: true, rows: [], columnReport: '' };
    }

    const tableResult = await parser.getTable().catch(() => null);
    const tableRows = [];
    const reports = [];
    if (tableResult) {
      for (const page of tableResult.pages || []) {
        for (const table of page.tables || []) {
          const parsed = rowsFromTable(table);
          if (parsed) {
            tableRows.push(...parsed.rows);
            reports.push(parsed.report);
          }
        }
      }
    }

    if (tableRows.length > 0) {
      // 表格已单独解析,条款文字仍要从全文里取(它们在表格之外)
      const { bySku, contractTerms } = extractDescriptions(
        text.split('\n').filter((l) => l.trim()),
        tableRows.map((r) => r.sku)
      );
      for (const row of tableRows) {
        if (bySku[row.sku]) row.description = bySku[row.sku];
      }
      return { scanned: false, rows: tableRows, columnReport: reports[0] || '', contractTerms };
    }

    const { rows, contractTerms } = parseTextToRows(text, 'medium');
    return {
      scanned: false,
      rows,
      columnReport: '未检测到表格结构,按文本行猜列',
      contractTerms,
    };
  } finally {
    await parser.destroy();
  }
}

module.exports = { parsePdfText, parseTextToRows };
