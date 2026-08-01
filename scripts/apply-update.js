#!/usr/bin/env node
/**
 * 应用更新器(由 server.js 在 POST /api/update/apply 时 detached 启动):
 *   1. 等旧服务进程退出(避免 3300 端口冲突)
 *   2. 校验新版本目录完整
 *   3. 改写 current.txt 指向新版本
 *   4. 重新拉起 launch.js
 *
 * 用法:
 *   node scripts/apply-update.js <newVersion> <parentPid>
 *
 * 以 detached 方式运行:父进程(server.js)退出后本进程仍存活。
 * 日志写到 <root>/data/tmp/apply-update.log,方便无头排查。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CURRENT_FILE = path.join(ROOT, 'current.txt');
const VERSIONS_DIR = path.join(ROOT, 'versions');
const DATA_DIR = process.env.SKU_DATA_DIR || path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'tmp', 'apply-update.log');

const newVersion = process.argv[2];
const parentPid = Number(process.argv[3]) || 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {}
  console.log(line);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // EPERM = 进程存在但无权限发送信号
  }
}

function main() {
  if (!newVersion) {
    log('缺少 newVersion 参数');
    process.exit(1);
  }

  const versionDir = path.join(VERSIONS_DIR, newVersion);
  if (!fs.existsSync(path.join(versionDir, 'server.js'))) {
    log(`错误:版本目录不存在或缺少 server.js: ${versionDir}`);
    process.exit(1);
  }

  // 1) 等旧服务退出(最多 30s)。版本化目录没有文件锁,主要是避免 3300 端口冲突。
  if (parentPid) {
    const deadline = Date.now() + 30000;
    while (isAlive(parentPid) && Date.now() < deadline) {
      const waitMs = 300;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
    log(parentPid && !isAlive(parentPid)
      ? `旧服务已退出 (pid ${parentPid})`
      : `等待超时,继续(旧进程可能仍在,如端口冲突请手动重启)`);
  }

  // 2) 改写 current.txt
  fs.writeFileSync(CURRENT_FILE, newVersion + '\n', 'utf8');
  log(`current.txt → ${newVersion}`);

  // 3) 重新拉起(无头;浏览器端会自动重连)
  const child = spawn(process.execPath, [path.join('scripts', 'launch.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  log(`已重新拉起 launch.js (pid ${child.pid})`);
}

main();
