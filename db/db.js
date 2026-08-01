const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../lib/paths');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS won't add columns to a table that already exists,
// so new columns added to schema.sql need to be backfilled onto older DB files.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('products', 'supplier_id', 'INTEGER REFERENCES suppliers(id)');
ensureColumn('price_history', 'supplier_id', 'INTEGER REFERENCES suppliers(id)');
ensureColumn('contracts', 'supplier_id', 'INTEGER REFERENCES suppliers(id)');
ensureColumn('contracts', 'source_path', 'TEXT');
ensureColumn('contracts', 'column_report', 'TEXT');
ensureColumn('contracts', 'terms', 'TEXT');
ensureColumn('products', 'description', 'TEXT');
ensureColumn('products', 'contract_id', 'INTEGER REFERENCES contracts(id)');
ensureColumn('products', 'parse_method', "TEXT DEFAULT 'rules'");
ensureColumn('contracts', 'parse_method', "TEXT DEFAULT 'rules'");
ensureColumn('contracts', 'ai_rejected', 'INTEGER DEFAULT 0');
ensureColumn('products', 'group_id', 'INTEGER REFERENCES product_groups(id)');
ensureColumn('product_images', 'group_id', 'INTEGER REFERENCES product_groups(id)');
ensureColumn('suppliers', 'main_categories', 'TEXT');

// 必须等补列完成后再建 —— 写在 schema.sql 里会在老库上报 no such column
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_group ON products(group_id);
  CREATE INDEX IF NOT EXISTS idx_images_group ON product_images(group_id);
  CREATE INDEX IF NOT EXISTS idx_attr_group ON item_attributes(group_id);
`);

/**
 * 迁移:把还没归属产品的货号归组(幂等,只处理 group_id 为空的行)。
 * 归组键见 normalize.groupKey —— 同一单品的不同尺寸归为一个产品,
 * 套装件数保留在键里,所以 6件套/19件套是两个产品。
 */
const { groupKey } = require('../lib/normalize');

function migrateGroups() {
  const orphans = db.prepare('SELECT * FROM products WHERE group_id IS NULL').all();
  if (!orphans.length) return;

  const findGroup = db.prepare(
    'SELECT id FROM product_groups WHERE group_key = ? AND supplier_id IS ?'
  );
  const createGroup = db.prepare(
    `INSERT INTO product_groups (name, group_key, brand, category, supplier_id, created_at)
     VALUES (@name, @group_key, @brand, @category, @supplier_id, @created_at)`
  );
  const setGroup = db.prepare('UPDATE products SET group_id = ? WHERE sku = ?');

  db.transaction(() => {
    for (const p of orphans) {
      const key = p.name ? groupKey(p.name) : 'SKU:' + p.sku;
      let g = findGroup.get(key, p.supplier_id ?? null);
      if (!g) {
        const info = createGroup.run({
          name: p.name || p.display_sku || p.sku,
          group_key: key,
          brand: p.brand ?? null,
          category: p.category ?? null,
          supplier_id: p.supplier_id ?? null,
          created_at: new Date().toISOString(),
        });
        g = { id: info.lastInsertRowid };
      }
      setGroup.run(g.id, p.sku);
    }
    // 旧图片按货号挂着,统一提升到产品层
    db.exec(`UPDATE product_images SET group_id =
      (SELECT group_id FROM products WHERE products.sku = product_images.sku)
      WHERE group_id IS NULL AND sku != ''`);
  })();
}

migrateGroups();

module.exports = db;
