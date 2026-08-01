const path = require('path');
const fs = require('fs');

/**
 * 数据目录。默认是项目下的 data/,可用环境变量 SKU_DATA_DIR 指到别处 ——
 * 便于把库放到加密盘、或在同一台机器上跑一个互不干扰的测试实例。
 */
const DATA_DIR = process.env.SKU_DATA_DIR
  ? path.resolve(process.env.SKU_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const IMAGE_DIR = path.join(DATA_DIR, 'images');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const SAFETY_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'sku.db');

for (const d of [DATA_DIR, IMAGE_DIR, TMP_DIR, SAFETY_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

module.exports = { DATA_DIR, IMAGE_DIR, TMP_DIR, SAFETY_DIR, DB_PATH };
