const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { PDFParse } = require('pdf-parse');
const { cellText } = require('../lib/normalize');

/**
 * 取文件的纯文本。两个用途:
 *   1. 喂给本地模型解析
 *   2. 作为"原文",校验模型输出的每个型号和价格是否真实存在
 * 所以必须尽量完整,不做任何清洗或过滤。
 */
async function extractRawText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const out = [];
    for (const sheet of wb.worksheets) {
      out.push(`### ${sheet.name}`);
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const seen = new Set();
        const cells = [];
        for (const cell of row.values.slice(1)) {
          const t = cellText(cell).trim();
          // 合并单元格会把同一个值重复到每一列,去重后才不会刷屏
          if (!t || seen.has(t)) continue;
          seen.add(t);
          cells.push(t);
        }
        if (cells.length) out.push(cells.join('\t'));
      });
    }
    return out.join('\n');
  }

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    try {
      const r = await parser.getText();
      return r.text || '';
    } finally {
      await parser.destroy();
    }
  }

  throw new Error(`不支持的文件格式: ${ext}`);
}

module.exports = { extractRawText };
