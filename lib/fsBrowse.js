const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 目录浏览:给界面上的"选择文件夹"用。
 *
 * 只列目录名,不读文件内容、不列文件。服务绑定 127.0.0.1,
 * 与已有的"扫描指定文件夹"是同一信任级别。
 */

/** Windows 下枚举可用盘符;其余系统根目录只有 /。 */
function listRoots() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  const roots = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try {
      fs.accessSync(drive);
      roots.push({ name: drive, path: drive });
    } catch { /* 该盘符不存在 */ }
  }
  return roots;
}

/** 常用位置,省得从根目录一层层点。 */
function shortcuts() {
  const home = os.homedir();
  const list = [
    { name: '主目录', path: home },
    { name: '桌面', path: path.join(home, 'Desktop') },
    { name: '文档', path: path.join(home, 'Documents') },
    { name: '下载', path: path.join(home, 'Downloads') },
  ];
  return list.filter((s) => {
    try {
      return fs.statSync(s.path).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 列出某个目录下的子目录。
 * @param {string} dir 空字符串 = 返回根/盘符列表
 */
function list(dir) {
  if (!dir) {
    return { path: '', parent: null, roots: listRoots(), shortcuts: shortcuts(), entries: [] };
  }

  const abs = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { error: '路径不存在' };
  }
  if (!stat.isDirectory()) return { error: '这不是一个文件夹' };

  let entries = [];
  let readError = null;
  try {
    entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith('.')) return false; // 隐藏目录不显示
        if (process.platform === 'win32' && /^(System Volume Information|\$Recycle\.Bin)$/i.test(e.name)) return false;
        return true;
      })
      .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch (e) {
    // 没权限的目录不该让整个浏览器挂掉,给个提示继续
    readError = e.code === 'EPERM' || e.code === 'EACCES' ? '没有访问该目录的权限' : e.message;
  }

  const parent = path.dirname(abs);
  return {
    path: abs,
    // 已在根目录时 dirname 会返回自身,此时上一级应回到盘符列表
    parent: parent === abs ? '' : parent,
    entries,
    readError,
    roots: listRoots(),
    shortcuts: shortcuts(),
  };
}

/** 新建子目录,便于"就在这里建一个新文件夹"。 */
function makeDir(parent, name) {
  const clean = String(name || '').trim();
  if (!clean) return { error: '文件夹名不能为空' };
  if (/[\\/:*?"<>|]/.test(clean)) return { error: '文件夹名不能包含 \\ / : * ? " < > |' };
  const target = path.join(path.resolve(parent), clean);
  try {
    fs.mkdirSync(target, { recursive: false });
    return { ok: true, path: target };
  } catch (e) {
    if (e.code === 'EEXIST') return { error: '同名文件夹已存在' };
    return { error: e.message };
  }
}

module.exports = { list, makeDir, listRoots, shortcuts };
