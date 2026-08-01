const ExcelJS = require('exceljs');
const {
  parseNumber, cellText, findHeaderRow, guessNameColumn,
  looksLikeSku, isSanePrice, refineSkuColumn,
} = require('../lib/normalize');
const { extractDescriptions } = require('./descriptions');

const COLUMN_LABEL = { sku: '型号', name: '品名', price: '单价', moq: '起订量' };

function colLetter(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 把识别到的列翻译成人话,导入结果里显示给用户,让"没识别到"变得可诊断。 */
function describeMap(map, guessedName) {
  return ['sku', 'name', 'price', 'moq']
    .map((f) => {
      if (map[f] === undefined) return `${COLUMN_LABEL[f]}=未找到`;
      const suffix = f === 'name' && guessedName ? '(推测)' : '';
      return `${COLUMN_LABEL[f]}=${colLetter(map[f])}列${suffix}`;
    })
    .join(' · ');
}

function sheetToRows(sheet) {
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(row.values.slice(1));
  });
  return rows;
}

/**
 * 把一行拼成一句话。合并单元格在 exceljs 里会把同一个值重复到每一列,
 * 所以要去重,否则条款文字会变成同一句话重复九遍。
 */
function rowToProse(row) {
  const seen = new Set();
  const parts = [];
  for (const cell of row) {
    const t = cellText(cell).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(t);
  }
  return parts.join(' ').trim();
}

async function parseExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const rows = [];
  const columnReports = [];
  const proseLines = [];

  for (const sheet of workbook.worksheets) {
    const grid = sheetToRows(sheet);
    if (!grid.length) continue;

    const header = findHeaderRow(grid);
    if (!header) continue;

    const map = { ...header.map };
    const dataRows = grid.slice(header.rowIndex + 1);
    const colCount = Math.max(...grid.map((r) => r.length), 0);

    refineSkuColumn(grid[header.rowIndex] || [], dataRows, map);

    let guessedName = false;
    if (map.name === undefined) {
      const guess = guessNameColumn(dataRows, new Set(Object.values(map)), colCount);
      if (guess !== undefined) {
        map.name = guess;
        guessedName = true;
      }
    }

    let count = 0;
    let skipped = 0;
    for (const row of dataRows) {
      const skuRaw = cellText(row[map.sku]).trim();
      const price = parseNumber(row[map.price]);

      // 表格下方的条款/说明段落长得像数据行,不能当产品,
      // 但它们正是「交付标准与要求」的原文,收起来另作处理
      if (!skuRaw || !looksLikeSku(skuRaw) || !isSanePrice(price)) {
        const text = rowToProse(row);
        if (text) proseLines.push(text);
        if (skuRaw && price !== null) skipped++;
        continue;
      }

      const name = map.name !== undefined ? cellText(row[map.name]).trim() : '';
      const moq = map.moq !== undefined ? parseNumber(row[map.moq]) : null;

      rows.push({
        sku: skuRaw,
        price,
        moq: moq !== null && moq > 0 ? Math.round(moq) : null,
        name: name || null,
        confidence: 'high',
      });
      count++;
    }

    const skipNote = skipped ? ` · 跳过 ${skipped} 行非产品内容` : '';
    columnReports.push(`${sheet.name}: ${describeMap(map, guessedName)} → ${count} 行${skipNote}`);
  }

  const { bySku, contractTerms } = extractDescriptions(
    proseLines,
    rows.map((r) => r.sku)
  );
  for (const row of rows) {
    if (bySku[row.sku]) row.description = bySku[row.sku];
  }

  return { rows, columnReport: columnReports.join(' | '), contractTerms };
}

module.exports = { parseExcel, describeMap, colLetter };
