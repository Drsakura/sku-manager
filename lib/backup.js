const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db/db');

const { IMAGE_DIR, TMP_DIR, SAFETY_DIR } = require('./paths');

// 备份文件里额外带的两张表:图片二进制 + 版本信息。
// 这样"一个 .db 文件"就是完整的库,换机器只搬这一个文件。
const IMAGES_TABLE = '_backup_images';
const META_TABLE = '_backup_meta';

/** 会被备份/还原的业务表,顺序照顾外键依赖。 */
const TABLES = [
  'suppliers',
  'product_groups',
  'contracts',
  'products',
  'item_attributes',
  'price_history',
  'product_images',
  'settings',
];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function columnsOf(handle, table) {
  try {
    return handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function tableExists(handle, table) {
  return !!handle
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
}

/**
 * 导出:先做一致性快照,再把图片以 BLOB 塞进同一个文件。
 * 用 db.backup() 而不是直接拷文件 —— 服务运行中直接拷可能拿到写到一半的页。
 */
async function createBackup() {
  const outPath = path.join(TMP_DIR, `backup-${Date.now()}.db`);
  await db.backup(outPath);

  const out = new Database(outPath);
  try {
    out.exec(`
      DROP TABLE IF EXISTS ${IMAGES_TABLE};
      CREATE TABLE ${IMAGES_TABLE} (filename TEXT PRIMARY KEY, data BLOB NOT NULL);
      DROP TABLE IF EXISTS ${META_TABLE};
      CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT);
    `);

    const insImg = out.prepare(`INSERT OR REPLACE INTO ${IMAGES_TABLE} (filename, data) VALUES (?, ?)`);
    let imageCount = 0;
    if (fs.existsSync(IMAGE_DIR)) {
      out.transaction(() => {
        for (const name of fs.readdirSync(IMAGE_DIR)) {
          const p = path.join(IMAGE_DIR, name);
          if (!fs.statSync(p).isFile()) continue;
          insImg.run(name, fs.readFileSync(p));
          imageCount++;
        }
      })();
    }

    const insMeta = out.prepare(`INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
    insMeta.run('exported_at', new Date().toISOString());
    insMeta.run('app', 'sku-manager');
    insMeta.run('images', String(imageCount));

    out.pragma('wal_checkpoint(TRUNCATE)');
    out.exec('VACUUM');
  } finally {
    out.close();
  }

  return { path: outPath, filename: `产品库备份-${stamp()}.db`, size: fs.statSync(outPath).size };
}

/** 打开上传的文件并确认它确实是本工具导出的备份。 */
function inspectBackup(filePath) {
  let handle;
  try {
    handle = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch {
    return { ok: false, error: '这个文件打不开,可能不是有效的数据库文件' };
  }

  try {
    if (!tableExists(handle, 'products') || !tableExists(handle, 'product_groups')) {
      return { ok: false, error: '这不是本工具导出的备份文件(缺少产品表)' };
    }
    const count = (t) =>
      tableExists(handle, t) ? handle.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0;

    const meta = {};
    if (tableExists(handle, META_TABLE)) {
      for (const r of handle.prepare(`SELECT key, value FROM ${META_TABLE}`).all()) {
        meta[r.key] = r.value;
      }
    }

    return {
      ok: true,
      summary: {
        groups: count('product_groups'),
        items: count('products'),
        suppliers: count('suppliers'),
        contracts: count('contracts'),
        images: count(IMAGES_TABLE),
        exported_at: meta.exported_at || null,
      },
    };
  } finally {
    handle.close();
  }
}

/**
 * 还原:整库替换。
 * 先把当前库另存一份到 data/backups/ 作为后悔药,再逐表覆盖。
 * 用 ATTACH 逐表拷贝而不是替换文件,是为了不用关闭正在服务的连接。
 */
async function restoreBackup(filePath) {
  const check = inspectBackup(filePath);
  if (!check.ok) throw new Error(check.error);

  // 后悔药:还原前先留一份当前状态
  const safety = path.join(SAFETY_DIR, `还原前-${stamp()}.db`);
  await db.backup(safety);

  const src = new Database(filePath, { readonly: true, fileMustExist: true });
  const srcCols = {};
  for (const t of TABLES) srcCols[t] = tableExists(src, t) ? columnsOf(src, t) : null;
  const backupImages = tableExists(src, IMAGES_TABLE)
    ? src.prepare(`SELECT filename, data FROM ${IMAGES_TABLE}`).all()
    : [];
  src.close();

  db.exec(`ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS src`);
  try {
    db.transaction(() => {
      db.pragma('foreign_keys = OFF');
      // 反序清空,避免外键顺序问题
      for (const t of [...TABLES].reverse()) db.exec(`DELETE FROM main.${t}`);

      for (const t of TABLES) {
        if (!srcCols[t]) continue;
        // 只拷两边都有的列 —— 备份可能来自旧版本,列数不一定一致
        const shared = columnsOf(db, t).filter((c) => srcCols[t].includes(c));
        if (!shared.length) continue;
        const cols = shared.map((c) => `"${c}"`).join(', ');
        db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM src.${t}`);
      }
      db.pragma('foreign_keys = ON');
    })();
  } finally {
    db.exec('DETACH DATABASE src');
  }

  // 图片:写回备份里的,再清掉备份中不存在的孤儿文件
  const keep = new Set();
  for (const img of backupImages) {
    const safeName = path.basename(img.filename);
    fs.writeFileSync(path.join(IMAGE_DIR, safeName), img.data);
    keep.add(safeName);
  }
  for (const name of fs.readdirSync(IMAGE_DIR)) {
    const p = path.join(IMAGE_DIR, name);
    if (fs.statSync(p).isFile() && !keep.has(name)) fs.unlinkSync(p);
  }

  return { ...check.summary, safetyCopy: path.basename(safety) };
}

/** 清理导出用的临时文件,避免 data/tmp 越堆越大。 */
function cleanupTmp(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* 忽略 */ }
}

module.exports = { createBackup, inspectBackup, restoreBackup, cleanupTmp, TMP_DIR, SAFETY_DIR };
