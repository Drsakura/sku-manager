function normalizeSku(raw) {
  if (!raw) return null;
  return String(raw)
    .toUpperCase()
    .replace(/[\s\-_./]/g, '')
    .trim();
}

/**
 * 产品归组键:同一单品的不同尺寸归为一个产品。
 * 只剥"尺寸/规格"类字样(8x10、200mm、1/2"、6寸),
 * 件数(6件套)保留 —— 套装件数不同是不同的产品。
 */
function groupKey(name) {
  if (!name) return null;
  let s = String(name).replace(/\s+/g, '');
  // 双值尺寸:8x10 / 12×14 / 50*200mm
  s = s.replace(/\d+(\.\d+)?[x×*]\d+(\.\d+)?(mm|cm)?/gi, '');
  // 分数规格:1/2 / 3/8"
  s = s.replace(/\d+\/\d+(["″”寸]|英寸)?/g, '');
  // 单值尺寸:200mm / 6" / 6寸(不剥裸数字,免得件数被吃掉)
  s = s.replace(/\d+(\.\d+)?(mm|cm|寸|英寸|inch|in|"|″|”|米)/gi, '');
  s = s.replace(/[-—–()（）]/g, '');
  const key = s.toUpperCase();
  return key || String(name).trim().toUpperCase();
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'object') {
    // exceljs 富文本 / 公式单元格
    if (raw.result !== undefined) return parseNumber(raw.result);
    if (raw.text !== undefined) return parseNumber(raw.text);
    if (Array.isArray(raw.richText)) return parseNumber(raw.richText.map((r) => r.text).join(''));
    return null;
  }
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** exceljs 单元格可能是字符串、数字、富文本对象或公式对象,统一转成文本。 */
function cellText(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object') {
    if (Array.isArray(raw.richText)) return raw.richText.map((r) => r.text).join('');
    if (raw.text !== undefined) return String(raw.text);
    if (raw.result !== undefined) return String(raw.result);
    if (raw instanceof Date) return raw.toISOString();
    return '';
  }
  return String(raw);
}

/**
 * 表头关键词库。每个字段是 [正则, 分值] 的列表 —— 分值越高越确定。
 * 打分而不是"命中即用",是因为中文合同里一列可能同时像多个字段
 * (例如「规格型号」既像型号也像品名),需要靠分值决出归属。
 */
const FIELD_PATTERNS = {
  sku: [
    [/^(sku|型号|货号|品号|料号|编号|图号)$/i, 100],
    [/^(物料|商品|产品|存货|材料)?(编码|编号|代码)$/, 96],
    [/(物料|商品|产品|存货)(编码|编号|代码)/, 94],
    [/^(产品|商品)?(型号|规格型号|型号规格)$/, 92],
    [/(货|料|品|图)号/, 88],
    [/规格型号|型号规格/, 86],
    [/^item\s*(no|code|#)?$|^part\s*(no|code|number)?$|^model$|^art\.?\s*no$/i, 90],
    [/item|part\s*no|model|artikel/i, 70],
    [/编码|编号|代码/, 58],
    [/型号/, 80],
  ],
  name: [
    [/^(品名|名称|产品名称|商品名称|货物名称|物料名称|材料名称|品种)$/, 100],
    [/^(品名规格|名称规格|品名及规格|货物名称及规格)$/, 95],
    [/(产品|商品|货物|物料|材料|存货)名称/, 92],
    [/品名|品种/, 88],
    [/^(description|product\s*name|item\s*name|goods)$/i, 90],
    [/description|product\s*name/i, 70],
    [/名称/, 80],
    [/^(项目|摘要|内容|货物)$/, 45],
  ],
  price: [
    [/^(单价|价格|采购价|进价|进货价|供货价|结算价|成交价|协议价|折后价)$/, 100],
    [/^(含税单价|不含税单价|无税单价|税前单价|税后单价|单价\(元\)|单价（元）)$/, 100],
    [/(含税|不含税|无税|税前|税后|折后).{0,3}(单价|价格)/, 96],
    [/(单价|价格).{0,3}(含税|不含税|无税|元)/, 96],
    [/采购价|进货价|进价|供货价|结算价|成交价|协议价|折后价|批发价/, 94],
    [/^(unit\s*price|price|unit\s*cost|cost)$/i, 92],
    [/unit\s*price|price/i, 70],
    [/单价/, 88],
    [/价格|单位价/, 82],
  ],
  moq: [
    [/^(moq|起订量|最小起订量|最低起订量|最小订量|最小订购量|起批量|最小起订)$/i, 100],
    [/^(最小包装量|最小包装|包装量|箱规|装箱量|每箱数量|最小批量)$/, 94],
    [/最小起订|最低起订|最小订购|最小订量|起订量|起批量|最小批量/, 96],
    [/moq/i, 100],
    [/起订|起批/, 90],
    [/最小包装|包装量|箱规|装箱量|最小包装数/, 84],
  ],
};

/** 明确不该被当成上面任何字段的列,避免「数量」被误认成起订量之类。 */
const EXCLUDE_PATTERNS = [
  /^(数量|采购数量|订购数量|订货数量|发货数量|入库数量|数量小计|合同数量|订单数量)$/,
  /^(金额|总价|总额|小计|合计|总金额|含税金额|不含税金额|价税合计)$/,
  /^(序号|行号|No\.?|#)$/i,
  /^(税率|税额|折扣|折扣率|备注|说明|交期|交货期|单位|计量单位)$/,
  /^(qty|quantity|amount|total|subtotal|remark|note|unit)$/i,
];

function isExcluded(header) {
  const h = cellText(header).trim().replace(/\s+/g, '');
  if (!h) return true;
  return EXCLUDE_PATTERNS.some((re) => re.test(h));
}

function scoreHeader(header, field) {
  const h = cellText(header).trim().replace(/\s+/g, '');
  if (!h || isExcluded(header)) return 0;
  let best = 0;
  for (const [re, score] of FIELD_PATTERNS[field]) {
    if (re.test(h) && score > best) best = score;
  }
  return best;
}

/**
 * 给一行表头,决定哪一列对应哪个字段。
 * 一列只能归给一个字段,按分值从高到低贪心分配。
 */
function mapHeaderRow(headerCells) {
  const candidates = [];
  headerCells.forEach((cell, idx) => {
    for (const field of Object.keys(FIELD_PATTERNS)) {
      const score = scoreHeader(cell, field);
      if (score > 0) candidates.push({ field, idx, score });
    }
  });

  candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const map = {};
  const usedCols = new Set();
  for (const c of candidates) {
    if (map[c.field] !== undefined || usedCols.has(c.idx)) continue;
    map[c.field] = c.idx;
    usedCols.add(c.idx);
  }
  return map;
}

/** 表头行必须至少能定位型号和单价,否则这行不是表头。 */
function isUsableMap(map) {
  return map.sku !== undefined && map.price !== undefined;
}

function mapConfidenceScore(map, headerCells) {
  let total = 0;
  for (const [field, idx] of Object.entries(map)) {
    total += scoreHeader(headerCells[idx], field);
  }
  return total + Object.keys(map).length * 10;
}

/**
 * 在前若干行里找最像表头的一行 —— 合同上方常有标题、抬头、合同号等杂行。
 * 返回 { rowIndex, map } 或 null。
 */
function findHeaderRow(rows, maxScan = 25) {
  let best = null;
  const limit = Math.min(rows.length, maxScan);

  for (let i = 0; i < limit; i++) {
    const cells = rows[i] || [];
    if (!cells.some((c) => cellText(c).trim())) continue;

    // 有些合同表头拆成两行(如上行「单价」下行「含税」),合并再试一次
    const merged = cells.map((c, j) => {
      const below = (rows[i + 1] || [])[j];
      const a = cellText(c).trim();
      const b = cellText(below).trim();
      return a && b && !parseNumberLike(b) ? `${a}${b}` : a;
    });

    for (const [cellSet, rowIndex] of [
      [cells, i],
      [merged, i + 1],
    ]) {
      const map = mapHeaderRow(cellSet);
      if (!isUsableMap(map)) continue;
      const score = mapConfidenceScore(map, cellSet);
      if (!best || score > best.score) best = { rowIndex, map, score };
    }
  }

  return best ? { rowIndex: best.rowIndex, map: best.map } : null;
}

function parseNumberLike(text) {
  return /^[\d.,¥$￥\s]+$/.test(String(text).trim()) && /\d/.test(String(text));
}

/**
 * 判断一个单元格是否真的像货号 —— 合同表格下方通常跟着质量条款、
 * 付款约定、包装要求等大段文字,不拦住的话它们会被当成产品导进来。
 */
function looksLikeSku(raw) {
  const s = cellText(raw).trim();
  if (s.length < 2 || s.length > 32) return false;
  if (!/[A-Za-z0-9]/.test(s)) return false;
  // 句子标点 = 这是一句话,不是货号
  if (/[：:，。；、！？…\n]/.test(s)) return false;
  // 列表编号开头,如「(1) 」「1、」「一：」
  if (/^[（(]?\d+[)）、]/.test(s)) return false;
  if (/^[一二三四五六七八九十]+[、：.]/.test(s)) return false;
  // 货号里偶有中文,但大段中文说明它是品名或条款
  if ((s.match(/[一-龥]/g) || []).length > 4) return false;
  if ((s.match(/\s/g) || []).length > 1) return false;
  return true;
}

/** 采购单价的合理区间,挡掉从文字里误抓的天文数字和负数。 */
function isSanePrice(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e8;
}

/**
 * 表头分数相近时(例如同时有「工厂货号」和「客户货号」),
 * 靠数据填充率决出用哪一列 —— 空了一半的那列不适合当主键。
 */
function refineSkuColumn(headerCells, dataRows, map) {
  const best = Math.max(...headerCells.map((c) => scoreHeader(c, 'sku')), 0);
  if (best <= 0) return map;

  const takenByOthers = new Set(
    Object.entries(map)
      .filter(([field]) => field !== 'sku')
      .map(([, idx]) => idx)
  );

  const candidates = headerCells
    .map((c, i) => ({ i, score: scoreHeader(c, 'sku') }))
    .filter((c) => c.score >= best - 10 && c.score > 0 && !takenByOthers.has(c.i));

  if (candidates.length < 2) return map;

  let winner = null;
  for (const c of candidates) {
    let valid = 0;
    for (const row of dataRows.slice(0, 200)) {
      if (looksLikeSku(row[c.i])) valid++;
    }
    if (!winner || valid > winner.valid) winner = { idx: c.i, valid };
  }

  if (winner && winner.valid > 0) map.sku = winner.idx;
  return map;
}

/**
 * 表头里没有品名列时,从未占用的列里挑一列文字列当品名 ——
 * 中文字符多、平均长度够、且几乎不是纯数字的那一列。
 */
function guessNameColumn(dataRows, usedCols, colCount) {
  let best = null;

  for (let col = 0; col < colCount; col++) {
    if (usedCols.has(col)) continue;

    let textCount = 0;
    let cjkCount = 0;
    let numericCount = 0;
    let totalLen = 0;
    let seen = 0;

    for (const row of dataRows.slice(0, 60)) {
      const t = cellText(row[col]).trim();
      if (!t) continue;
      seen++;
      if (parseNumberLike(t)) numericCount++;
      else {
        textCount++;
        totalLen += t.length;
        if (/[一-龥]/.test(t)) cjkCount++;
      }
    }

    if (seen < 2 || textCount < seen * 0.6) continue;
    const avgLen = totalLen / Math.max(textCount, 1);
    if (avgLen < 2) continue;

    // 中文占比和平均长度越高越像品名;纯数字列直接排除
    const score = cjkCount * 3 + textCount + avgLen * 2 - numericCount * 5;
    if (!best || score > best.score) best = { col, score };
  }

  return best ? best.col : undefined;
}

module.exports = {
  normalizeSku,
  groupKey,
  parseNumber,
  cellText,
  mapHeaderRow,
  findHeaderRow,
  guessNameColumn,
  isUsableMap,
  looksLikeSku,
  isSanePrice,
  refineSkuColumn,
  FIELD_PATTERNS,
};
