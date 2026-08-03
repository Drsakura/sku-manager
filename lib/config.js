const fs = require('fs');
const path = require('path');

/**
 * 安装级配置(config.json)。
 *
 * 为什么不存数据库:这里配的正是"数据库放哪",存进去会成死循环。
 * 为什么不只用环境变量:用户要在界面上改,总不能让他去配环境变量。
 *
 * 位置在**安装根目录**(versions/ 的上一级),这样版本更新不会覆盖它。
 * 查找顺序兼顾两种布局:
 *   平铺安装:   <root>/config.json,代码也在 <root>
 *   版本化安装: <root>/config.json,代码在 <root>/versions/<ver>/
 */
const CANDIDATES = [
  path.join(__dirname, '..', 'config.json'), // 平铺:lib/../
  path.join(__dirname, '..', '..', '..', 'config.json'), // 版本化:versions/<ver>/lib/../../../
];

function configPath() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return CANDIDATES[0];
}

function read() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function write(patch) {
  const merged = { ...read(), ...patch };
  // 空字符串表示"恢复默认",不留空键
  for (const k of Object.keys(merged)) {
    if (merged[k] === '' || merged[k] === null) delete merged[k];
  }
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/** 校验一个目录是否可用作数据目录:必须存在(或可创建)且可写。 */
function checkDir(dir) {
  if (!dir) return { ok: true }; // 空 = 用默认
  const abs = path.resolve(dir);
  try {
    fs.mkdirSync(abs, { recursive: true });
    const probe = path.join(abs, '.write-test');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return { ok: true, resolved: abs };
  } catch (e) {
    return { ok: false, error: `无法写入该目录:${e.message}` };
  }
}

module.exports = { read, write, configPath, checkDir };
