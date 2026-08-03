#!/usr/bin/env node
/**
 * 启动器:读 current.txt 找到当前版本目录,固定数据目录,然后启动服务。
 *
 * 布局:
 *   <root>/current.txt        ← 当前版本号(更新时由 apply-update.js 改写)
 *   <root>/versions/<ver>/    ← 每个版本的完整代码(含 node_modules)
 *   <root>/data/              ← sku.db + images + backups(永远在版本目录之外)
 *
 * 用法:
 *   node scripts/launch.js      (Windows 也可用 start.bat)
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CURRENT_FILE = path.join(ROOT, 'current.txt');
const VERSIONS_DIR = path.join(ROOT, 'versions');

function fail(msg) {
  console.error(`[launch] 错误: ${msg}`);
  process.exit(1);
}

const version = fs.existsSync(CURRENT_FILE)
  ? fs.readFileSync(CURRENT_FILE, 'utf8').trim()
  : '';

const versionDir = version ? path.join(VERSIONS_DIR, version) : '';
const versioned = !!versionDir && fs.existsSync(path.join(versionDir, 'server.js'));

// 平铺安装(刚解压、还没 onboard)也要能直接跑 —— 根目录有 server.js 就用它。
// 这条兜底同时挡住一类发布事故:current.txt 若被误打进安装包,会指向一个
// 本机不存在的版本目录,不兜底就会开箱即崩。
const flat = fs.existsSync(path.join(ROOT, 'server.js'));

if (!versioned && !flat) {
  fail(
    version
      ? `current.txt 指向 v${version},但 ${versionDir} 里没有 server.js,根目录也没有。安装包可能不完整。`
      : '根目录没有 server.js,安装包可能不完整。'
  );
}

if (version && !versioned && flat) {
  console.warn(`[launch] current.txt 指向 v${version},但该版本目录不存在;改用根目录代码启动。`);
}

const runDir = versioned ? versionDir : ROOT;

// 数据/收件/归档目录必须固定在版本目录之外,否则每次更新数据会跟着旧版本走
if (!process.env.SKU_DATA_DIR) {
  process.env.SKU_DATA_DIR = path.join(ROOT, 'data');
}
if (!process.env.SKU_INBOX_DIR) {
  process.env.SKU_INBOX_DIR = path.join(ROOT, 'inbox');
}
if (!process.env.SKU_ARCHIVE_DIR) {
  process.env.SKU_ARCHIVE_DIR = path.join(ROOT, 'archive');
}

const shownVersion = versioned
  ? version
  : (() => {
      try {
        return require(path.join(ROOT, 'package.json')).version;
      } catch {
        return '?';
      }
    })();

console.log(`[launch] 启动 sku-manager v${shownVersion}${versioned ? '' : '(平铺安装)'}`);
console.log(`[launch] 数据目录: ${process.env.SKU_DATA_DIR}`);

const child = spawn(process.execPath, ['server.js'], {
  cwd: runDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (e) => fail(`无法启动 server.js: ${e.message}`));
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
