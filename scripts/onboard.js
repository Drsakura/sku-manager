#!/usr/bin/env node
/**
 * 一次性迁移:把"平铺安装"(代码+data 混在根目录)迁成版本化安装。
 *
 * 迁移后布局:
 *   <root>/current.txt
 *   <root>/versions/<ver>/     ← 当前版本代码副本(含 node_modules)
 *   <root>/data/               ← 保持原位不动(sku.db/images/backups)
 *   <root>/inbox/, <root>/archive/  ← 保持原位,由 launch.js 重定向
 *
 * 用法:
 *   npm run onboard
 *
 * 幂等:版本目录已存在且含 server.js 时跳过复制,只确保 current.txt。
 * 迁移不会删除旧平铺文件,确认新布局可用后再手动清理。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CURRENT_FILE = path.join(ROOT, 'current.txt');
const VERSIONS_DIR = path.join(ROOT, 'versions');

const version = require(path.join(ROOT, 'package.json')).version;
const destDir = path.join(VERSIONS_DIR, version);

console.log(`>> 当前版本: v${version}`);

// 已迁移?
if (fs.existsSync(path.join(destDir, 'server.js'))) {
  fs.writeFileSync(CURRENT_FILE, version + '\n', 'utf8');
  console.log(`版本目录已存在: ${destDir}`);
  console.log('已是版本化安装,无需重复迁移。');
  printNext();
  process.exit(0);
}
if (fs.existsSync(destDir)) {
  console.error(`版本目录 ${destDir} 已存在但缺少 server.js,可能之前迁移中断。`);
  console.error('请确认后手动删除该目录再重跑。');
  process.exit(1);
}

// 复制(跳过会被 launch.js 重定向/版本管理占用的路径)。
// 不能用 cpSync(ROOT, destDir):destDir 在 ROOT 内部,Node 禁止父目录拷进子目录。
fs.mkdirSync(VERSIONS_DIR, { recursive: true });
console.log('>> 复制代码(含 node_modules,可能较慢,只需一次)…');
const SKIP_DIRS = new Set(['data', 'versions', 'dist', '.git', 'inbox', 'archive', 'sku-manager-mac']);
const SKIP_FILES = new Set(['current.txt']);
const SKIP_PREFIX = ['.env']; // .env 与 .env.local 等
fs.mkdirSync(destDir, { recursive: true });
for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const rel = ent.name;
  if (ent.isDirectory()) {
    if (SKIP_DIRS.has(rel)) continue;
  } else {
    if (SKIP_FILES.has(rel)) continue;
    if (SKIP_PREFIX.some((p) => rel.startsWith(p)) || rel.endsWith('.zip')) continue;
  }
  const src = path.join(ROOT, rel);
  const dest = path.join(destDir, rel);
  fs.cpSync(src, dest, { recursive: true });
}

fs.writeFileSync(CURRENT_FILE, version + '\n', 'utf8');
console.log(`>> 已写入 current.txt → v${version}`);

printNext();

function printNext() {
  console.log('\n下一步:');
  console.log('  Windows:  双击 start.bat  (或 node scripts/launch.js)');
  console.log('  Mac:      node scripts/launch.js');
  console.log('\n原平铺文件未删除。确认新方式能正常启动后,可手动清理根目录里的旧代码副本');
  console.log('(保留 data/、inbox/、archive/、versions/、scripts/、package*.json 即可)。');
}
