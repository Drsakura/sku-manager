const { aiConfig } = require('./settings');

/**
 * 两种后端:
 *   local — 自己机器/内网上的 Ollama(/api/chat)
 *   cloud — DeepSeek / OpenAI 等 OpenAI 兼容接口(/v1/chat/completions)
 *
 * 两者输出都要过 lib/verify 的原文校验才允许写库,见 ingest.parseWithAi。
 */

const SYSTEM_PROMPT = `你是采购合同解析助手。用户会给你一份合同的纯文本(由 Excel 或 PDF 提取,排版可能错乱)。

请提取其中的产品行,以 JSON 返回,格式:
{"products":[{"sku":"型号","name":"中文品名","price":单价数字,"moq":最小起订量或null,"description":"该型号的规格/材质/配件/包装要求"}]}

严格遵守:
1. 只提取真实存在于原文的内容。看不清、不确定的一律留空或省略该行,绝对不要推测、补全或计算任何数字。
2. price 必须是"单价",不是总金额、不是数量。若同一行有单价和总价,取单价。
3. moq 是"最小起订量/起订量/MOQ/最小包装量"。合同数量、采购数量、订单数量都不是 moq,遇到这些一律填 null。
4. sku 取采购方用来下单的货号(通常是"客户货号""型号""物料编码")。若同时存在工厂货号和客户货号,优先客户货号。
5. 合同下方的质量条款、包装要求、付款方式等段落不是产品行,不要当成产品。但如果某段明确写明属于某个型号,把它放进该型号的 description。
6. 只输出 JSON,不要解释,不要 markdown 代码块。`;

const PROBE_TIMEOUT_MS = 10000;

function cloudHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

/** 连通性探测。本地返回已安装模型列表,云端验证密钥有效性。 */
async function probe(overrides = {}) {
  const cfg = { ...aiConfig(), ...overrides };
  if (!cfg.baseUrl) return { ok: false, error: '未配置地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    if (cfg.provider === 'cloud') {
      if (!cfg.apiKey) return { ok: false, error: '未填 API Key' };
      const res = await fetch(`${cfg.baseUrl}/v1/models`, {
        headers: cloudHeaders(cfg),
        signal: controller.signal,
      });
      if (res.status === 401) return { ok: false, error: 'API Key 无效或已过期' };
      if (res.status === 402) return { ok: false, error: '账户余额不足' };
      if (!res.ok) return { ok: false, error: `接口返回 ${res.status}` };
      const data = await res.json().catch(() => ({}));
      const models = (data.data || []).map((m) => m.id);
      return {
        ok: true,
        provider: 'cloud',
        models,
        // 有些服务商不返回完整模型列表,列表为空时不判定模型不存在
        modelInstalled: models.length === 0 ? true : models.includes(cfg.model),
        model: cfg.model,
      };
    }

    const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `服务返回 ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return {
      ok: true,
      provider: 'local',
      models,
      modelInstalled: models.includes(cfg.model),
      model: cfg.model,
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '连接超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型回复里抠出 JSON —— 小模型偶尔会加 markdown 代码块包裹。 */
function parseJsonReply(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型未返回可解析的 JSON');
    return JSON.parse(m[0]);
  }
}

/**
 * 通用对话调用,两种后端统一入口。
 * @param {Array} messages [{role, content}]
 * @param {object} opts { json: 是否强制 JSON 输出 }
 */
async function chat(messages, { json = false, overrides = {} } = {}) {
  const cfg = { ...aiConfig(), ...overrides };
  if (!cfg.baseUrl) throw new Error(cfg.provider === 'cloud' ? '未配置云端接口地址' : '未配置本地 AI 地址');
  if (cfg.provider === 'cloud' && !cfg.apiKey) throw new Error('未填 API Key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const isCloud = cfg.provider === 'cloud';
    const url = isCloud ? `${cfg.baseUrl}/v1/chat/completions` : `${cfg.baseUrl}/api/chat`;
    const body = isCloud
      ? {
          model: cfg.model,
          messages,
          temperature: 0,
          stream: false,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }
      : {
          model: cfg.model,
          messages,
          stream: false,
          options: { temperature: 0 },
          ...(json ? { format: 'json' } : {}),
        };

    const res = await fetch(url, {
      method: 'POST',
      headers: isCloud ? cloudHeaders(cfg) : { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('API Key 无效或已过期');
      if (res.status === 402) throw new Error('账户余额不足');
      if (res.status === 429) throw new Error('请求过于频繁,稍后再试');
      throw new Error(`模型服务返回 ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }

    const data = await res.json();
    const content = isCloud
      ? data?.choices?.[0]?.message?.content || ''
      : data?.message?.content || '';
    return { content, usage: data?.usage || null };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`模型处理超时(${cfg.timeoutMs / 1000}秒)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把合同文本交给模型解析。
 * 返回的行**未经校验**,调用方必须先过 verifyRows。
 */
async function extractProducts(sourceText, overrides = {}) {
  // 超长合同截断,避免撑爆上下文;绝大多数采购合同远小于这个长度
  const text = String(sourceText || '').slice(0, 60000);

  const { content } = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    { json: true, overrides }
  );

  const parsed = parseJsonReply(content);
  const products = Array.isArray(parsed) ? parsed : parsed.products || parsed.items || [];
  if (!Array.isArray(products)) throw new Error('模型返回的结构不是产品数组');
  return products;
}

module.exports = { probe, chat, extractProducts, parseJsonReply, SYSTEM_PROMPT };
