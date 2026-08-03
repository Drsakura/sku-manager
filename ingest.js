const fs = require('fs');
const path = require('path');
const db = require('./db/db');
const { parseContract } = require('./parsers/index');
const { extractRawText } = require('./parsers/rawText');
const { normalizeSku, groupKey } = require('./lib/normalize');
const { aiConfig } = require('./lib/settings');
const { extractProducts } = require('./lib/aiClient');
const { verifyRows } = require('./lib/verify');

// 收件/归档目录统一由 lib/paths 解析(环境变量 > config.json > 默认),
// 始终落在版本目录之外,更新只替换代码不会影响。
const { INBOX_DIR, ARCHIVE_DIR } = require('./lib/paths');

const SUPPORTED_EXT = new Set(['.xlsx', '.xls', '.pdf']);

const getProduct = db.prepare('SELECT * FROM products WHERE sku = ?');
const findGroupStmt = db.prepare(
  'SELECT id FROM product_groups WHERE group_key = ? AND supplier_id IS ?'
);
const createGroupStmt = db.prepare(
  `INSERT INTO product_groups (name, group_key, supplier_id, created_at)
   VALUES (@name, @group_key, @supplier_id, @created_at)`
);
const upsertProduct = db.prepare(`
  INSERT INTO products (sku, display_sku, name, price, currency, moq, description,
                        supplier_id, contract_id, group_id, parse_method, last_updated, source_contract, confidence)
  VALUES (@sku, @display_sku, @name, @price, 'CNY', @moq, @description,
          @supplier_id, @contract_id, @group_id, @parse_method, @last_updated, @source_contract, @confidence)
  ON CONFLICT(sku) DO UPDATE SET
    name = COALESCE(excluded.name, products.name),
    price = excluded.price,
    moq = COALESCE(excluded.moq, products.moq),
    description = COALESCE(excluded.description, products.description),
    supplier_id = COALESCE(excluded.supplier_id, products.supplier_id),
    contract_id = excluded.contract_id,
    group_id = COALESCE(products.group_id, excluded.group_id),
    parse_method = excluded.parse_method,
    last_updated = excluded.last_updated,
    source_contract = excluded.source_contract,
    confidence = excluded.confidence
`);
const insertHistory = db.prepare(`
  INSERT INTO price_history (sku, old_price, new_price, old_moq, new_moq, currency, supplier_id, source_contract, confidence, changed_at)
  VALUES (@sku, @old_price, @new_price, @old_moq, @new_moq, 'CNY', @supplier_id, @source_contract, @confidence, @changed_at)
`);
const insertContract = db.prepare(`
  INSERT INTO contracts (filename, supplier_id, file_type, source_path, column_report, terms,
                         parse_method, ai_rejected, processed_at, rows_matched, rows_new, status, notes)
  VALUES (@filename, @supplier_id, @file_type, @source_path, @column_report, @terms,
          @parse_method, @ai_rejected, @processed_at, @rows_matched, @rows_new, @status, @notes)
`);
const finalizeContract = db.prepare(`
  UPDATE contracts SET rows_matched = @rows_matched, rows_new = @rows_new,
                       status = @status, notes = @notes
  WHERE id = @id
`);

/**
 * 找到或创建这一行货号应归属的产品。
 * 同供应商 + 归组键相同 → 同一个产品;没有品名的货号各自独立成组。
 * 已归组的货号保持原产品不动(用户可能手动移动过)。
 */
function resolveGroup(row, sku, existing, supplierId, now) {
  if (existing && existing.group_id) return existing.group_id;
  const key = row.name ? groupKey(row.name) : 'SKU:' + sku;
  const found = findGroupStmt.get(key, supplierId ?? null);
  if (found) return found.id;
  return createGroupStmt.run({
    name: row.name || row.sku,
    group_key: key,
    supplier_id: supplierId ?? null,
    created_at: now,
  }).lastInsertRowid;
}

/**
 * 规则解析的结果是否"不够用",需要请本地模型出手。
 * 保持保守:规则能干的活不浪费算力,也不引入不必要的不确定性。
 */
function rulesFellShort(result) {
  if (!result.rows || result.rows.length === 0) return true;
  // 扫描件走 OCR,行少且置信度低,交给模型通常更准
  if (result.fileType === 'pdf-scan') return true;
  // 表格结构没认出来,只能按文本行猜,准确率没保障
  if (/未检测到表格结构/.test(result.columnReport || '')) return true;
  return false;
}

/** 用模型重解析,并把结果逐行回原文校验。校验不过的一律丢弃。 */
async function parseWithAi(filePath, { model } = {}) {
  const sourceText = await extractRawText(filePath);
  const raw = await extractProducts(sourceText, model ? { model } : {});
  const { accepted, rejected } = verifyRows(raw, sourceText);
  return { rows: accepted, rejected, returned: raw.length };
}

function processRows(rows, filename, supplierId, contractId, parseMethod = 'rules') {
  let matched = 0;
  let created = 0;
  let lowConfidence = 0;
  const now = new Date().toISOString();

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const sku = normalizeSku(row.sku);
      if (!sku) continue;
      if (row.confidence === 'low') lowConfidence++;
      const existing = getProduct.get(sku);

      if (existing) {
        if (existing.price !== row.price || (row.moq !== null && existing.moq !== row.moq)) {
          insertHistory.run({
            sku,
            old_price: existing.price,
            new_price: row.price,
            old_moq: existing.moq,
            new_moq: row.moq,
            supplier_id: supplierId,
            source_contract: filename,
            confidence: row.confidence,
            changed_at: now,
          });
        }
        matched++;
      } else {
        created++;
      }

      upsertProduct.run({
        sku,
        display_sku: existing ? existing.display_sku : row.sku,
        name: row.name,
        price: row.price,
        moq: row.moq,
        description: row.description || null,
        supplier_id: supplierId,
        contract_id: contractId,
        group_id: resolveGroup(row, sku, existing, supplierId, now),
        parse_method: parseMethod,
        last_updated: now,
        source_contract: filename,
        confidence: row.confidence,
      });
    }
  });

  tx(rows);
  return { matched, created, lowConfidence };
}

/**
 * Parse one contract file and write its prices into the DB.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {number|null} [options.supplierId] supplier these prices belong to
 * @param {string} [options.displayName] name shown in the UI. Uploads get a
 *   timestamp prefix on disk to avoid collisions; that prefix must not leak
 *   into what the user sees as the source contract.
 * @param {boolean} [options.archive] move the file into archive/ when done.
 *   Must stay false for folder scans — those read the user's own archived
 *   contract files in place and must never relocate them.
 */
async function processFile(
  filePath,
  { supplierId = null, displayName = null, archive = false, forceAi = false } = {}
) {
  const filename = displayName || path.basename(filePath);
  const startedAt = new Date().toISOString();

  let result;
  try {
    result = await parseContract(filePath);
  } catch (err) {
    insertContract.run({
      filename,
      supplier_id: supplierId,
      file_type: 'unknown',
      source_path: filePath,
      column_report: null,
      terms: null,
      parse_method: 'rules',
      ai_rejected: 0,
      processed_at: startedAt,
      rows_matched: 0,
      rows_new: 0,
      status: 'failed',
      notes: err.message,
    });
    return { filename, status: 'failed', error: err.message, matched: 0, created: 0, lowConfidence: 0 };
  }

  // 规则优先;只有规则搞不定(或用户手动指定)时才动用本地模型。
  // 模型不可用时静默退回规则结果 —— 断网/Mac 关机不能让导入失败。
  const cfg = aiConfig();
  let parseMethod = 'rules';
  let aiRejected = 0;
  let aiError = null;

  if ((forceAi || (cfg.enabled && rulesFellShort(result))) && cfg.baseUrl) {
    try {
      const ai = await parseWithAi(filePath, {});
      aiRejected = ai.rejected.length;
      // 模型结果更多才采纳,否则保留规则结果 —— 避免越帮越忙
      if (ai.rows.length > result.rows.length) {
        result = { ...result, rows: ai.rows, columnReport: `本地模型解析 · 采纳 ${ai.rows.length} 行` };
        parseMethod = 'ai';
      }
    } catch (err) {
      aiError = err.message;
    }
  }

  // 合同记录先落库拿到 id,产品行才能挂上 contract_id,
  // 从而精确取到本合同的通用要求;统计数最后回填。
  const contractId = insertContract.run({
    filename,
    supplier_id: supplierId,
    file_type: result.fileType,
    source_path: filePath,
    column_report: result.columnReport || null,
    terms: result.contractTerms || null,
    parse_method: parseMethod,
    ai_rejected: aiRejected,
    processed_at: startedAt,
    rows_matched: 0,
    rows_new: 0,
    status: 'processing',
    notes: null,
  }).lastInsertRowid;

  const { matched, created, lowConfidence } = processRows(
    result.rows, filename, supplierId, contractId, parseMethod
  );
  const status = result.rows.length > 0 ? 'success' : 'empty';
  const described = result.rows.filter((r) => r.description).length;

  finalizeContract.run({
    id: contractId,
    rows_matched: matched,
    rows_new: created,
    status,
    notes: result.rows.length === 0 ? '未能从文件中识别出任何价格行' : null,
  });

  if (archive) {
    fs.renameSync(filePath, path.join(ARCHIVE_DIR, path.basename(filePath)));
  }

  return {
    filename,
    status,
    fileType: result.fileType,
    columnReport: result.columnReport || '',
    matched,
    created,
    lowConfidence,
    described,
    hasTerms: !!result.contractTerms,
    parseMethod,
    aiRejected,
    aiError,
  };
}

function listContractFiles(dir, { recursive = false } = {}) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) found.push(...listContractFiles(full, { recursive }));
    } else if (SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

/** Scan a folder in place, without touching the user's original files. */
async function scanFolder(dir, { supplierId = null, recursive = false } = {}) {
  const files = listContractFiles(dir, { recursive });
  const results = [];
  for (const file of files) {
    results.push(await processFile(file, { supplierId, archive: false }));
  }
  return results;
}

async function processInbox() {
  const files = listContractFiles(INBOX_DIR);
  if (files.length === 0) {
    console.log('inbox 为空。把合同文件(.xlsx/.pdf)放进 ./inbox 再运行一次。');
    return;
  }
  for (const file of files) {
    const r = await processFile(file, { archive: true });
    if (r.status === 'failed') {
      console.error(`[失败] ${r.filename}: ${r.error}`);
    } else {
      console.log(`[完成] ${r.filename} (${r.fileType}): 新增 ${r.created}, 更新 ${r.matched}`);
    }
  }
}

if (require.main === module) {
  processInbox().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { processInbox, processFile, scanFolder, listContractFiles, INBOX_DIR, ARCHIVE_DIR };
