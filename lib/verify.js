const { normalizeSku, isSanePrice } = require('./normalize');

/**
 * 校验 AI 提取的每一行是否真的出现在原文里。
 *
 * 这是整套 AI 方案的安全底线:模型偶尔会把 ¥102.00 看成 ¥120.00,
 * 而这个工具的全部意义就是防止报错价。所以型号和价格必须能在原文中
 * 逐字找到,否则宁可丢弃 —— 少一条数据可以人工补,报错一次价补不回来。
 */

/** 归一化后比对,便于跨排版匹配(去掉空白和常见分隔符)。 */
function normalizeHaystack(text) {
  return String(text || '').toUpperCase().replace(/[\s\-_./,]/g, '');
}

/**
 * 某个数字是否在原文出现过。允许多种写法:
 * 102 / 102.00 / ¥102.00 / 1,020.50
 */
function numberAppears(value, rawText) {
  if (!Number.isFinite(value)) return false;
  const compact = String(rawText || '').replace(/[\s,¥￥$]/g, '');

  const candidates = new Set([String(value)]);
  if (Number.isInteger(value)) {
    candidates.add(value.toFixed(1));
    candidates.add(value.toFixed(2));
  } else {
    candidates.add(value.toFixed(2));
    candidates.add(value.toFixed(3));
    candidates.add(value.toFixed(4));
  }

  for (const c of candidates) {
    // 边界判断,避免 102 命中 1102 或 10200
    const re = new RegExp(`(?<![\\d.])${c.replace('.', '\\.')}(?![\\d])`);
    if (re.test(compact)) return true;
  }
  return false;
}

/**
 * @param {Array} rows AI 返回的行
 * @param {string} sourceText 原始文件的纯文本
 * @returns {{ accepted: Array, rejected: Array }}
 */
function verifyRows(rows, sourceText) {
  const haystack = normalizeHaystack(sourceText);
  const accepted = [];
  const rejected = [];

  for (const row of rows || []) {
    const reasons = [];

    const sku = row && row.sku ? String(row.sku).trim() : '';
    const normSku = normalizeSku(sku);
    if (!normSku || normSku.length < 2) {
      reasons.push('型号为空或过短');
    } else if (!haystack.includes(normSku)) {
      reasons.push(`型号「${sku}」在原文中不存在`);
    }

    const price = typeof row?.price === 'number' ? row.price : parseFloat(row?.price);
    if (!isSanePrice(price)) {
      reasons.push('价格缺失或超出合理范围');
    } else if (!numberAppears(price, sourceText)) {
      reasons.push(`价格 ${price} 在原文中找不到`);
    }

    if (reasons.length) {
      rejected.push({ sku: sku || '(空)', price: row?.price, reasons });
      continue;
    }

    // 品名/起订量校验不过只丢该字段,不否决整行 ——
    // 价格才是关键数据,品名错了顶多难看,价格错了会报错价。
    let name = row?.name ? String(row.name).trim() : null;
    if (name && !haystack.includes(normalizeHaystack(name))) name = null;

    let moq = row?.moq === null || row?.moq === undefined ? null : Number(row.moq);
    if (moq !== null && (!Number.isFinite(moq) || moq <= 0 || !numberAppears(moq, sourceText))) {
      moq = null;
    }

    accepted.push({
      sku,
      price,
      moq,
      name,
      // 描述是模型对原文的重组,不做逐字校验(否则永远过不了),
      // 但它不参与报价计算,风险可接受
      description: row?.description ? String(row.description).trim() : null,
      confidence: 'medium', // AI 提取即便通过校验,也不等同于结构化读表
    });
  }

  return { accepted, rejected };
}

module.exports = { verifyRows, numberAppears, normalizeHaystack };
