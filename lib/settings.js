const db = require('../db/db');

const DEFAULTS = {
  ai_enabled: '0',
  ai_base_url: '', // 发布公开仓库后不放内网 IP,各端在设置里自填
  ai_model: 'qwen2.5:14b',
  ai_timeout_ms: '180000',
  update_repo: '', // 如 'wayne/sku-manager' 或 'owner/repo';空 = 自动更新关闭
  // 私有仓库必填(只读 token,仅需 Contents:Read 权限);公开仓库留空即可。
  // 存在本机数据库里,不进 git,不随更新包分发。
  update_token: '',
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function get(key) {
  const row = getStmt.get(key);
  return row ? row.value : DEFAULTS[key];
}

function set(key, value) {
  setStmt.run({ key, value: value === null || value === undefined ? null : String(value) });
}

function all() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  return out;
}

const aiConfig = () => ({
  enabled: get('ai_enabled') === '1',
  baseUrl: String(get('ai_base_url') || '').replace(/\/+$/, ''),
  model: get('ai_model'),
  timeoutMs: Number(get('ai_timeout_ms')) || 180000,
});

module.exports = { get, set, all, aiConfig, DEFAULTS };
