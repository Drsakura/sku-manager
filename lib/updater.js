/**
 * 客户端自动更新器:基于 GitHub Releases。
 * 公开仓库免鉴权;私有仓库传 token(只读即可,存在本机数据库里)。
 *
 * 流程:
 *   checkUpdate(repo, token) → 查 releases/latest,semver 对比,决定是否有新版
 *   stageUpdate(info)        → 下载 zip + sha256 → 校验 → 安全解压到 versions/<ver>/ → npm install
 *   applyUpdate(ver)         → detached 启动 scripts/apply-update.js,返回后主进程应尽快退出
 *
 * 布局依赖 scripts/launch.js 的约定:
 *   <root>/current.txt         当前版本号
 *   <root>/versions/<ver>/     版本代码(含 node_modules)
 *   <root>/data/               sku.db 等(版本之外)
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const semver = require('semver');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const VERSIONS_DIR = path.join(ROOT, 'versions');
const { TMP_DIR } = require('./paths');

const API_BASE = 'https://api.github.com';
const CHECK_TIMEOUT_MS = 8000;
const DL_TIMEOUT_MS = 5 * 60 * 1000; // 下载大 zip,放宽到 5 分钟

const currentVersion = require(path.join(ROOT, 'package.json')).version;

/** 带上 UA,有 token 时附加鉴权头(私有仓库必需)。 */
function ghHeaders(token, accept) {
  const h = { 'User-Agent': 'sku-manager-updater', Accept: accept };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** 查最新 Release。repo 形如 "owner/repo"。未配置时返回 null。 */
async function checkUpdate(repo, token) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${API_BASE}/repos/${repo}/releases/latest`, {
      headers: ghHeaders(token, 'application/vnd.github+json'),
      signal: ctrl.signal,
    });
  } catch (e) {
    return { ok: false, error: `连不上 GitHub(${e.name === 'AbortError' ? '超时' : e.message})` };
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 404) {
    // 私有仓库不带 token 时 GitHub 也回 404(不泄露仓库是否存在),要分开提示
    return {
      ok: false,
      error: token
        ? '仓库或 Release 不存在,请检查 update_repo 是否写对'
        : '找不到仓库或 Release。若仓库是私有的,需要在下方填只读 token',
    };
  }
  if (resp.status === 401) return { ok: false, error: 'token 无效或已过期' };
  if (!resp.ok) {
    if (resp.status === 403) {
      return {
        ok: false,
        error: token ? 'token 权限不足或被限流(403)' : 'GitHub 限流(403),稍后再试或填 token 提高额度',
      };
    }
    return { ok: false, error: `GitHub 返回 ${resp.status}` };
  }

  let rel;
  try {
    rel = await resp.json();
  } catch {
    return { ok: false, error: '解析 Release 失败' };
  }

  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  if (!semver.valid(latest)) return { ok: false, error: `Release tag 不是合法版本号:${rel.tag_name}` };

  const zipAsset = (rel.assets || []).find(
    (a) => a.name.endsWith('.zip') && a.name.startsWith('sku-manager-')
  );
  if (!zipAsset) return { ok: false, error: 'Release 里没有 sku-manager-*.zip 资产' };
  const shaAsset = (rel.assets || []).find((a) => a.name === `${zipAsset.name}.sha256`);
  if (!shaAsset) return { ok: false, error: '缺少对应的 .sha256 资产' };

  return {
    ok: true,
    current: currentVersion,
    hasUpdate: semver.gt(latest, currentVersion),
    latest,
    notes: String(rel.body || '').slice(0, 2000),
    published_at: rel.published_at || null,
    zipName: zipAsset.name,
    // 用 API asset 地址而不是 browser_download_url:github.com 本体在国内常被
    // SNI 阻断,但 api.github.com / objects.githubusercontent.com 通常可直连。
    // 私有仓库下 API 地址也是唯一能带 token 下载的方式。
    zipUrl: zipAsset.url,
    shaUrl: shaAsset.url,
    size: zipAsset.size,
    token, // 透传给 stageUpdate,私有仓库下载资产同样要鉴权
  };
}

/** 下载 + 校验 + 解压 + 装依赖。info 来自 checkUpdate。 */
async function stageUpdate(info, onProgress) {
  const ver = info.latest;
  const destDir = path.join(VERSIONS_DIR, ver);

  // 已存在且完整 → 直接返回
  if (
    fs.existsSync(path.join(destDir, 'server.js')) &&
    fs.existsSync(path.join(destDir, 'node_modules'))
  ) {
    return { ok: true, version: ver, skipped: true };
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, info.zipName);
  const shaPath = path.join(TMP_DIR, `${info.zipName}.sha256`);
  const stagingDir = path.join(TMP_DIR, `staging-${ver}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });

  onProgress?.({ state: 'downloading', percent: 5, version: ver });
  await download(info.zipUrl, zipPath, (p) =>
    onProgress?.({ state: 'downloading', percent: 5 + Math.round(p * 60), version: ver }),
    info.token
  );

  onProgress?.({ state: 'verifying', percent: 68, version: ver });
  await download(info.shaUrl, shaPath, null, info.token);
  const expected = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (expected && actual !== expected) {
    throw new Error(
      `sha256 校验失败(期望 ${expected.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…),已中止更新`
    );
  }

  onProgress?.({ state: 'extracting', percent: 72, version: ver });
  safeExtract(zipPath, stagingDir);

  onProgress?.({ state: 'installing', percent: 78, version: ver });
  await installDeps(stagingDir);

  // 原子落位:先在 tmp 下装好依赖,再整体改名到 versions/<ver>/
  // 平铺安装可能还没有 versions/ 目录(onboard 才会建)—— 不建的话 rename 直接 ENOENT,
  // 更新会一直卡死。这里兜底建一下。
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, destDir);

  onProgress?.({ state: 'ready', percent: 100, version: ver });
  return { ok: true, version: ver };
}

/** detached 启动应用更新器;返回后调用方应尽快退出主进程。 */
function applyUpdate(version) {
  const child = spawn(
    process.execPath,
    [path.join('scripts', 'apply-update.js'), version, String(process.pid)],
    { cwd: ROOT, detached: true, stdio: 'ignore', env: process.env }
  );
  child.unref();
  return { ok: true, restarting: true, version };
}

/* ------------------------------ 内部工具 ------------------------------ */

function download(url, outPath, onProgress, token) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DL_TIMEOUT_MS);
    fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: ghHeaders(token, 'application/octet-stream'),
    })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
        const total = Number(resp.headers.get('content-length')) || 0;
        const file = fs.createWriteStream(outPath);
        let got = 0;
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(Buffer.from(value));
          got += value.length;
          if (total) onProgress?.(got / total);
        }
        file.end();
        file.on('finish', () => {
          clearTimeout(timer);
          resolve();
        });
        file.on('error', reject);
      })
      .catch(reject);
  });
}

/** 安全解压:拒绝路径穿越,防止恶意 zip 写出版本目录。 */
function safeExtract(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.split('\\').join('/');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`更新包含非法路径:${name},已中止`);
    }
    const outPath = path.join(destDir, name);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entry.getData());

    // writeFileSync 不带权限位:macOS/Linux 上启动脚本解压后会变成不可执行,
    // 双击打不开。这里按扩展名补回执行位(Windows 上 chmod 是空操作)。
    if (/\.(command|sh)$/i.test(name)) {
      try {
        fs.chmodSync(outPath, 0o755);
      } catch { /* Windows 或无权限时忽略 */ }
    }
  }
}

/** 在版本目录里装依赖(生产依赖,跳过 dev)。 */
function npmInstall(cwd) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(cmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let errTail = '';
    const collect = (buf) => {
      errTail = (errTail + String(buf)).slice(-2000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();

      // 光甩一句 "gyp ERR! not ok" 用户不知道该干嘛。认出常见死法,给能照做的话。
      const tail = errTail.split('\n').slice(-3).join(' | ');
      let hint = '';
      if (/find Python|node-gyp|gyp ERR/i.test(errTail)) {
        hint =
          ' —— 这是 npm 想从源码编译原生模块导致的(本机没有 Python / 编译工具链)。' +
          '本不该走到这一步:依赖自带预编译二进制。' +
          '先试着升级 npm(npm i -g npm@latest)再重试更新;' +
          '实在不行可以把当前版本目录里的 node_modules 复制到新版本目录下,依赖没变时可以直接用。';
      } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(errTail)) {
        hint = ' —— 连不上 npm 源,检查网络或换个镜像后重试。';
      }
      reject(new Error(`npm install 失败(exit ${code}): ${tail}${hint}`));
    });
  });
}

/** 一个版本目录的依赖指纹。依赖没变 = 指纹相同 = 装出来的东西一模一样。 */
function depsFingerprint(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return JSON.stringify({
      d: p.dependencies || {},
      o: p.optionalDependencies || {},
    });
  } catch {
    return null;
  }
}

/** 当前正在跑的那份代码在哪(版本化安装在 versions/<ver>/,平铺安装就是根目录)。 */
function currentCodeDir() {
  try {
    const ver = fs.readFileSync(path.join(ROOT, 'current.txt'), 'utf8').trim();
    const d = path.join(VERSIONS_DIR, ver);
    if (ver && fs.existsSync(path.join(d, 'package.json'))) return d;
  } catch {}
  return fs.existsSync(path.join(ROOT, 'package.json')) ? ROOT : null;
}

/**
 * 装依赖。**依赖没变就直接复用当前版本的 node_modules,连 npm 都不启动。**
 *
 * 绝大多数版本更新只改代码不动依赖,却每次都要联网重装一遍 —— 慢,而且是
 * 整条更新链路上最容易炸的一环:npm 10 不认 better-sqlite3 的 "gypfile": false,
 * 会去跑 node-gyp rebuild,在没有 Python 的 Windows 上直接把更新卡死
 * (实测 Windows 10.0.26200 / node v24.15.0 更新 1.0.6 时就死在这里)。
 *
 * 复制失败或依赖确实变了,才退回 npm install。
 */
async function installDeps(stagingDir) {
  const from = currentCodeDir();
  const src = from && path.join(from, 'node_modules');

  if (src && fs.existsSync(src) && depsFingerprint(from) && depsFingerprint(from) === depsFingerprint(stagingDir)) {
    try {
      fs.cpSync(src, path.join(stagingDir, 'node_modules'), { recursive: true });
      return { mode: 'reused', from };
    } catch {
      // 复制失败(权限/磁盘满/文件占用)就老老实实装
    }
  }
  await npmInstall(stagingDir);
  return { mode: 'installed' };
}

module.exports = { checkUpdate, stageUpdate, applyUpdate, currentVersion };
