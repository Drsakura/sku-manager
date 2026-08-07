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

/* ----------------------- 工具调用(function calling) ----------------------- */

/**
 * 两家的线格式差得很细碎,统一在这里抹平。内部一律用这套"规范格式":
 *   助手要调工具:  {role:'assistant', content:'', tool_calls:[{id, name, args:对象}]}
 *   工具回结果:    {role:'tool', tool_call_id, name, content:'字符串'}
 *
 * 差异清单(踩过的坑):
 *   - OpenAI 的 arguments 是 **JSON 字符串**,Ollama 的是 **对象**
 *   - OpenAI 靠 tool_call_id 配对,Ollama 没有 id,靠 tool_name(旧版连这个都没有)
 *   - 开了 tools 就不能再开 json 强制输出,两者互斥,否则模型只会吐 JSON 不调工具
 */
function toWireMessages(messages, isCloud) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map((c, i) =>
          isCloud
            ? {
                id: c.id || `call_${i}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
              }
            : { function: { name: c.name, arguments: c.args ?? {} } }
        ),
      };
    }
    if (m.role === 'tool') {
      return isCloud
        ? { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') }
        : { role: 'tool', tool_name: m.name, content: String(m.content ?? '') };
    }
    return { role: m.role, content: String(m.content ?? '') };
  });
}

function toWireTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

/** 把模型回复里的 tool_calls 拉平成规范格式;参数解析失败的调用整条丢弃。 */
function parseToolCalls(raw, isCloud) {
  const calls = Array.isArray(raw) ? raw : [];
  const out = [];
  calls.forEach((c, i) => {
    const fn = c.function || c;
    const name = fn.name;
    if (!name) return;
    let args = fn.arguments;
    if (typeof args === 'string') {
      // 空串是合法的"无参调用";小模型偶尔给 "{}" 之外的垃圾,解析不了就当没调
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        return;
      }
    }
    out.push({
      id: c.id || fn.id || `call_${i}`,
      name: String(name),
      args: args && typeof args === 'object' ? args : {},
    });
  });
  return out;
}

/**
 * 从回复正文里把工具调用捞出来。
 *
 * 小模型(实测 qwen2.5:7b)时不时不走 tool_calls 字段,而是把调用**当文本打印**出来:
 *     好的,我将直接调用 scan_contract_suppliers。
 *     ```json
 *     {"name": "scan_contract_suppliers", "arguments": {}}
 *     ```
 * 不管的话它就永远停在"我这就去做"上,活干不完。这里按工具名白名单捞回来 ——
 * 名字对不上的一概不认,所以不会把正文里的普通 JSON 误当成调用。
 *
 * @returns {{calls:Array, text:string}} text 是剔掉这些 JSON 之后的正文
 */
function salvageToolCalls(content, tools) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const calls = [];
  let text = content;

  const asObject = (v) => {
    if (typeof v === 'string') {
      try {
        return v.trim() ? JSON.parse(v) : {};
      } catch {
        return {};
      }
    }
    return v && typeof v === 'object' ? v : {};
  };

  // 扫出所有配平的 {...},逐个试解析。逐字符扫是为了能处理嵌套的 arguments。
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < content.length; j++) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) break;

    const chunk = content.slice(i, end + 1);
    let obj;
    try {
      obj = JSON.parse(chunk);
    } catch {
      i = end;
      continue;
    }

    let name = obj?.name || obj?.function?.name || obj?.tool;
    let args = null;

    if (typeof name === 'string' && byName.has(name)) {
      args = asObject(obj.arguments ?? obj.parameters ?? obj.args ?? obj?.function?.arguments ?? {});
    } else {
      // 只吐了**参数**、没带工具名的情况(实测 7b 很爱这么干):
      //   明白了,我直接执行 `apply_supplier_extraction`。
      //   ```json
      //   {"skip":[...],"overrides":[...]}
      //   ```
      // 认法:前文近处点过某个工具的名字,且这堆键全都是那个工具的合法参数。
      // 两条都卡住,普通 JSON 不会被误当成调用。
      const before = content.slice(Math.max(0, i - 240), i);
      const mentioned = [...byName.keys()].filter((n) => before.includes(n)).pop();
      const props = mentioned ? Object.keys(byName.get(mentioned).parameters?.properties || {}) : [];
      const keys = Object.keys(obj);
      if (mentioned && keys.length && props.length && keys.every((k) => props.includes(k))) {
        name = mentioned;
        args = obj;
      }
    }

    if (args) {
      calls.push({ id: `salvaged_${calls.length}`, name, args });
      text = text.replace(chunk, '');
    }
    i = end; // 已经吃掉的部分不再重扫
  }

  // 连带清掉包着它的空代码块
  text = text.replace(/```(?:json)?\s*```/g, '').trim();
  return { calls, text };
}

/**
 * 通用对话调用,两种后端统一入口。
 * @param {Array} messages 规范格式消息数组
 * @param {object} opts { json: 强制 JSON 输出, tools: 工具定义数组 }
 * @returns {{content:string, toolCalls:Array, usage:object|null}}
 */
async function chat(messages, { json = false, tools = null, temperature = 0, overrides = {} } = {}) {
  const cfg = { ...aiConfig(), ...overrides };
  if (!cfg.baseUrl) throw new Error(cfg.provider === 'cloud' ? '未配置云端接口地址' : '未配置本地 AI 地址');
  if (cfg.provider === 'cloud' && !cfg.apiKey) throw new Error('未填 API Key');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const isCloud = cfg.provider === 'cloud';
    const url = isCloud ? `${cfg.baseUrl}/v1/chat/completions` : `${cfg.baseUrl}/api/chat`;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const forceJson = json && !hasTools; // 互斥:强制 JSON 会让模型放弃调工具
    const wire = toWireMessages(messages, isCloud);

    const body = isCloud
      ? {
          model: cfg.model,
          messages: wire,
          temperature,
          stream: false,
          ...(hasTools ? { tools: toWireTools(tools) } : {}),
          ...(forceJson ? { response_format: { type: 'json_object' } } : {}),
        }
      : {
          model: cfg.model,
          messages: wire,
          stream: false,
          options: { temperature, num_ctx: cfg.numCtx || 16384 },
          ...(hasTools ? { tools: toWireTools(tools) } : {}),
          ...(forceJson ? { format: 'json' } : {}),
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
    const msg = (isCloud ? data?.choices?.[0]?.message : data?.message) || {};
    let content = msg.content || '';
    let toolCalls = parseToolCalls(msg.tool_calls, isCloud);

    // 正经走 tool_calls 的就不用管;一个都没有才去正文里捞
    if (!toolCalls.length && hasTools && content.includes('{')) {
      const salvaged = salvageToolCalls(content, tools);
      if (salvaged.calls.length) {
        toolCalls = salvaged.calls;
        content = salvaged.text;
      }
    }

    return { content, toolCalls, usage: data?.usage || null };
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

