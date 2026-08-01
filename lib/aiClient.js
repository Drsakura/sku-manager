const { aiConfig } = require('./settings');

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

/** 探测 Ollama 是否可达,顺便拿到已安装的模型列表。 */
async function probe(overrides = {}) {
  const cfg = { ...aiConfig(), ...overrides };
  if (!cfg.baseUrl) return { ok: false, error: '未配置地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `服务返回 ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return {
      ok: true,
      models,
      modelInstalled: models.includes(cfg.model),
      model: cfg.model,
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '连接超时' : err.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把合同文本交给本地模型解析。
 * 返回的行**未经校验**,调用方必须先过 verifyRows。
 */
async function extractProducts(sourceText, overrides = {}) {
  const cfg = { ...aiConfig(), ...overrides };
  if (!cfg.baseUrl) throw new Error('未配置本地 AI 地址');

  // 超长合同截断,避免撑爆上下文;绝大多数采购合同远小于这个长度
  const text = String(sourceText || '').slice(0, 60000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 }, // 抽取任务不需要创造性
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`模型服务返回 ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
    }

    const data = await res.json();
    const content = data?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // format:json 理论上保证是 JSON,但小模型偶尔会加代码块包裹
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('模型未返回可解析的 JSON');
      parsed = JSON.parse(m[0]);
    }

    const products = Array.isArray(parsed) ? parsed : parsed.products || parsed.items || [];
    if (!Array.isArray(products)) throw new Error('模型返回的结构不是产品数组');
    return products;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`模型处理超时(${cfg.timeoutMs / 1000}秒)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probe, extractProducts, SYSTEM_PROMPT };
