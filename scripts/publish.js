#!/usr/bin/env node
/**
 * 发布管线:打包当前版本 → 传 GitHub Release
 *
 * 用法:
 *   node scripts/publish.js [patch|minor|major] [owner/repo]
 *    - 第一个参数若给 patch/minor/major,会先 npm version <type> 升版号并打 tag
 *    - 第二个参数可指定 owner/repo,优先级低于环境变量 GITHUB_REPO
 *   node scripts/publish.js --dry-run
 *    - 只打包并列出包内文件,不升版号、不 push、不建 Release。
 *      发版前自查用:确认没把 data/、archive/、.env 打进去。
 *
 * 环境变量:
 *   GITHUB_TOKEN  必填,用于创建 Release 和上传 asset
 *   GITHUB_REPO   仓库 owner/repo(如 Drsakura/sku-manager)
 *   RELEASE_NOTES 可选,发布说明
 *
 * 产物:
 *   dist/sku-manager-<ver>.zip
 *   dist/sku-manager-<ver>.zip.sha256   (客户端解压前校验)
 */
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

// macOS/Linux 启动脚本:入包时要单独打上可执行位
const SHELL_ENTRIES = ['start.command'];

// 支持从 <root>/.env 读 GITHUB_TOKEN / GITHUB_REPO / RELEASE_NOTES(该文件已 gitignore)
(function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] === undefined) {
      process.env[key] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));
const bump = positional[0];
const repoArg = positional[1];

const GITHUB_REPO = process.env.GITHUB_REPO || repoArg;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RELEASE_NOTES = process.env.RELEASE_NOTES || '';

async function main() {
  // 0) 试跑:只打包 + 列内容,不动版本号、不联网
  if (DRY_RUN) {
    const version = require(path.join(ROOT, 'package.json')).version;
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const zipPath = path.join(DIST_DIR, `sku-manager-${version}-dryrun.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    await createZip(zipPath);

    const AdmZip = require('adm-zip');
    const names = new AdmZip(zipPath).getEntries().map((e) => e.entryName);
    const leaked = names.filter((n) =>
      /^(data|archive|inbox|versions|dist|node_modules)\//.test(n) || /^\.env/.test(n) ||
      /\.(db|xlsx|xls|pdf)$/i.test(n) ||
      // 本机状态文件:发出去会让别人的安装指向不存在的版本/路径
      /^(current\.txt|config\.json)$/.test(n)
    );

    console.log(`>> 试跑打包: ${path.relative(ROOT, zipPath)}`);
    console.log(`>> 版本 ${version} · ${names.length} 个文件 · ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB`);
    console.log('>> 包内文件:');
    for (const n of names.sort()) console.log('     ' + n);
    console.log('');
    if (leaked.length) {
      console.error('!! 检测到不该入包的文件:');
      for (const n of leaked) console.error('     ' + n);
      process.exit(1);
    }
    console.log('✓ 未发现数据文件/密钥泄漏。未发布,未推送,未改版本号。');
    return;
  }

  // 1) 升版号(可选)
  if (bump) {
    if (!/^(patch|minor|major)$/.test(bump)) {
      console.error(`无效的升版类型: ${bump}(应为 patch/minor/major)`);
      process.exit(1);
    }
    console.log(`>> npm version ${bump}`);
    execSync(`npm version ${bump}`, { stdio: 'inherit', cwd: ROOT });
  }

  // 2) 读版本
  const pkg = require(path.join(ROOT, 'package.json'));
  const version = pkg.version;
  const tag = `v${version}`;
  console.log(`>> 当前版本: ${version} (${tag})`);

  if (!GITHUB_REPO) {
    console.error('缺少仓库参数:请设环境变量 GITHUB_REPO(owner/repo)或传第二个参数');
    process.exit(1);
  }
  if (!GITHUB_TOKEN) {
    console.error('缺少 GITHUB_TOKEN 环境变量(只在开发机配置,不入库)');
    process.exit(1);
  }

  // 3) 打包
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipPath = path.join(DIST_DIR, `sku-manager-${version}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  await createZip(zipPath);
  console.log(`>> 已打包: ${path.relative(ROOT, zipPath)} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB)`);

  // 4) sha256
  const sha = crypto
    .createHash('sha256')
    .update(fs.readFileSync(zipPath))
    .digest('hex');
  const shaPath = `${zipPath}.sha256`;
  fs.writeFileSync(shaPath, sha, 'utf8');
  console.log(`>> sha256: ${sha.slice(0, 16)}…  → ${path.relative(ROOT, shaPath)}`);

  // 5) 推送(尽力而为,失败不阻断 Release——tag 由 release 里 target_commitish 兜底)
  for (const cmd of ['git push', 'git push --tags']) {
    try {
      execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
      console.warn(`!! ${cmd} 失败:${e.message.split('\n')[0]}(可稍后手动 git push --tags)`);
    }
  }

  // 6) 建 Release + 传 asset
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const apiBase = 'https://api.github.com';

  console.log(`>> 创建 Release ${tag} @ ${GITHUB_REPO}`);
  const relResp = await fetch(`${apiBase}/repos/${GITHUB_REPO}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: RELEASE_NOTES || `自动发布 ${tag}`,
      target_commitish: 'main',
    }),
  });
  if (!relResp.ok) {
    const err = await relResp.text();
    console.error(`创建 Release 失败(${relResp.status}):${err}`);
    process.exit(1);
  }
  const release = await relResp.json();
  const uploadBase = release.upload_url.replace(/\{[^}]*\}$/, '');

  for (const file of [zipPath, shaPath]) {
    const name = path.basename(file);
    console.log(`>> 上传 asset: ${name}`);
    const upResp = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(file),
    });
    if (!upResp.ok) {
      const err = await upResp.text();
      console.error(`上传 ${name} 失败(${upResp.status}):${err}`);
      process.exit(1);
    }
    console.log(`   ✓ ${name} (${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log(`\n完成: https://github.com/${GITHUB_REPO}/releases/tag/${tag}`);
}

function createZip(zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.glob('**/*', {
      cwd: ROOT,
      dot: true,
      ignore: [
        'node_modules/**',
        'data/**',
        'inbox/**',
        'archive/**',
        '.git/**',
        'versions/**',
        'dist/**',
        '.env',
        '.env.*',
        '*.zip',
        '.gitkeep',
        // 本机状态/配置,绝不能跟着发布包走:
        //   current.txt —— 开发机的当前版本号,发出去会让新装的机器
        //                  去找一个不存在的 versions/<旧版本>/ 而启动失败
        //   config.json —— 开发机的数据目录路径,发出去会把用户的数据
        //                  指到一个他机器上不存在的位置
        'current.txt',
        'config.json',
        // 单独入包以便设置可执行位(见下)
        ...SHELL_ENTRIES,
      ],
    });

    // Windows 文件系统没有执行位,glob 出来的 mode 是 0666。
    // macOS 用户解压后要能直接双击,必须显式打上 0755。
    for (const name of SHELL_ENTRIES) {
      const p = path.join(ROOT, name);
      if (fs.existsSync(p)) archive.file(p, { name, mode: 0o755 });
    }

    archive.finalize();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
