const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db/db');
const { processFile, scanFolder, listContractFiles, INBOX_DIR } = require('./ingest');
const settings = require('./lib/settings');
const { probe } = require('./lib/aiClient');
const { normalizeSku, groupKey } = require('./lib/normalize');
const backup = require('./lib/backup');
const updater = require('./lib/updater');

const app = express();
const PORT = process.env.PORT || 3300;
// Bound to loopback on purpose: this serves the employer's confidential contract
// data, and /api/scan reads arbitrary filesystem paths supplied by the client.
const HOST = '127.0.0.1';

const paths = require('./lib/paths');
const { IMAGE_DIR } = paths;
const appConfig = require('./lib/config');
const agent = require('./lib/agent');
const fsBrowse = require('./lib/fsBrowse');
const ExcelJS = require('exceljs'); // parsers 里已在解析合同;这里用来把查询结果导出成表格

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/product-images', express.static(IMAGE_DIR));

const upload = multer({
  // Without this, busboy leaves the filename undecoded and Chinese contract
  // filenames arrive as mojibake.
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: INBOX_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const imageUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: IMAGE_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMAGE_EXT.has(ext));
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* ------------------------------- 参数辅助 ------------------------------- */

const getItemAttrs = db.prepare(
  'SELECT id, name, value, sort FROM item_attributes WHERE sku = ? ORDER BY sort, id'
);
const getGroupAttrs = db.prepare(
  'SELECT id, name, value, sort FROM item_attributes WHERE group_id = ? AND sku IS NULL ORDER BY sort, id'
);

/** 整组替换参数(货号级或产品级)。传入 [{name, value}],空名跳过。 */
function replaceAttrs({ sku = null, groupId = null }, attrs) {
  if (!Array.isArray(attrs)) return;
  db.transaction(() => {
    if (sku) db.prepare('DELETE FROM item_attributes WHERE sku = ?').run(sku);
    else db.prepare('DELETE FROM item_attributes WHERE group_id = ? AND sku IS NULL').run(groupId);
    const ins = db.prepare(
      'INSERT INTO item_attributes (group_id, sku, name, value, sort) VALUES (@group_id, @sku, @name, @value, @sort)'
    );
    attrs.forEach((a, i) => {
      const name = String(a?.name || '').trim();
      if (!name) return;
      ins.run({
        group_id: sku ? null : groupId,
        sku,
        name,
        value: String(a?.value ?? '').trim() || null,
        sort: i,
      });
    });
  })();
}

/** 产品组变空后清理掉,避免列表里留下没有货号的壳(有图片的保留)。 */
function cleanupGroupIfEmpty(groupId) {
  if (!groupId) return;
  const hasItems = db.prepare('SELECT 1 FROM products WHERE group_id = ? LIMIT 1').get(groupId);
  const hasImages = db.prepare('SELECT 1 FROM product_images WHERE group_id = ? LIMIT 1').get(groupId);
  if (!hasItems && !hasImages) {
    db.prepare('DELETE FROM item_attributes WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM product_groups WHERE id = ?').run(groupId);
  }
}

/* ---------------------------------- 查询 ---------------------------------- */

/** 产品级搜索:一行一个产品,聚合价格区间/货号数;命中的货号单独列出。 */
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const supplierId = req.query.supplier_id;
  const onlyLow = req.query.only_low === '1';

  const where = [];
  const params = {};

  if (q) {
    where.push(`g.id IN (
      SELECT DISTINCT g2.id FROM product_groups g2
      LEFT JOIN products p2 ON p2.group_id = g2.id
      LEFT JOIN item_attributes a2 ON (a2.group_id = g2.id OR a2.sku = p2.sku)
      WHERE g2.name LIKE @q OR g2.brand LIKE @q OR g2.category LIKE @q OR g2.description LIKE @q
         OR p2.sku LIKE @q OR p2.display_sku LIKE @q OR p2.name LIKE @q
         OR p2.spec LIKE @q OR p2.description LIKE @q
         OR a2.name LIKE @q OR a2.value LIKE @q
    )`);
    params.q = `%${q}%`;
  }
  if (supplierId === 'none') {
    where.push('g.supplier_id IS NULL');
  } else if (supplierId) {
    where.push('g.supplier_id = @supplier_id');
    params.supplier_id = Number(supplierId);
  }
  if (onlyLow) {
    where.push(`EXISTS (SELECT 1 FROM products pl WHERE pl.group_id = g.id AND pl.confidence = 'low')`);
  }

  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.brand, g.category, g.supplier_id,
              s.name AS supplier_name, s.short_name AS supplier_short,
              (SELECT COUNT(*) FROM products p WHERE p.group_id = g.id) AS item_count,
              (SELECT MIN(p.price) FROM products p WHERE p.group_id = g.id) AS price_min,
              (SELECT MAX(p.price) FROM products p WHERE p.group_id = g.id) AS price_max,
              (SELECT COUNT(*) FROM products p WHERE p.group_id = g.id AND p.confidence = 'low') AS low_count,
              (SELECT MAX(p.last_updated) FROM products p WHERE p.group_id = g.id) AS last_updated,
              (SELECT filename FROM product_images i WHERE i.group_id = g.id
                 ORDER BY i.is_primary DESC, i.id ASC LIMIT 1) AS thumb,
              (SELECT COUNT(*) FROM product_images i WHERE i.group_id = g.id) AS image_count
       FROM product_groups g
       LEFT JOIN suppliers s ON s.id = g.supplier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY last_updated DESC LIMIT 300`
    )
    .all(params);

  // 搜索词直接命中了哪些货号 —— 前端高亮用
  if (q && groups.length) {
    const ids = groups.map((g) => g.id);
    const hits = db
      .prepare(
        `SELECT p.group_id, p.sku, p.display_sku FROM products p
         WHERE p.group_id IN (${ids.map(() => '?').join(',')})
           AND (p.sku LIKE ? OR p.display_sku LIKE ? OR p.spec LIKE ? OR p.description LIKE ?
                OR p.sku IN (SELECT a.sku FROM item_attributes a WHERE a.sku IS NOT NULL AND (a.name LIKE ? OR a.value LIKE ?)))`
      )
      .all(...ids, params.q, params.q, params.q, params.q, params.q, params.q);
    const byGroup = {};
    for (const h of hits) {
      (byGroup[h.group_id] = byGroup[h.group_id] || []).push({ sku: h.sku, display_sku: h.display_sku });
    }
    for (const g of groups) g.matched_items = byGroup[g.id] || [];
  }

  res.json(groups);
});

/** 产品详情:产品 + 全部货号(含各自参数) + 产品级参数 + 图片。 */
app.get('/api/group/:id', (req, res) => {
  const id = Number(req.params.id);
  const group = db
    .prepare(
      `SELECT g.*, s.name AS supplier_name FROM product_groups g
       LEFT JOIN suppliers s ON s.id = g.supplier_id WHERE g.id = ?`
    )
    .get(id);
  if (!group) return res.status(404).json({ error: 'not found' });

  const items = db
    .prepare(
      `SELECT p.*, c.terms AS contract_terms FROM products p
       LEFT JOIN contracts c ON c.id = p.contract_id
       WHERE p.group_id = ? ORDER BY p.display_sku`
    )
    .all(id);
  for (const it of items) it.attributes = getItemAttrs.all(it.sku);

  res.json({
    group,
    groupAttributes: getGroupAttrs.all(id),
    items,
    images: db
      .prepare('SELECT * FROM product_images WHERE group_id = ? ORDER BY is_primary DESC, id ASC')
      .all(id),
  });
});

/** 编辑产品(名称/品牌/分类/供应商/说明/产品级参数)。 */
app.put('/api/group/:id', (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM product_groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const name = b.name?.trim();
  if (!name) return res.status(400).json({ error: '产品名称不能为空' });

  db.prepare(
    `UPDATE product_groups SET name=@name, group_key=@group_key, brand=@brand,
       category=@category, description=@description, supplier_id=@supplier_id WHERE id=@id`
  ).run({
    id,
    name,
    group_key: groupKey(name),
    brand: b.brand?.trim() || null,
    category: b.category?.trim() || null,
    description: b.description?.trim() || null,
    supplier_id: b.supplier_id ? Number(b.supplier_id) : null,
  });

  if (Array.isArray(b.attributes)) replaceAttrs({ groupId: id }, b.attributes);
  res.json({ ok: true });
});

/* --------------------------------- 货号 --------------------------------- */

function validatePriceMoq(b) {
  const price = b.price === '' || b.price == null ? null : Number(b.price);
  if (price !== null && (!Number.isFinite(price) || price < 0)) {
    return { error: '采购价必须是非负数字' };
  }
  const moq = b.moq === '' || b.moq == null ? null : Number(b.moq);
  if (moq !== null && (!Number.isFinite(moq) || moq < 0)) {
    return { error: '起订量必须是非负数字' };
  }
  return { price, moq };
}

function insertItem(b, groupId, supplierId) {
  const displaySku = String(b.sku || '').trim();
  const sku = normalizeSku(displaySku);
  if (!sku) return { error: '货号不能为空' };
  if (db.prepare('SELECT sku FROM products WHERE sku = ?').get(sku)) {
    return { error: '该货号已存在', existingSku: sku };
  }
  const v = validatePriceMoq(b);
  if (v.error) return v;

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO products (sku, display_sku, name, spec, price, currency, moq, description,
                             supplier_id, contract_id, group_id, parse_method,
                             last_updated, source_contract, confidence)
       VALUES (@sku, @display_sku, @name, @spec, @price, 'CNY', @moq, @description,
               @supplier_id, NULL, @group_id, 'manual', @now, NULL, 'high')`
    ).run({
      sku,
      display_sku: displaySku,
      name: b.name?.trim() || null,
      spec: b.spec?.trim() || null,
      price: v.price,
      moq: v.moq,
      description: b.description?.trim() || null,
      supplier_id: supplierId,
      group_id: groupId,
      now,
    });
    // 手工价格同样留痕,保证"每个价格都能追到出处"这条不破功
    if (v.price !== null) {
      db.prepare(
        `INSERT INTO price_history (sku, old_price, new_price, old_moq, new_moq, currency,
                                    supplier_id, source_contract, confidence, changed_at)
         VALUES (@sku, NULL, @price, NULL, @moq, 'CNY', @supplier_id, '手工录入', 'high', @now)`
      ).run({ sku, price: v.price, moq: v.moq, supplier_id: supplierId, now });
    }
  })();

  if (Array.isArray(b.attributes)) replaceAttrs({ sku }, b.attributes);
  return { sku };
}

/** 新建产品(必须带第一个货号)。 */
app.post('/api/groups', (req, res) => {
  const b = req.body || {};
  const name = b.name?.trim();
  if (!name) return res.status(400).json({ error: '产品名称不能为空' });
  if (!b.item || !String(b.item.sku || '').trim()) {
    return res.status(400).json({ error: '至少需要一个货号' });
  }

  const supplierId = b.supplier_id ? Number(b.supplier_id) : null;
  const groupId = db
    .prepare(
      `INSERT INTO product_groups (name, group_key, brand, category, description, supplier_id, created_at)
       VALUES (@name, @group_key, @brand, @category, @description, @supplier_id, @created_at)`
    )
    .run({
      name,
      group_key: groupKey(name),
      brand: b.brand?.trim() || null,
      category: b.category?.trim() || null,
      description: b.description?.trim() || null,
      supplier_id: supplierId,
      created_at: new Date().toISOString(),
    }).lastInsertRowid;

  const r = insertItem({ ...b.item, name }, groupId, supplierId);
  if (r.error) {
    cleanupGroupIfEmpty(groupId);
    return res.status(r.existingSku ? 409 : 400).json(r);
  }
  res.json({ group_id: groupId, sku: r.sku });
});

/** 给已有产品加货号。 */
app.post('/api/group/:id/items', (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM product_groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'not found' });

  const r = insertItem({ ...req.body, name: req.body?.name ?? g.name }, id, g.supplier_id);
  if (r.error) return res.status(r.existingSku ? 409 : 400).json(r);
  res.json({ sku: r.sku });
});

/** 货号详情(编辑器用):含参数与调价历史。 */
app.get('/api/product/:sku', (req, res) => {
  const sku = req.params.sku.toUpperCase();
  const product = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name, c.terms AS contract_terms
       FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN contracts c ON c.id = p.contract_id
       WHERE p.sku = ?`
    )
    .get(sku);
  if (!product) return res.status(404).json({ error: 'not found' });

  product.attributes = getItemAttrs.all(sku);

  const history = db
    .prepare(
      `SELECT h.*, s.name AS supplier_name FROM price_history h
       LEFT JOIN suppliers s ON s.id = h.supplier_id
       WHERE h.sku = ? ORDER BY h.changed_at DESC LIMIT 50`
    )
    .all(sku);

  res.json({ product, history });
});

/** 手工修正货号 —— 表头千奇百怪,总有识别不准需要人工改的。 */
app.put('/api/product/:sku', (req, res) => {
  const sku = req.params.sku.toUpperCase();
  const existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const moq = b.moq === '' || b.moq === null || b.moq === undefined ? null : Number(b.moq);
  if (moq !== null && (!Number.isFinite(moq) || moq < 0)) {
    return res.status(400).json({ error: '起订量必须是非负数字' });
  }

  // 价格只有在没有合同来源时才允许手改 —— 合同解析出来的价格必须保持
  // 可追溯,否则下次导入同一份合同又会被覆盖,反而让人以为改丢了。
  const priceEditable = !existing.contract_id;
  let price = existing.price;
  if (priceEditable && b.price !== undefined) {
    price = b.price === '' || b.price === null ? null : Number(b.price);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      return res.status(400).json({ error: '采购价必须是非负数字' });
    }
  }

  // 移动到其他产品 / 独立成新产品
  let targetGroup = existing.group_id;
  const oldGroup = existing.group_id;
  if (b.group_id === 'new') {
    targetGroup = db
      .prepare(
        `INSERT INTO product_groups (name, group_key, supplier_id, created_at)
         VALUES (@name, @group_key, @supplier_id, @created_at)`
      )
      .run({
        name: b.name?.trim() || existing.name || existing.display_sku || sku,
        group_key: 'SKU:' + sku,
        supplier_id: existing.supplier_id ?? null,
        created_at: new Date().toISOString(),
      }).lastInsertRowid;
  } else if (b.group_id !== undefined && b.group_id !== null && b.group_id !== '') {
    const g = db.prepare('SELECT id FROM product_groups WHERE id = ?').get(Number(b.group_id));
    if (!g) return res.status(400).json({ error: '目标产品不存在' });
    targetGroup = g.id;
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE products SET
         name = @name, spec = @spec, description = @description,
         price = @price, moq = @moq, group_id = @group_id, last_updated = @now
       WHERE sku = @sku`
    ).run({
      sku,
      name: b.name?.trim() || null,
      spec: b.spec?.trim() || null,
      description: b.description?.trim() || null,
      price,
      moq,
      group_id: targetGroup,
      now,
    });

    if (priceEditable && (price !== existing.price || moq !== existing.moq)) {
      db.prepare(
        `INSERT INTO price_history (sku, old_price, new_price, old_moq, new_moq, currency,
                                    supplier_id, source_contract, confidence, changed_at)
         VALUES (@sku, @old_price, @new_price, @old_moq, @new_moq, 'CNY',
                 @supplier_id, '手工修改', 'high', @now)`
      ).run({
        sku,
        old_price: existing.price,
        new_price: price,
        old_moq: existing.moq,
        new_moq: moq,
        supplier_id: existing.supplier_id ?? null,
        now,
      });
    }
  })();

  if (Array.isArray(b.attributes)) replaceAttrs({ sku }, b.attributes);
  if (targetGroup !== oldGroup) cleanupGroupIfEmpty(oldGroup);

  res.json({ ok: true, priceEditable, group_id: targetGroup });
});

/** 删除货号(调价历史保留备查;所在产品变空则一并清理)。 */
app.delete('/api/product/:sku', (req, res) => {
  const sku = req.params.sku.toUpperCase();
  const existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.transaction(() => {
    db.prepare('DELETE FROM item_attributes WHERE sku = ?').run(sku);
    db.prepare('DELETE FROM products WHERE sku = ?').run(sku);
  })();
  cleanupGroupIfEmpty(existing.group_id);
  res.json({ ok: true });
});

/** 参数名自动补全 —— 输过一次的参数名,下次直接选。 */
app.get('/api/attr-names', (req, res) => {
  const q = (req.query.q || '').trim();
  const rows = q
    ? db
        .prepare(
          'SELECT DISTINCT name FROM item_attributes WHERE name LIKE ? ORDER BY name LIMIT 30'
        )
        .all(`%${q}%`)
    : db.prepare('SELECT DISTINCT name FROM item_attributes ORDER BY name LIMIT 30').all();
  res.json(rows.map((r) => r.name));
});

/* ---------------------------------- 图片 ---------------------------------- */

app.post('/api/group/:id/images', imageUpload.array('images', 20), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM product_groups WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: '没有收到图片(只支持 jpg/png/webp/gif/bmp)' });
  }

  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM product_images WHERE group_id = ?')
    .get(id).n;
  const insert = db.prepare(
    `INSERT INTO product_images (sku, group_id, filename, original_name, is_primary, created_at)
     VALUES ('', @group_id, @filename, @original_name, @is_primary, @created_at)`
  );

  db.transaction(() => {
    req.files.forEach((f, i) => {
      insert.run({
        group_id: id,
        filename: path.basename(f.path),
        original_name: f.originalname,
        is_primary: existing === 0 && i === 0 ? 1 : 0,
        created_at: new Date().toISOString(),
      });
    });
  })();

  res.json({
    images: db
      .prepare('SELECT * FROM product_images WHERE group_id = ? ORDER BY is_primary DESC, id ASC')
      .all(id),
  });
});

app.post('/api/images/:id/primary', (req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(Number(req.params.id));
  if (!img) return res.status(404).json({ error: 'not found' });
  db.transaction(() => {
    db.prepare('UPDATE product_images SET is_primary = 0 WHERE group_id = ?').run(img.group_id);
    db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ?').run(img.id);
  })();
  res.json({ ok: true });
});

app.delete('/api/images/:id', (req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(Number(req.params.id));
  if (!img) return res.status(404).json({ error: 'not found' });

  db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
  // 删掉记录后把封面顺延给剩下的第一张
  if (img.is_primary) {
    const next = db
      .prepare('SELECT id FROM product_images WHERE group_id = ? ORDER BY id ASC LIMIT 1')
      .get(img.group_id);
    if (next) db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ?').run(next.id);
  }

  const filePath = path.join(IMAGE_DIR, img.filename);
  if (filePath.startsWith(IMAGE_DIR) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM product_groups) AS total_groups,
          (SELECT COUNT(*) FROM products) AS total_skus,
          (SELECT COUNT(*) FROM products WHERE confidence = 'low') AS low_confidence,
          (SELECT COUNT(*) FROM suppliers) AS total_suppliers,
          (SELECT COUNT(*) FROM contracts) AS contracts_processed`
      )
      .get()
  );
});

/* --------------------------------- 供应商 --------------------------------- */

app.get('/api/suppliers', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM product_groups g WHERE g.supplier_id = s.id) AS group_count,
                (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS sku_count
         FROM suppliers s ORDER BY s.name`
      )
      .all()
  );
});

/** 没归属供应商的产品数 —— 手工建的货常常一时定不下供应商。 */
app.get('/api/suppliers/unassigned/count', (req, res) => {
  res.json(
    db.prepare('SELECT COUNT(*) AS count FROM product_groups WHERE supplier_id IS NULL').get()
  );
});

app.get('/api/suppliers/:id', (req, res) => {
  const id = Number(req.params.id);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!supplier) return res.status(404).json({ error: 'not found' });

  res.json({
    supplier,
    products: db
      .prepare(
        `SELECT p.*, g.name AS group_name,
                (SELECT filename FROM product_images i WHERE i.group_id = p.group_id
                   ORDER BY i.is_primary DESC, i.id ASC LIMIT 1) AS thumb
         FROM products p LEFT JOIN product_groups g ON g.id = p.group_id
         WHERE p.supplier_id = ? ORDER BY p.last_updated DESC LIMIT 500`
      )
      .all(id),
    contracts: db
      .prepare('SELECT * FROM contracts WHERE supplier_id = ? ORDER BY processed_at DESC LIMIT 50')
      .all(id),
  });
});

const SUPPLIER_FIELDS = [
  'name', 'short_name', 'contact_person', 'phone',
  'email', 'address', 'website', 'payment_terms', 'main_categories', 'notes',
];

function supplierPayload(body) {
  const out = {};
  for (const f of SUPPLIER_FIELDS) out[f] = body[f] ?? null;
  return out;
}

app.post('/api/suppliers', (req, res) => {
  const data = supplierPayload(req.body);
  if (!data.name) return res.status(400).json({ error: '供应商名称不能为空' });
  try {
    const info = db
      .prepare(
        `INSERT INTO suppliers (name, short_name, contact_person, phone, email, address, website, payment_terms, main_categories, notes, created_at)
         VALUES (@name, @short_name, @contact_person, @phone, @email, @address, @website, @payment_terms, @main_categories, @notes, @created_at)`
      )
      .run({ ...data, created_at: new Date().toISOString() });
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '该供应商名称已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/suppliers/:id', (req, res) => {
  const data = supplierPayload(req.body);
  if (!data.name) return res.status(400).json({ error: '供应商名称不能为空' });
  try {
    db.prepare(
      `UPDATE suppliers SET name=@name, short_name=@short_name, contact_person=@contact_person,
        phone=@phone, email=@email, address=@address, website=@website,
        payment_terms=@payment_terms, main_categories=@main_categories, notes=@notes WHERE id=@id`
    ).run({ ...data, id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '该供应商名称已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/suppliers/:id', (req, res) => {
  const id = Number(req.params.id);
  // Products keep their prices; they just become unassigned rather than deleted.
  db.transaction(() => {
    db.prepare('UPDATE products SET supplier_id = NULL WHERE supplier_id = ?').run(id);
    db.prepare('UPDATE product_groups SET supplier_id = NULL WHERE supplier_id = ?').run(id);
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

/* ---------------------------------- 导入 ---------------------------------- */

app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  const supplierId = req.body.supplier_id ? Number(req.body.supplier_id) : null;
  const results = [];
  for (const file of req.files || []) {
    results.push(
      await processFile(file.path, {
        supplierId,
        displayName: file.originalname,
        archive: true,
      })
    );
  }
  res.json({ results });
});

app.post('/api/scan/preview', (req, res) => {
  const dir = (req.body.path || '').trim();
  if (!dir) return res.status(400).json({ error: '请填写文件夹路径' });
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: '路径不存在或不是文件夹' });
  }
  const files = listContractFiles(dir, { recursive: !!req.body.recursive });
  res.json({ count: files.length, files: files.slice(0, 200).map((f) => path.basename(f)) });
});

app.post('/api/scan', async (req, res) => {
  const dir = (req.body.path || '').trim();
  if (!dir) return res.status(400).json({ error: '请填写文件夹路径' });
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: '路径不存在或不是文件夹' });
  }
  const supplierId = req.body.supplier_id ? Number(req.body.supplier_id) : null;
  const results = await scanFolder(dir, { supplierId, recursive: !!req.body.recursive });
  res.json({ results });
});

/* --------------------------- 备份与迁移 --------------------------- */

const backupUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: backup.TMP_DIR,
    filename: (req, file, cb) => cb(null, `restore-${Date.now()}.db`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

/** 一键导出:产品/价格/历史/供应商/参数/图片全在这一个 .db 文件里。 */
app.get('/api/backup', async (req, res) => {
  let made;
  try {
    made = await backup.createBackup();
  } catch (err) {
    return res.status(500).json({ error: '导出失败: ' + err.message });
  }
  res.download(made.path, made.filename, () => backup.cleanupTmp(made.path));
});

/** 导入前先看看这个备份里有什么,避免误导入别的文件。 */
app.post('/api/backup/inspect', backupUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  const r = backup.inspectBackup(req.file.path);
  backup.cleanupTmp(req.file.path);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r.summary);
});

/** 一键导入:整库替换。还原前会自动把当前状态另存一份作为后悔药。 */
app.post('/api/backup/restore', backupUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  try {
    const summary = await backup.restoreBackup(req.file.path);
    res.json(summary);
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    backup.cleanupTmp(req.file.path);
  }
});

/* --------------------------- 本地 AI 设置 --------------------------- */

/** 密钥不回传前端,只回"是否已设置"的标记。 */
function publicSettings() {
  const s = settings.all();
  const out = { ...s };
  for (const k of settings.SECRET_KEYS) {
    out[`${k}_set`] = !!s[k];
    delete out[k];
  }
  return out;
}

app.get('/api/settings', (req, res) => {
  res.json(publicSettings());
});

const PLAIN_SETTING_KEYS = [
  'ai_enabled', 'ai_provider', 'ai_base_url', 'ai_model', 'ai_timeout_ms',
  'ai_cloud_preset', 'ai_cloud_base_url', 'ai_cloud_model',
  'update_repo', 'update_auto_check',
];

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  for (const key of PLAIN_SETTING_KEYS) {
    if (b[key] !== undefined) settings.set(key, b[key]);
  }
  // 密钥单独处理:传空字符串 = 不改动(避免每次保存都要重输);传 null = 清除
  for (const key of settings.SECRET_KEYS) {
    if (b[key] === undefined) continue;
    if (b[key] === null) settings.set(key, '');
    else if (String(b[key]).trim()) settings.set(key, String(b[key]).trim());
  }
  res.json(publicSettings());
});

/** 对话式查询:模型只做意图识别和组织语言,数字全部来自真实查询。
 *  AI 未配置时不再直接拒绝,走 agent 的关键词检索降级路径(_fallback),返回 degraded:true。 */
app.post('/api/agent/ask', async (req, res) => {
  if (!String(req.body?.question || '').trim()) {
    return res.status(400).json({ error: '问题不能为空' });
  }
  try {
    res.json(await agent.ask(req.body.question));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 表格导出:前端把查询结果的行/列发来,服务端用 exceljs 生成 xlsx/csv 流式下载。 */
const EXPORT_MAX_ROWS = 2000;

app.post('/api/export', async (req, res) => {
  const { format, columns, rows } = req.body || {};
  if (format !== 'xlsx' && format !== 'csv') {
    return res.status(400).json({ error: 'format 只支持 xlsx 或 csv' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: '没有可导出的数据' });
  }
  if (rows.length > EXPORT_MAX_ROWS) {
    return res.status(400).json({ error: `数据过多,最多导出 ${EXPORT_MAX_ROWS} 行` });
  }
  // 列名由前端算好传来;缺失时按前端 chatRowsHtml 同规则兜底
  const cols = Array.isArray(columns) && columns.length
    ? columns.map(String)
    : [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  if (!cols.length) return res.status(400).json({ error: '列名为空' });

  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('查询结果');
    ws.columns = cols.map((c) => ({ header: c, key: c, width: 18 }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };

    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const filename = `查询结果_${stamp}.${format}`;
    // RFC 5987:中文文件名走 filename*,再留 ASCII 兜底名
    const encoded = encodeURIComponent(filename);
    res.setHeader('Content-Disposition', `attachment; filename="export.${format}"; filename*=UTF-8''${encoded}`);

    if (format === 'csv') {
      const buf = await wb.csv.writeBuffer();
      // 前置 UTF-8 BOM,否则中文版 Excel 打开 CSV 会按 ANSI 解出乱码
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.end(Buffer.concat([Buffer.from('﻿', 'utf8'), buf]));
    } else {
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    }
  } catch (err) {
    res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

/* --------------------------- 存储路径设置 --------------------------- */

/* --------------------------- 文件夹选择器 --------------------------- */

/** 列目录(只列子文件夹,不读文件),给界面上的"选择文件夹"用。 */
app.get('/api/fs/list', (req, res) => {
  const r = fsBrowse.list(String(req.query.path || ''));
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.post('/api/fs/mkdir', (req, res) => {
  const r = fsBrowse.makeDir(req.body?.parent, req.body?.name);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.get('/api/paths', (req, res) => {
  const cfg = appConfig.read();
  res.json({
    current: { data: paths.DATA_DIR, archive: paths.ARCHIVE_DIR, inbox: paths.INBOX_DIR },
    configured: { dataDir: cfg.dataDir || '', archiveDir: cfg.archiveDir || '', inboxDir: cfg.inboxDir || '' },
    configFile: appConfig.configPath(),
    // 环境变量优先级高于配置文件,被覆盖时界面要提示
    envOverride: {
      data: !!process.env.SKU_DATA_DIR,
      archive: !!process.env.SKU_ARCHIVE_DIR,
      inbox: !!process.env.SKU_INBOX_DIR,
    },
  });
});

app.put('/api/paths', (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const [key, label] of [['dataDir', '数据保存路径'], ['archiveDir', '合同归档目录'], ['inboxDir', '收件目录']]) {
    if (b[key] === undefined) continue;
    const v = String(b[key] || '').trim();
    if (v) {
      const chk = appConfig.checkDir(v);
      if (!chk.ok) return res.status(400).json({ error: `${label}:${chk.error}` });
      patch[key] = chk.resolved;
    } else {
      patch[key] = ''; // 空 = 恢复默认
    }
  }
  appConfig.write(patch);
  res.json({ ok: true, restartRequired: true, configFile: appConfig.configPath() });
});

app.post('/api/ai/probe', async (req, res) => {
  const overrides = {};
  if (req.body?.base_url) overrides.baseUrl = String(req.body.base_url).replace(/\/+$/, '');
  if (req.body?.model) overrides.model = req.body.model;
  res.json(await probe(overrides));
});

/** 手动对某份已导入的合同用模型重解析(规则认不准时的补救入口)。 */
app.post('/api/contracts/:id/reparse-ai', async (req, res) => {
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.source_path || !fs.existsSync(c.source_path)) {
    return res.status(400).json({ error: '找不到原始文件,可能已被移动或删除' });
  }
  try {
    const r = await processFile(c.source_path, {
      supplierId: c.supplier_id,
      displayName: c.filename,
      archive: false,
      forceAi: true,
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contracts', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.*, s.name AS supplier_name FROM contracts c
         LEFT JOIN suppliers s ON s.id = c.supplier_id
         ORDER BY c.processed_at DESC LIMIT 100`
      )
      .all()
  );
});

/* --------------------------- 自动更新 --------------------------- */

/** 更新状态机(前端轮询 /api/version 取它做进度展示)。
 *  state: idle | disabled | uptodate | available | downloading | verifying | extracting | installing | ready | restarting | error
 */
const updateState = {
  state: 'idle',
  percent: 0,
  current: updater.currentVersion,
  latest: null,
  notes: null,
  error: null,
};

/** 后台执行完整更新流程(下载→校验→解压→装依赖→切版本→重启)。 */
async function runUpdateInBackground(repo) {
  try {
    updateState.state = 'checking';
    updateState.error = null;
    const info = await updater.checkUpdate(repo, settings.get('update_token'));
    if (!info.ok) {
      updateState.state = 'error';
      updateState.error = info.error;
      return;
    }
    updateState.current = info.current;
    updateState.latest = info.latest;
    updateState.notes = info.notes;
    if (!info.hasUpdate) {
      updateState.state = 'uptodate';
      return;
    }
    const staged = await updater.stageUpdate(info, (p) => Object.assign(updateState, p));
    if (!staged.ok) {
      updateState.state = 'error';
      updateState.error = '更新包就绪失败';
      return;
    }
    updateState.state = 'restarting';
    updateState.percent = 100;
    updater.applyUpdate(staged.version);
    // 给响应留出落盘时间,然后退出,由 apply-update.js 切版本并重启
    setTimeout(() => process.exit(0), 800);
  } catch (err) {
    updateState.state = 'error';
    updateState.error = err.message;
  }
}

/** 版本信息 + 当前更新状态(前端轮询这个,不触发网络请求)。 */
app.get('/api/version', (req, res) => {
  res.json({
    version: updater.currentVersion,
    update_repo: settings.get('update_repo'),
    update_state: updateState,
  });
});

/** 手动检查更新(会访问 GitHub,由"检查更新"按钮触发)。 */
app.get('/api/update/check', async (req, res) => {
  const repo = settings.get('update_repo');
  if (!repo) {
    updateState.state = 'disabled';
    return res.json({ ok: true, state: 'disabled', current: updater.currentVersion });
  }
  const info = await updater.checkUpdate(repo, settings.get('update_token'));
  if (!info.ok) {
    updateState.state = 'error';
    updateState.error = info.error;
    return res.status(200).json({ ok: false, state: 'error', error: info.error });
  }
  Object.assign(updateState, {
    state: info.hasUpdate ? 'available' : 'uptodate',
    current: info.current,
    latest: info.latest,
    notes: info.notes,
    percent: info.hasUpdate ? 0 : 100,
  });
  res.json({ ok: true, ...info });
});

/** 触发更新(后台跑,立即返回;前端轮询 /api/version 看进度)。 */
app.post('/api/update/apply', (req, res) => {
  const repo = settings.get('update_repo');
  if (!repo) return res.status(400).json({ ok: false, error: '未配置 update_repo' });
  if (['checking', 'downloading', 'verifying', 'extracting', 'installing', 'restarting'].includes(updateState.state)) {
    return res.status(409).json({ ok: false, error: '更新正在进行中' });
  }
  updateState.state = 'checking';
  updateState.percent = 0;
  updateState.error = null;
  runUpdateInBackground(repo); // 不 await,立即返回
  res.json({ ok: true, started: true });
});

// 启动后延迟检查一次,把结果放进 updateState(失败也不影响启动)
setTimeout(async () => {
  try {
    const repo = settings.get('update_repo');
    if (!repo) return;
    const info = await updater.checkUpdate(repo, settings.get('update_token'));
    if (info.ok) {
      updateState.state = info.hasUpdate ? 'available' : 'uptodate';
      updateState.current = info.current;
      updateState.latest = info.latest;
      updateState.notes = info.notes;
    } else {
      updateState.state = 'error';
      updateState.error = info.error;
    }
  } catch {
    /* 启动检查失败忽略 */
  }
}, 5000);

app.listen(PORT, HOST, () => {
  console.log(`产品查询工具已启动: http://localhost:${PORT}`);
});
