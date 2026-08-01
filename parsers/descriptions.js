const { normalizeSku } = require('../lib/normalize');

/**
 * PDF/Excel 取出来的文字常被塞进多余的制表符和空格
 * (例如「产品品质要求 ：依照出口质量标准执行 ，符合…」),
 * 中文之间的空格要去掉,否则读起来断断续续。
 */
function cleanProse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[一-龥，。；：、（）“”！？])\s+(?=[一-龥，。；：、（）“”！？])/g, '')
    .replace(/\s+(?=[，。；：、）！？])/g, '')
    .replace(/(?<=[（])\s+/g, '')
    .trim();
}

// 合同顶层条款编号:「一：」「二、」「三.」「5、」「6.」
const CLAUSE_RE = /^(?:[一二三四五六七八九十]+\s*[、：:.]|\d+\s*[、.](?!\d))/;

// 合同末尾的签章格式区,基本是空白待填栏,从这里开始后面全是模板噪音
const BOILERPLATE_START_RE = new RegExp(
  [
    '^供\\s*方\\s*需\\s*方$',
    '^单位名称',
    '^单位地址',
    '^法定代表人',
    '^委托代理人',
    '^开户银行',
    '^账\\s*号',
    '^邮政编码',
    '^签（公）证',
    '^有效期限',
    '工商行政管理局监制',
  ].join('|')
);

// 金额小计/大写金额不是"要求",纯数字行同理
const NOISE_RE = /^(合计|小写|大写|金额|价税合计|合计人民币|总计)/;
const PURE_NUMBER_RE = /^[\d\s.,¥￥%-]+$/;

function isTermNoise(line) {
  return NOISE_RE.test(line) || PURE_NUMBER_RE.test(line);
}

/** 找出这一行提到了哪些已知型号 —— 一行可能同时挂两个(如电缆钳剪 6" 和 10")。 */
function skusInLine(line, skuIndex) {
  const normalizedLine = normalizeSku(line) || '';
  if (!normalizedLine) return [];
  const hits = [];
  for (const [normSku, originalSku] of skuIndex) {
    if (normalizedLine.includes(normSku)) hits.push(originalSku);
  }
  return hits;
}

/**
 * 从合同的非表格文字里提取交付标准与要求,分成两层:
 *   - 产品级:含已知型号的小节标题之后的文字,归给该型号
 *   - 合同级:顶层条款(一：/二、/5、),对全合同产品通用
 *
 * @param {string[]} proseLines 表格之外的文字行
 * @param {string[]} knownSkus  本合同已解析出的型号
 * @returns {{ bySku: Object<string,string>, contractTerms: string }}
 */
function extractDescriptions(proseLines, knownSkus) {
  const skuIndex = (knownSkus || [])
    .map((s) => [normalizeSku(s), s])
    .filter(([n]) => n && n.length >= 4);

  const bySku = {};
  const terms = [];
  let current = null; // 当前归属的型号数组,null = 合同级
  let inBoilerplate = false;

  for (const raw of proseLines) {
    const line = cleanProse(raw);
    if (!line || line.length < 3) continue;

    if (!inBoilerplate && BOILERPLATE_START_RE.test(line)) inBoilerplate = true;

    const hits = skuIndex.length ? skusInLine(line, skuIndex) : [];

    // 含型号的行是小节标题(「品名（型号）：」),品名已单独存过,不重复收进描述
    if (hits.length) {
      current = hits;
      inBoilerplate = false;
      for (const sku of hits) bySku[sku] = bySku[sku] || [];
      continue;
    }

    if (CLAUSE_RE.test(line)) {
      current = null;
      if (!inBoilerplate) terms.push(line);
      continue;
    }

    if (current) {
      for (const sku of current) bySku[sku].push(line);
    } else if (!inBoilerplate && !isTermNoise(line)) {
      terms.push(line);
    }
  }

  const out = {};
  for (const [sku, lines] of Object.entries(bySku)) {
    const text = lines.join('\n').trim();
    if (text) out[sku] = text;
  }

  return { bySku: out, contractTerms: terms.join('\n').trim() };
}

module.exports = { extractDescriptions, cleanProse };
