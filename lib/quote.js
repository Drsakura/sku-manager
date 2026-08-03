const ExcelJS = require('exceljs');

/**
 * 报价单 / PI 生成。
 *
 * 铁律:**所有数字都在这里算,模型一个数都不碰。**
 * 模型顶多帮忙写英文品名和条款措辞(见 server 的 /api/quote/draft),
 * 那些是纯文本字段,用户能看能改;单价、金额、合计一律走下面的 computeLines。
 *
 * 报价单(quote)= 给国内客户的中文报价,人民币。
 * PI(proforma invoice)= 给国外客户的形式发票,通常美元 + 英文。
 */

const CURRENCIES = {
  CNY: { symbol: '¥', label: '人民币' },
  USD: { symbol: '$', label: '美元' },
  EUR: { symbol: '€', label: '欧元' },
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * 逐行算价。
 *
 * 单价链路:采购价(CNY) →(加价率)→ 售价(CNY) →(除汇率)→ 售价(外币)
 * 某行手填了售价就直接用手填的,不再套加价率 —— 手填的优先级最高。
 *
 * 金额先逐行取两位小数再相加,不是"先加总再取整" ——
 * 否则单据上每行金额加起来跟合计对不上,客户一核对就来问。
 */
function computeLines(rows, opts) {
  const markup = Number(opts.markup_pct) || 0;
  const fx = Number(opts.fx_rate) || 1;
  const foreign = opts.currency !== 'CNY';

  const lines = rows.map((r, i) => {
    const override = opts.prices && opts.prices[r.sku];
    const hasOverride = override !== undefined && override !== null && override !== '';

    let unit = null;
    if (hasOverride) {
      unit = round2(Number(override));
    } else if (r.price != null) {
      const cny = Number(r.price) * (1 + markup / 100);
      unit = round2(foreign ? cny / fx : cny);
    }

    const qty = Number(r.qty) || 0;
    const amount = unit == null ? null : round2(unit * qty);

    const name = r.product_name || r.display_sku || r.sku;
    const nameEn = (opts.names_en && opts.names_en[r.sku]) || '';

    return {
      no: i + 1,
      sku: r.display_sku || r.sku,
      name,
      name_en: nameEn,
      // PI 单据上用的品名。没起草英文名时**退回中文名** ——
      // 宁可客户看到中文,也不能发出去一份 DESCRIPTION 整列空白的形式发票。
      desc: nameEn || name,
      spec: r.spec || '',
      supplier: r.supplier_short || r.supplier_name || '',
      cost: r.price == null ? null : round2(r.price),
      moq: r.moq ?? null,
      qty,
      unit_price: unit,
      amount,
      note: r.note || '',
      priced: unit != null,
      // 报价数量低于起订量,单据上要标出来,不然客户下单了才发现做不了
      below_moq: r.moq != null && qty > 0 && qty < r.moq,
    };
  });

  const total = round2(lines.reduce((s, l) => s + (l.amount || 0), 0));
  return {
    lines,
    total,
    total_qty: lines.reduce((s, l) => s + l.qty, 0),
    unpriced: lines.filter((l) => !l.priced).length,
    missing_qty: lines.filter((l) => !l.qty).length,
    below_moq: lines.filter((l) => l.below_moq).map((l) => l.sku),
  };
}

function buildQuote(rows, opts = {}) {
  const currency = CURRENCIES[opts.currency] ? opts.currency : 'CNY';
  const o = { ...opts, currency };
  const calc = computeLines(rows, o);
  return {
    ...calc,
    docType: opts.doc_type === 'pi' ? 'pi' : 'quote',
    currency,
    symbol: CURRENCIES[currency].symbol,
    meta: {
      customer: String(opts.customer || '').trim(),
      doc_no: String(opts.doc_no || '').trim(),
      date: String(opts.date || '').trim() || new Date().toISOString().slice(0, 10),
      validity: String(opts.validity || '').trim(),
      lead_time: String(opts.lead_time || '').trim(),
      payment_terms: String(opts.payment_terms || '').trim(),
      trade_terms: String(opts.trade_terms || '').trim(),
      remarks: String(opts.remarks || '').trim(),
      markup_pct: Number(opts.markup_pct) || 0,
      fx_rate: Number(opts.fx_rate) || 1,
    },
  };
}

/* ------------------------------- Excel 输出 ------------------------------- */

const QUOTE_COLS = [
  { key: 'no', header: '序号', width: 6 },
  { key: 'sku', header: '货号', width: 18 },
  { key: 'name', header: '品名', width: 30 },
  { key: 'spec', header: '规格', width: 22 },
  { key: 'qty', header: '数量', width: 10 },
  { key: 'unit_price', header: '单价', width: 13 },
  { key: 'amount', header: '金额', width: 15 },
  { key: 'note', header: '备注', width: 22 },
];

const PI_COLS = [
  { key: 'no', header: 'NO.', width: 6 },
  { key: 'sku', header: 'ITEM NO.', width: 18 },
  { key: 'desc', header: 'DESCRIPTION', width: 34 },
  { key: 'spec', header: 'SPECIFICATION', width: 22 },
  { key: 'qty', header: 'QTY', width: 10 },
  { key: 'unit_price', header: 'UNIT PRICE', width: 14 },
  { key: 'amount', header: 'AMOUNT', width: 16 },
  { key: 'note', header: 'REMARKS', width: 22 },
];

const THIN = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function renderWorkbook(q) {
  const pi = q.docType === 'pi';
  const cols = pi ? PI_COLS : QUOTE_COLS;
  const L = pi
    ? { title: 'PROFORMA INVOICE', customer: 'MESSRS', no: 'INVOICE NO.', date: 'DATE',
        total: 'TOTAL', validity: 'VALIDITY', lead: 'DELIVERY TIME', pay: 'PAYMENT',
        trade: 'TRADE TERMS', remarks: 'REMARKS' }
    : { title: '报 价 单', customer: '客户', no: '报价单号', date: '日期',
        total: '合计', validity: '报价有效期', lead: '交货期', pay: '付款方式',
        trade: '贸易条款', remarks: '备注' };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'sku-manager';
  const ws = wb.addWorksheet(pi ? 'PI' : '报价单');
  const last = cols.length;
  const colLetter = (n) => String.fromCharCode(64 + n);
  const span = (row) => `A${row}:${colLetter(last)}${row}`;

  ws.mergeCells(span(1));
  const title = ws.getCell('A1');
  title.value = L.title;
  title.font = { size: 16, bold: true };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 30;

  // 抬头:左边客户,右边单号/日期。空字段整行省掉,不留一排空格子。
  const head = [
    [`${L.customer}: ${q.meta.customer || ''}`, `${L.no}: ${q.meta.doc_no || ''}`],
    ['', `${L.date}: ${q.meta.date}`],
  ];
  let r = 2;
  for (const [left, right] of head) {
    ws.mergeCells(`A${r}:${colLetter(Math.ceil(last / 2))}${r}`);
    ws.getCell(`A${r}`).value = left;
    ws.mergeCells(`${colLetter(Math.ceil(last / 2) + 1)}${r}:${colLetter(last)}${r}`);
    ws.getCell(`${colLetter(Math.ceil(last / 2) + 1)}${r}`).value = right;
    r += 1;
  }
  r += 1;

  const headerRow = r;
  ws.getRow(headerRow).values = cols.map((c) => c.header);
  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
    const cell = ws.getRow(headerRow).getCell(i + 1);
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2EFE8' } };
    cell.border = BORDER;
  });
  ws.getRow(headerRow).height = 22;

  const numFmt = q.currency === 'CNY' ? '#,##0.00' : '#,##0.00';
  for (const l of q.lines) {
    r += 1;
    const row = ws.getRow(r);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = l[c.key] ?? '';
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', wrapText: c.key === 'name' || c.key === 'desc' };
      if (c.key === 'unit_price' || c.key === 'amount') {
        cell.numFmt = numFmt;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        if (l[c.key] == null) cell.value = '';
      }
      if (c.key === 'no' || c.key === 'qty') {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });
  }

  // 合计行
  r += 1;
  const totalRow = ws.getRow(r);
  const amountIdx = cols.findIndex((c) => c.key === 'amount') + 1;
  ws.mergeCells(`A${r}:${colLetter(amountIdx - 1)}${r}`);
  const label = ws.getCell(`A${r}`);
  label.value = `${L.total} (${q.currency})`;
  label.font = { bold: true };
  label.alignment = { horizontal: 'right', vertical: 'middle' };
  const totalCell = totalRow.getCell(amountIdx);
  totalCell.value = q.total;
  totalCell.numFmt = numFmt;
  totalCell.font = { bold: true };
  totalCell.alignment = { horizontal: 'right', vertical: 'middle' };
  for (let i = 1; i <= last; i += 1) totalRow.getCell(i).border = BORDER;

  // 条款:有内容才写,空的不占行
  const terms = [
    [L.validity, q.meta.validity],
    [L.lead, q.meta.lead_time],
    [L.pay, q.meta.payment_terms],
    [L.trade, q.meta.trade_terms],
    [L.remarks, q.meta.remarks],
  ].filter(([, v]) => v);

  if (terms.length) r += 1;
  for (const [k, v] of terms) {
    r += 1;
    ws.mergeCells(span(r));
    const cell = ws.getCell(`A${r}`);
    cell.value = `${k}: ${v}`;
    cell.alignment = { vertical: 'top', wrapText: true };
  }

  return wb;
}

/** 文件名:客户_单号_日期,缺哪块就跳过哪块,不留下划线开头的怪名字。 */
function fileBase(q) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return [q.docType === 'pi' ? 'PI' : '报价单', q.meta.customer, q.meta.doc_no || stamp]
    .filter(Boolean)
    .join('_')
    .replace(/[\\/:*?"<>|]/g, '-');
}

module.exports = { buildQuote, computeLines, renderWorkbook, fileBase, CURRENCIES };
