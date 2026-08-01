const path = require('path');
const { parseExcel } = require('./excel');
const { parsePdfText, parseTextToRows } = require('./pdfText');

async function parseContract(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    const { rows, columnReport, contractTerms } = await parseExcel(filePath);
    return { fileType: 'excel', rows, columnReport, contractTerms };
  }

  if (ext === '.pdf') {
    const { scanned, rows, columnReport, contractTerms } = await parsePdfText(filePath);
    if (!scanned) {
      return { fileType: 'pdf-text', rows, columnReport, contractTerms };
    }
    // 只有在 PDF 完全取不到文字时才走 OCR;
    // pdfjs-dist + tesseract.js 比较重,按需加载。
    const { pdfToText } = require('./pdfScan');
    const text = await pdfToText(filePath);
    const ocr = parseTextToRows(text, 'low');
    return {
      fileType: 'pdf-scan',
      rows: ocr.rows,
      columnReport: 'OCR 识别后按文本行猜列',
      contractTerms: ocr.contractTerms,
    };
  }

  throw new Error(`不支持的文件格式: ${ext}`);
}

module.exports = { parseContract };
