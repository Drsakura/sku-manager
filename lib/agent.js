const { chat } = require('./aiClient');
const { TOOLS, toolSpecs, runSearch, cleanQuery } = require('./agentTools');
const log = require('./agentLog');
const { aiConfig } = require('./settings');

/**
 * 对话式助手。
 *
 * 这里是一个**真正的 agent 循环**:模型调工具 → 看到结果 → 决定下一步 → 再调,
 * 直到它认为可以回答了。不是"猜一个工具跑一次就完事"。
 * 所以「整理一下供应商」这种活能干:它会先看库里现状、再扫合同、再判断、再落库、最后汇报。
 *
 * 两条底线没变:
 *   1. 模型永远碰不到 SQL,只能选工具填参数(工具在 agentTools.js 里写死并参数化)。
 *   2. 报价数字一律来自工具返回的真实行,rows 会原样显示给用户 ——
 *      答案是方便,表格才是依据。
 *
 * 写操作允许直接生效,但每一笔都进 agent_operations 流水且带逆操作,随时能让它退回去。
 */

const MAX_STEPS = 8; // 一轮对话里最多让它调这么多次工具,防止绕圈子烧算力
const MAX_NUDGES = 3; // "只说要调、没真调"最多顶几次
const HISTORY_TURNS = 5; // 只带最近这么多轮,再往前就该开新话题了
const RESULT_BUDGET = 20000; // 本轮工具结果喂给模型的字符上限
const STALE_RESULT_BUDGET = 1500; // 本轮里已经用过的旧结果压到这么长
const HISTORY_RESULT_BUDGET = 3000; // 往轮次里回灌的上一轮结果压到这么长

function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);

  // 最近几笔改动直接摆进提示词里。
  // 不这么做的话,「撤销刚才那步」要先 list_operations 拿流水号再 undo_operation ——
  // 多一步就多一次出错的机会,实测小模型经常在这儿走丢(把"撤销"理解成别的事)。
  let recent = '';
  try {
    const ops = log.list({ limit: 3 }).filter((o) => o.可回退 === '是');
    if (ops.length) {
      recent =
        '\n\n【你最近做过的改动】(用户说"撤销/退回去"时,直接用这里的流水号调 undo_operation,不用再查)\n' +
        ops.map((o) => `- 流水号 ${o.id}:${o.说明}`).join('\n');
    }
  } catch {
    /* 流水表还没建起来就算了,不影响正常问答 */
  }

  return `你是这个采购产品库的助理。你能直接查库,也能直接改库。今天是 ${today}。${recent}

【怎么干活】
- 先判断这件事要几步。需要多步就一步步来:调工具 → 看结果 → 再决定下一步,不要急着回答。
- 不清楚库里有什么,就先调 database_overview,别凭空假设库里有或没有某类数据。
- 用户交代的是"活"(整理供应商、清理重复、补全资料)而不是"问题"时,要把活干完:
  查清现状 → 做出判断 → 动手执行 → 汇报你改了什么。只把表格列出来不算干完。
- 工具报错了就看错误信息改参数重试,别把错误原样丢给用户。

【数据纪律】(最重要)
- 价格、起订量、货号一律原样引用工具返回的值。不许四舍五入、不许换算、不许估算、不许补全。
- 工具没返回的东西就是"库里没有",直说没有,不要编。
- 用户界面上能看到你查到的完整表格,所以回答只讲结论和重点,不要逐条复述。
- 直接给结论。不要写"如果您需要更多信息请告诉我""我们可以继续查看"这类客套话,
  该查的你自己查完再回答;问价格就报价格区间和最便宜的那个,别只挑一条讲。

【改库的规矩】
- **只在用户明确要你改的时候才用写工具。** "恩光供什么货""哪家最便宜"这些是查询,
  查完照实回答就行,不要顺手去改人家的档案。看到某个字段是空的,那不是给你的待办。
- 写操作立刻生效,但每笔都记了流水、都能原样回退,所以该动手就动手。
- **不要把判断推回给用户。** 他说"整理一下供应商",意思就是让你自己判断完、自己做完,
  不是让你列个名单回来问他哪些要跳过。判断该你做,做完在回答里说清你跳过了什么、合并了什么,
  他不认可可以让你撤销 —— 这就是留了流水和回退的意义。
  只有在"做了就没法退"或者"两种做法结果差很远、只有他知道选哪个"时才问。
- 但动手前要查清楚:比如合并两家之前,先用 supplier_detail 确认确实是同一家。
- 批量改动(影响几十上百行)先在回答里说清你打算怎么做、影响多少条,再执行。
- 用户说"撤销/退回去/刚才那步不对",就是要你调 undo_operation 把改动退回去 ——
  流水号上面已经给你了(没给就先 list_operations)。别理解成别的事,更别顺手去改其它东西。
- **联系人、电话、地址、邮箱这些库里没有的信息,只有用户明确告诉你才能写。**
  没人告诉你就如实说"库里没有,需要你提供",绝对不许自己编一个填进去。

【关于供应商】
这个库的供应商名字目前主要藏在合同文件名里,格式是「项目号-客户码 供应商（品类）」。
要整理供应商,走这条路:scan_contract_suppliers 看候选 → 你逐条判断 → apply_supplier_extraction 落库。
候选名单里一定混着不是供应商的词(样品单、外箱唛头、新订单、1米、模具这类),标了"存疑"的重点看,
该跳过的放进 skip;同一家的不同写法(如 永康大信隆 / 永康市大信隆工贸)用 overrides 归并到同一个名字。

用中文回答,说人话,不要输出 JSON 或 markdown 表格。`;
}

/** 工具结果喂给模型:用紧凑的 TSV,同样的内容比 JSON 省一半 token。 */
function serializeForModel(result) {
  if (result.error) return `工具执行失败:${result.error}`;

  const parts = [];
  if (result.message) parts.push(result.message);
  if (result.operation_id) parts.push(`(已记入流水,流水号 ${result.operation_id},可用 undo_operation 回退)`);

  // modelRows:工具可以只挑"需要模型动脑的那几行"给它看,完整表照样给界面。
  // 供应商扫描一次出 280 行,模型真正要判断的只有二十来个存疑的 ——
  // 把 280 行每步重读一遍,本地小模型光读题就耗光了时间。
  const rows = Array.isArray(result.modelRows)
    ? result.modelRows
    : Array.isArray(result.rows)
    ? result.rows
    : [];
  if (rows.length) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cell = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\n\r]/g, ' '));
    const lines = [cols.join('\t')];
    let used = lines[0].length;
    let shown = 0;
    for (const r of rows) {
      const line = cols.map((c) => cell(r[c])).join('\t');
      if (used + line.length > RESULT_BUDGET) break;
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
    parts.push(
      shown < rows.length
        ? `共 ${rows.length} 条,太长了只给你前 ${shown} 条(用户界面上看得到全部):`
        : `共 ${rows.length} 条:`
    );
    parts.push(lines.join('\n'));
  } else if (!result.message) {
    parts.push('没有结果。');
  }
  return parts.join('\n');
}

/** 跑一个工具。**出错不抛**,把错误当成结果回给模型,让它自己纠正参数重试。 */
function execTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) {
    return { error: `没有叫 ${name} 的工具。可用的是:${Object.keys(TOOLS).join(', ')}` };
  }
  try {
    const out = tool.run(args || {});
    if (Array.isArray(out)) return { rows: out };
    return out && typeof out === 'object' ? out : { message: String(out) };
  } catch (e) {
    return { error: e.message };
  }
}

/** 回答里点了某个工具的名字 —— 多半是在描述"我打算调它",而不是真调了。 */
function namesATool(text) {
  return Object.keys(TOOLS).some((n) => text.includes(n));
}

/**
 * 写自由文本进库之前,回原文核对。
 *
 * 血的教训:让它"撤销刚才那步",它理解成"补全联系方式",然后给七家供应商编了
 * 张三、李四、13800138000 写进了库。提示词里写十遍"不许编"也拦不住。
 *
 * 所以照搬合同解析那套规矩(见 lib/verify.js):**写进去的值必须在原文里找得到**。
 * 原文 = 用户说过的话 + 本轮工具查出来的东西。对不上就是编的,直接打回。
 * 联系人电话这类信息库里根本没有,只可能由用户口头给出,这条卡得住。
 */
function verifyWriteValues(name, args, sources) {
  if (name !== 'update_supplier') return null; // 其余写工具的参数都是库里已有的名字,不需要
  const hay = sources.join('\n');
  const invented = Object.entries(args?.fields || {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim())
    .filter(([, v]) => !hay.includes(String(v).trim()));
  if (!invented.length) return null;
  return {
    error:
      `拒绝写入:${invented.map(([k, v]) => `${k}="${v}"`).join('、')} —— ` +
      '这些值在用户说过的话和查询结果里都找不到出处,是你自己编的。' +
      '联系人、电话、地址这类信息库里没有,只能由用户明确告诉你才能写。' +
      '如果用户没给,就如实说"库里没有联系方式,需要你提供",不要填。',
  };
}

// 用户这句话是在要求改动,还是只是问问
const WANTS_ACTION = /撤销|回退|退回|还原|恢复|整理|清理|归并|合并|改名|重命名|建档|补全|删掉|删除|修改|更新|加上|挂上|补上/;
// 回答在宣称"我已经改完了"
const CLAIMS_DONE =
  /(撤销|回退|还原|恢复|删除|合并|建档|改名|重命名|更新|修改|新增|添加|归位|挂上|补全)(操作)?\s*(已|成功|完成)|已(经)?(成功)?(撤销|回退|还原|恢复|删除|合并|建档|改名|更新|修改|新增|添加|归位)|操作(已)?(成功|完成)|已生效/;

/**
 * 把本轮里"已经看过"的工具结果压短。
 *
 * 每调一步都要把之前所有消息重发一遍,三次 280 行的扫描叠起来就是 50KB,
 * 本地小模型每步都在重读这堆东西,越到后面越慢,最后卡在超时上。
 * 最近两条结果留全,更早的留个头 —— 模型需要的是"查过、结论是什么",不是原始表。
 */
function compressOldResults(msgs) {
  const toolIdx = msgs.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, -2)) {
    const c = msgs[i].content;
    if (c.length > STALE_RESULT_BUDGET) {
      msgs[i] = { ...msgs[i], content: c.slice(0, STALE_RESULT_BUDGET) + '\n…(这批结果前面已经用过,这里只留开头)' };
    }
  }
}

/**
 * 整理历史。**工具结果必须一起带回来**,不能只留文字答案。
 *
 * 踩过的坑:一开始为了省 token 只回灌文字,结果第二轮问"那最便宜的那家是谁",
 * 模型手上没那张表了,就顺着自己上一轮的话编了个货号和供应商出来。
 * 追问依赖的正是上一轮查到的数据,省不得。
 *
 * 按"轮"切:每轮从一条 user 消息开始,到下一条 user 消息之前结束。
 * 只能整轮丢 —— 半截切开会留下没有对应结果的 tool_calls,云端接口会直接报错。
 */
function normalizeHistory(history) {
  const msgs = (Array.isArray(history) ? history : []).filter(
    (m) => m && ['user', 'assistant', 'tool'].includes(m.role)
  );

  const turns = [];
  for (const m of msgs) {
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(m);
  }

  const out = [];
  for (const turn of turns.slice(-HISTORY_TURNS)) {
    for (const m of turn) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.push({ role: 'assistant', content: String(m.content || ''), tool_calls: m.tool_calls });
      } else if (m.role === 'tool') {
        // 老结果压缩一下:再往前翻,知道"查过什么、结论是什么"就够了
        out.push({
          role: 'tool',
          tool_call_id: m.tool_call_id,
          name: m.name,
          content: String(m.content || '').slice(0, HISTORY_RESULT_BUDGET),
        });
      } else if (String(m.content || '').trim()) {
        out.push({ role: m.role, content: String(m.content).trim() });
      }
    }
  }
  return out;
}

/**
 * AI 当前能不能用。分开返回原因,好让界面给出**能照做的**提示 ——
 * 只说"模型不可用"会让人以为程序坏了(实际多半是压根没配)。
 */
function aiAvailability() {
  const cfg = aiConfig();
  if (!cfg.enabled) {
    return { ok: false, reason: 'disabled', hint: 'AI 尚未启用,到「设置 → AI 接入」打开开关' };
  }
  if (cfg.provider === 'cloud') {
    if (!cfg.apiKey) return { ok: false, reason: 'no_key', hint: '云端接口还没填 API Key' };
  } else if (!cfg.baseUrl) {
    return { ok: false, reason: 'no_url', hint: '还没填本地模型地址(如 http://127.0.0.1:11434)' };
  }
  return { ok: true };
}

/**
 * 模型用不了时的兜底:拿这句话当关键词硬搜。有表格总比什么都没有强。
 * reason/hint 会原样带回前端,界面据此显示"去设置 AI →",而不是干巴巴一句"不可用"。
 */
function degraded(question, { reason, hint }) {
  const keyword = cleanQuery(question);
  const rows = runSearch({ keyword, limit: 30 });
  return {
    answer: rows.length
      ? `${hint},下面是按关键词搜到的 ${rows.length} 条记录。`
      : `${hint},按关键词也没搜到相关记录。`,
    rows,
    steps: [{ tool: 'search_products', args: { keyword }, rowCount: rows.length }],
    operations: [],
    degraded: true,
    aiReason: reason,
    aiHint: hint,
    messages: [], // 降级这轮没有可回灌的上下文,下一轮从头来
  };
}

/**
 * @param {object} input {question, messages}
 *   question — 这一轮用户说的话
 *   messages — 之前的对话历史 [{role:'user'|'assistant', content}]
 * @returns {{answer, rows, steps, operations, degraded}}
 */
async function ask(input) {
  const { question, messages: history } = typeof input === 'string' ? { question: input } : input || {};
  const q = String(question || '').trim();
  if (!q) throw new Error('问题不能为空');

  // 开关关着/没填地址就别去连了 —— 白等一个超时,还给不出能照做的提示
  const avail = aiAvailability();
  if (!avail.ok) return degraded(q, avail);

  const msgs = [
    { role: 'system', content: systemPrompt() },
    ...normalizeHistory(history),
    { role: 'user', content: q },
  ];

  const specs = toolSpecs();
  const steps = [];
  const operations = [];
  let rows = []; // 最后一次有结果的查询 —— 界面上显示的就是它

  // messages 要原样交回前端、下一轮再原样送回来,追问才有据可依(见 normalizeHistory)
  const finish = (answer, extra = {}) => ({
    answer,
    rows,
    steps,
    operations,
    degraded: false,
    ...extra,
    messages: [...msgs.slice(1), { role: 'assistant', content: answer }],
  });

  // 本轮已执行过的写操作,防重复(小模型很容易把同一个写操作原样再发一遍)
  const doneWrites = new Map();
  let nudges = 0; // "只说要调、没真调"顶了几次了
  let didWrite = false; // 这一轮真的改过库没有 —— 用来拆穿"我已经撤销了"这种空话
  const wantsAction = WANTS_ACTION.test(q); // 用户是要它办事,还是只是问问

  for (let step = 0; step < MAX_STEPS; step++) {
    compressOldResults(msgs);
    let reply;
    try {
      // 顶过之后要换个温度重试。temperature=0 是确定性的 ——
      // 同样的上下文顶一百次,它会一字不差地把那段"我这就去调"重打一遍。
      reply = await chat(msgs, { tools: specs, temperature: nudges ? 0.4 : 0 });
    } catch (e) {
      // 第一步就连不上模型 = 整个 AI 不可用,退回关键词搜索;
      // 中途断了则已经查到东西了,把手上的交给用户,别白跑一趟
      if (!steps.length) return degraded(q, { reason: 'unreachable', hint: `连不上模型:${e.message}` });
      return finish(`模型中途断了(${e.message})。已经查到的结果在下面。`, { degraded: true });
    }

    if (!reply.toolCalls.length) {
      const answer = reply.content.trim();

      // 两种"嘴上做完了、实际没动手"的情况,都要顶回去:
      //  1. 把调用写成文字/JSON 贴出来(「接下来我会调用 apply_supplier_extraction…」)
      //  2. 直接宣称做完了(「撤销操作成功」),而这一轮一个写操作都没执行过 —— 这是谎报
      const narrating = answer && namesATool(answer) && /接下来|下一步|我(将|会|要)|准备|即将|现在调用/.test(answer);
      const falseClaim = answer && wantsAction && !didWrite && CLAIMS_DONE.test(answer);

      if (nudges < MAX_NUDGES && (narrating || falseClaim)) {
        nudges++;
        msgs.push({ role: 'assistant', content: answer });
        msgs.push({
          role: 'user',
          content: falseClaim
            ? '不对。你说做完了,但这一轮你一个写操作都没执行过,库里没有任何变化。' +
              '要么现在真的去调工具把它做掉(要撤销就先 list_operations 拿到流水号,再 undo_operation),' +
              '要么老实告诉用户你没做成、为什么。不要说没发生过的事。'
            : '停。你只是用文字描述了打算做什么,并没有真的发出工具调用 —— 库里一个字都没变。' +
              '不要再写计划、不要再解释、不要把调用写成 JSON 贴出来。' +
              '现在就用工具调用功能把它发出去,参数就用你刚才想好的那套。',
        });
        continue;
      }

      // 顶到上限还在谎报,就直接把事实贴在后面。
      // 这条不依赖模型配合 —— "这一轮没执行写操作"是我们自己记下来的事实。
      if (falseClaim) {
        return finish(
          answer + '\n\n⚠️ 更正:这一轮实际上**没有**执行任何写操作,库里没有变化。上面那句"已完成"不作数。'
        );
      }

      return finish(answer || '(模型没有给出回答)');
    }

    msgs.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls });

    for (const call of reply.toolCalls) {
      const isWrite = !!TOOLS[call.name]?.write;

      // 同一轮里参数一模一样的写操作只许执行一次。
      // 见过模型把 apply_supplier_extraction 用完全相同的参数连发两遍 ——
      // 那会真的建两次档,虽然能回退,但不该让它发生。
      const key = isWrite ? `${call.name}|${JSON.stringify(call.args ?? {})}` : null;
      const duplicate =
        key && doneWrites.has(key)
          ? {
              error:
                `你刚才已经用完全一样的参数执行过 ${call.name}(流水号 ${doneWrites.get(key)})。` +
                '同一个写操作不要重复执行。如果结果不对就换参数,如果已经做完了就直接回答用户。',
            }
          : null;
      // 原文 = 用户说过的话 + 已经查出来的东西
      const sources = msgs.filter((m) => m.role === 'user' || m.role === 'tool').map((m) => String(m.content || ''));
      const result = duplicate || verifyWriteValues(call.name, call.args, sources) || execTool(call.name, call.args);
      if (key && result.operation_id) doneWrites.set(key, result.operation_id);
      if (isWrite && !result.error) didWrite = true;

      steps.push({
        tool: call.name,
        args: call.args,
        write: isWrite,
        message: result.message || null,
        error: result.error || null,
        rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
        operation_id: result.operation_id || null,
      });
      if (result.operation_id) {
        operations.push({ id: result.operation_id, tool: call.name, summary: result.message || '' });
      }
      if (Array.isArray(result.rows) && result.rows.length) rows = result.rows;

      msgs.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: serializeForModel(result),
      });
    }
  }

  // 步数用尽:收掉工具再问一次,逼它就已有结果作答,而不是无限查下去
  try {
    const { content } = await chat(
      [...msgs, { role: 'user', content: `已经查了 ${MAX_STEPS} 步,别再调工具了,就用上面查到的东西回答我。` }],
      {}
    );
    return finish(content.trim(), { truncated: true });
  } catch {
    return finish(`查了 ${MAX_STEPS} 步还没收敛,下面是最后一次查询的结果。可以把问题问得更具体一点。`, {
      degraded: true,
      truncated: true,
    });
  }
}

module.exports = { ask, TOOLS };
