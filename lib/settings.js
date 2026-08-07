const db = require('../db/db');

const DEFAULTS = {
  ai_enabled: '0',
  // local = 自己机器/内网上的 Ollama;cloud = DeepSeek / OpenAI 等兼容接口
  ai_provider: 'local',
  ai_base_url: '', // 发布公开仓库后不放内网 IP,各端在设置里自填
  ai_model: 'qwen2.5:14b',
  // 一份十几个品的合同,14B 在 M4 上要跑到 160 秒上下 —— 180 秒的余量太薄,
  // 稍微长一点的合同就会卡在超时上,看起来像"AI 不工作"。留足到 5 分钟。
  ai_timeout_ms: '300000',
  // Ollama 不给 num_ctx 就默认 2048 —— 助手多轮调工具时会被硬生生截断,
  // 表现为"聊到一半忘了前面查过什么"。给足上下文,内存不够再往下调。
  ai_num_ctx: '16384',
  // 云端接口配置(选 cloud 时用)
  ai_cloud_preset: 'deepseek', // deepseek | openai | custom
  ai_cloud_base_url: '',
  ai_cloud_model: '',
  ai_cloud_key: '', // 密钥,不回传前端、不进备份、不进 git
  // 官方更新源,开箱即用,不需要用户填。自建分发时可改这里或在设置里覆盖。
  update_repo: 'Drsakura/sku-manager',
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

/** 不该离开本机的键:不回传前端、不写进备份文件。 */
const SECRET_KEYS = ['update_token', 'ai_cloud_key'];

/**
 * 更新源仓库。老版本默认值是空串,升级后库里那条空记录会盖过新默认值,
 * 导致自动更新静默失效 —— 所以这里空值一律回落到默认仓库。
 */
const updateRepo = () => (get('update_repo') || '').trim() || DEFAULTS.update_repo;

const CLOUD_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', label: 'DeepSeek' },
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini', label: 'OpenAI' },
};

const aiConfig = () => {
  const provider = get('ai_provider') === 'cloud' ? 'cloud' : 'local';
  const timeoutMs = Number(get('ai_timeout_ms')) || 180000;

  if (provider === 'local') {
    return {
      provider,
      enabled: get('ai_enabled') === '1',
      baseUrl: String(get('ai_base_url') || '').replace(/\/+$/, ''),
      model: get('ai_model'),
      numCtx: Number(get('ai_num_ctx')) || 16384,
      timeoutMs,
    };
  }

  const preset = CLOUD_PRESETS[get('ai_cloud_preset')] || null;
  return {
    provider,
    enabled: get('ai_enabled') === '1',
    baseUrl: String(get('ai_cloud_base_url') || preset?.baseUrl || '').replace(/\/+$/, ''),
    model: get('ai_cloud_model') || preset?.model || '',
    apiKey: get('ai_cloud_key') || '',
    timeoutMs,
  };
};

module.exports = { get, set, all, aiConfig, updateRepo, DEFAULTS, SECRET_KEYS, CLOUD_PRESETS };
