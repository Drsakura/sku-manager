const db = require('../db/db');
const { chat, parseJsonReply } = require('./aiClient');

/**
 * 对话式助手。
 *
 * 核心约束:**模型不接触数据库,也不允许自己编数字**。
 * 流程是三步:
 *   1. 模型只做"意图识别" → 返回 {tool, args} 这样一个调用计划
 *   2. 服务端用参数化 SQL 真正取数(模型碰不到 SQL,不存在注入)
 *   3. 把取到的真实行喂回模型,让它组织成人话
 *
 * 返回值同时带上 rows —— 界面要把真实数据表也显示出来。
 * 答案是方便,数据才是依据;报价请以表格里的数字为准。
 */

const TOOLS = {
  search_products: {
    desc: '按关键词搜产品/货号/规格/参数,返回价格与供应商。args: {keyword, supplier?}',
    run: ({ keyword, supplier }) => {
      const like = `%${String(keyword || '').trim()}%`;
      const rows = db
        .prepare(
          `SELECT p.display_sku AS 货号, g.name AS 产品, p.spec AS 规格,
                  p.price AS 采购价, p.moq AS 起订量, s.name AS 供应商,
                  p.last_updated AS 更新时间, p.confidence AS 可信度
           FROM products p
           LEFT JOIN product_groups g ON g.id = p.group_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE (p.sku LIKE @q OR p.display_sku LIKE @q OR p.name LIKE @q
                  OR p.spec LIKE @q OR p.description LIKE @q OR g.name LIKE @q
                  OR p.sku IN (SELECT a.sku FROM item_attributes a
                               WHERE a.sku IS NOT NULL AND (a.name LIKE @q OR a.value LIKE @q)))
             ${supplier ? 'AND s.name LIKE @sup' : ''}
           ORDER BY p.price ASC LIMIT 40`
        )
        .all(supplier ? { q: like, sup: `%${supplier}%` } : { q: like });
      return rows;
    },
  },

  product_detail: {
    desc: '看某个货号的完整信息:价格、起订量、规格参数、交付要求。args: {sku}',
    run: ({ sku }) => {
      const key = String(sku || '').toUpperCase().replace(/[\s\-_./]/g, '');
      const p = db
        .prepare(
          `SELECT p.display_sku AS 货号, g.name AS 产品, p.spec AS 规格, p.price AS 采购价,
                  p.moq AS 起订量, s.name AS 供应商, p.description AS 交付要求,
                  p.source_contract AS 来源合同, p.last_updated AS 更新时间
           FROM products p
           LEFT JOIN product_groups g ON g.id = p.group_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE p.sku = ?`
        )
        .get(key);
      if (!p) return [];
      const attrs = db
        .prepare('SELECT name AS 参数, value AS 值 FROM item_attributes WHERE sku = ? ORDER BY sort, id')
        .all(key);
      return [{ ...p, 参数: attrs.map((a) => `${a.参数}=${a.值}`).join('; ') || null }];
    },
  },

  price_history: {
    desc: '查某个货号的调价历史。args: {sku}',
    run: ({ sku }) => {
      const key = String(sku || '').toUpperCase().replace(/[\s\-_./]/g, '');
      return db
        .prepare(
          `SELECT changed_at AS 时间, old_price AS 原价, new_price AS 新价,
                  source_contract AS 来源
           FROM price_history WHERE sku = ? ORDER BY changed_at DESC LIMIT 20`
        )
        .all(key);
    },
  },

  list_suppliers: {
    desc: '列出供应商及其主营类目、所在地、货号数。args: {}',
    run: () =>
      db
        .prepare(
          `SELECT s.name AS 供应商, s.main_categories AS 主营类目, s.address AS 地址,
                  s.contact_person AS 联系人, s.phone AS 电话,
                  (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS 货号数
           FROM suppliers s ORDER BY s.name`
        )
        .all(),
  },

  compare_suppliers: {
    desc: '同类产品跨供应商比价,找最便宜的来源。args: {keyword}',
    run: ({ keyword }) => {
      const like = `%${String(keyword || '').trim()}%`;
      return db
        .prepare(
          `SELECT s.name AS 供应商, g.name AS 产品, p.display_sku AS 货号,
                  p.price AS 采购价, p.moq AS 起订量
           FROM products p
           LEFT JOIN product_groups g ON g.id = p.group_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE (g.name LIKE @q OR p.name LIKE @q OR p.display_sku LIKE @q)
             AND p.price IS NOT NULL
           ORDER BY p.price ASC LIMIT 40`
        )
        .all({ q: like });
    },
  },

  recent_changes: {
    desc: '最近有哪些产品调过价。args: {limit?}',
    run: ({ limit }) =>
      db
        .prepare(
          `SELECT h.changed_at AS 时间, p.display_sku AS 货号, g.name AS 产品,
                  h.old_price AS 原价, h.new_price AS 新价, h.source_contract AS 来源
           FROM price_history h
           LEFT JOIN products p ON p.sku = h.sku
           LEFT JOIN product_groups g ON g.id = p.group_id
           ORDER BY h.changed_at DESC LIMIT ?`
        )
        .all(Math.min(Number(limit) || 15, 50)),
  },
};

const PLANNER_PROMPT = `你是产品库查询助手的"意图识别"环节。根据用户问题,选一个最合适的查询工具。

可用工具:
${Object.entries(TOOLS).map(([k, v]) => `- ${k}: ${v.desc}`).join('\n')}

只输出 JSON,格式:{"tool":"工具名","args":{...},"reason":"一句话说明"}
若问题与产品库无关(闲聊、常识问题等),返回 {"tool":"none","args":{},"reason":"原因"}。`;

const ANSWER_PROMPT = `你是采购报价助手。下面给你的是从产品数据库里**真实查到的数据**。

要求:
1. 只依据给定数据回答,数据里没有的一律说"库里没有",绝对不要推测或补全任何数字。
2. 价格、起订量必须原样引用,不要四舍五入、不要换算、不要估算。
3. 回答简洁,直接给结论。涉及多条记录时按重点说,不要逐条复述(用户能看到完整表格)。
4. 用中文回答。`;

// 疑问句里的常见成分,兜底搜索前要剥掉,否则会拿整句话去 LIKE 匹配
const QUESTION_NOISE =
  /(多少钱|多少|价格|价钱|报价|单价|起订量|最低|最便宜|最贵|是多少|怎么样|如何|有没有|有哪些|哪些|哪个|什么|请问|帮我|查一下|查询|看一下|告诉我|的|吗|呢|了|啊|？|\?|。|,|,|!|！)/g;

/**
 * 模型不可用时的关键词提取:剥掉疑问词后再搜;
 * 若剥完还是搜不到,退而求其次用最长的中文/字母数字片段再试一次。
 */
function fallbackKeywords(question) {
  const stripped = String(question).replace(QUESTION_NOISE, ' ').trim();
  const out = [];
  if (stripped) out.push(stripped.replace(/\s+/g, ''));

  const tokens = (String(question).match(/[一-龥]{2,}|[A-Za-z0-9][A-Za-z0-9\-/.]{1,}/g) || [])
    .map((t) => t.replace(QUESTION_NOISE, ''))
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const t of tokens) if (!out.includes(t)) out.push(t);

  // 子串匹配的局限:「绝缘工具」在库里是"6件套绝缘套装工具",并非连续子串。
  // 所以长词再降一级,用 2~3 字前缀兜底(如 绝缘),宁可宽一点也别空手。
  for (const t of tokens) {
    if (!/[一-龥]/.test(t)) continue;
    for (const len of [3, 2]) {
      const pre = t.slice(0, len);
      if (pre.length === len && !out.includes(pre)) out.push(pre);
    }
  }

  return out.length ? out : [String(question).trim()];
}

/** 让模型选工具;失败时用关键词兜底,保证离线/模型抽风也有基本可用性。 */
async function plan(question) {
  try {
    const { content } = await chat(
      [
        { role: 'system', content: PLANNER_PROMPT },
        { role: 'user', content: question },
      ],
      { json: true }
    );
    const p = parseJsonReply(content);
    if (p && typeof p.tool === 'string') return p;
  } catch (e) {
    return { tool: '_fallback', args: { keyword: question }, reason: '模型不可用,退回关键词搜索', error: e.message };
  }
  return { tool: '_fallback', args: { keyword: question }, reason: '未能识别意图,退回关键词搜索' };
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q) throw new Error('问题不能为空');

  const p = await plan(q);

  if (p.tool === 'none') {
    return { answer: '这个问题和产品库无关,我只能回答库里有的产品、价格、供应商相关问题。', rows: [], tool: 'none' };
  }

  const toolName = TOOLS[p.tool] ? p.tool : 'search_products';
  let args = p.tool === '_fallback' ? { keyword: q } : p.args || {};

  let rows;
  try {
    if (p.tool === '_fallback') {
      // 依次尝试剥过疑问词的关键词,命中即停
      for (const kw of fallbackKeywords(q)) {
        rows = TOOLS.search_products.run({ keyword: kw });
        if (rows.length) {
          args = { keyword: kw };
          break;
        }
      }
      rows = rows || [];
    } else {
      rows = TOOLS[toolName].run(args);
    }
  } catch (e) {
    throw new Error(`查询失败: ${e.message}`);
  }

  if (!rows.length) {
    return {
      answer: '库里没有查到相关记录。可以换个关键词,或确认这个型号的合同是否已经导入。',
      rows: [],
      tool: toolName,
      args,
      degraded: !!p.error,
    };
  }

  // 取数成功但模型不可用时,直接把数据给用户 —— 有表格总比什么都没有强
  let answer;
  try {
    const { content } = await chat([
      { role: 'system', content: ANSWER_PROMPT },
      { role: 'user', content: `用户问题:${q}\n\n查询结果(JSON):\n${JSON.stringify(rows, null, 1)}` },
    ]);
    answer = content.trim();
  } catch (e) {
    answer = `共查到 ${rows.length} 条记录(模型不可用,以下为原始数据)。`;
  }

  return { answer, rows, tool: toolName, args, reason: p.reason, degraded: !!p.error };
}

module.exports = { ask, TOOLS };
