const path = require('path');
const fs = require('fs');
const config = require('./config');

/**
 * 目录解析,优先级从高到低:
 *   1. 环境变量(launch.js 会读 config.json 后设进来;也便于临时开测试实例)
 *   2. config.json(界面上"保存路径"设置写的就是它)
 *   3. 默认:安装目录下的 data/ 与 archive/
 *
 * 数据目录始终在版本目录之外,更新只替换代码,不碰这里。
 */
const cfg = config.read();

function resolveDir(envKey, cfgKey, fallback) {
  const v = process.env[envKey] || cfg[cfgKey];
  return v ? path.resolve(v) : fallback;
}

const INSTALL_ROOT = path.join(__dirname, '..');

const DATA_DIR = resolveDir('SKU_DATA_DIR', 'dataDir', path.join(INSTALL_ROOT, 'data'));
const ARCHIVE_DIR = resolveDir('SKU_ARCHIVE_DIR', 'archiveDir', path.join(INSTALL_ROOT, 'archive'));
const INBOX_DIR = resolveDir('SKU_INBOX_DIR', 'inboxDir', path.join(INSTALL_ROOT, 'inbox'));

const IMAGE_DIR = path.join(DATA_DIR, 'images');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const SAFETY_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'sku.db');

for (const d of [DATA_DIR, IMAGE_DIR, TMP_DIR, SAFETY_DIR, ARCHIVE_DIR, INBOX_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

module.exports = {
  DATA_DIR, IMAGE_DIR, TMP_DIR, SAFETY_DIR, DB_PATH,
  ARCHIVE_DIR, INBOX_DIR, INSTALL_ROOT,
};
