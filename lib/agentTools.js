const db = require('../db/db');
const log = require('./agentLog');

/**
 * 助手能调用的全部工具。
 *
 * 每个工具 = {description, parameters(JSON Schema), write?, run(args)}
 * parameters 直接喂给模型的 function calling,所以描述要写给"模型"看,别写给自己看。
 *
 * 铁律两条:
 *   1. 模型永远拿不到 SQL —— 它只能选工具、填参数,SQL 全在这里写死并参数化。
 *   2. 写工具必须返回 undo(逆操作),否则 agentLog.runWrite 直接拒绝执行。
 *
 * run() 返回 {rows?, message?}:rows 会原样显示成表格给人看,message 是给模型的一句话。
 */

/* ============================== 检索 ============================== */

// 疑问句成分。模型给的关键词一般是干净的,这是给降级路径兜底的。
const QUESTION_NOISE =
  /(多少钱|多少|价格|价钱|报价|单价|起订量|最低|最便宜|最贵|是多少|怎么样|如何|有没有|有哪些|哪些|哪个|什么|请问|帮我|查一下|查询|看一下|告诉我|的|吗|呢|了|啊|？|\?|。|,|,|!|！)/g;

/**
 * 把查询词拆成打分用的片段。
 *
 * 旧实现是整句 LIKE '%xxx%',「绝缘工具」永远搜不到「6件套绝缘套装工具」——
 * 因为它不是连续子串。这里改成:中文切重叠二字片段,字母数字整体保留,
 * 命中几片就得几分,按分数排序。宁可多召回,让排序去决定谁在前面。
 */
function searchTerms(q) {
  const s = String(q || '').trim();
  const out = [];

  for (const m of s.match(/[A-Za-z0-9][A-Za-z0-9\-/.*]*/g) || []) {
    if (m.length >= 2) out.push(m);
  }

  for (const run of s.match(/[一-龥]+/g) || []) {
    if (run.length <= 3) {
      out.push(run);
      continue;
    }
    out.push(run); // 整词也算一片:完全命中的排在拼片命中的前面
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }

  if (!out.length && s) out.push(s);
  return [...new Set(out)].slice(0, 12);
}

/** 降级路径专用:先把疑问句成分剥掉再切片。 */
function cleanQuery(q) {
  const stripped = String(q || '').replace(QUESTION_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return stripped || String(q || '').trim();
}

// 参与匹配的字段,分两档权重。
// 合同文件名必须参与(供应商名字目前只存在于那里),但不能和产品名同权 ——
// 否则搜「扭力扳手」时,「浙江昕迈（扭力扳手）」合同里的"插件头"会和真正的扭力扳手打平。
const HAY_CORE = `(
  COALESCE(p.display_sku,'')||' '||COALESCE(p.sku,'')||' '||COALESCE(p.name,'')||' '||
  COALESCE(p.spec,'')||' '||COALESCE(p.description,'')||' '||COALESCE(p.brand,'')||' '||
  COALESCE(p.category,'')||' '||COALESCE(g.name,'')||' '||
  COALESCE((SELECT group_concat(a.name||' '||COALESCE(a.value,''),' ') FROM item_attributes a WHERE a.sku = p.sku),'')
)`;
const HAY_WEAK = `COALESCE(p.source_contract,'')`;
const CORE_WEIGHT = 3;

const PRODUCT_COLS = `p.display_sku AS 货号, g.name AS 产品, p.name AS 品名, p.spec AS 规格,
   p.price AS 采购价, p.moq AS 起订量,
   COALESCE(s.name, '(未归属)') AS 供应商,
   p.source_contract AS 来源合同, p.last_updated AS 更新时间`;

/**
 * 打分检索。
 * 用 MATERIALIZED 的 CTE 先把每行的可搜文本拼好一次 —— 否则 HAYSTACK 里
 * 那个查参数表的子查询会被每个片段各跑一遍(12 片 × 全表),白白慢十几倍。
 */
function runSearch({ keyword, supplier, limit }) {
  const terms = searchTerms(keyword);
  const cap = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const params = {};
  const score = terms.length
    ? terms
        .map((t, i) => {
          params[`t${i}`] = `%${t}%`;
          return (
            `(CASE WHEN hay LIKE @t${i} THEN ${CORE_WEIGHT} ELSE 0 END)` +
            ` + (CASE WHEN hay2 LIKE @t${i} THEN 1 ELSE 0 END)`
          );
        })
        .join(' + ')
    : '0';

  // 供应商既可能已建档(s.name),也可能还只存在于文件名里 —— 两边都认
  const supFilter = supplier ? `WHERE (COALESCE(s.name,'') LIKE @sup OR COALESCE(p.source_contract,'') LIKE @sup)` : '';
  if (supplier) params.sup = `%${String(supplier).trim()}%`;

  return db
    .prepare(
      `WITH base AS MATERIALIZED (
         SELECT ${PRODUCT_COLS}, ${HAY_CORE} AS hay, ${HAY_WEAK} AS hay2
         FROM products p
         LEFT JOIN product_groups g ON g.id = p.group_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         ${supFilter}
       )
       SELECT 货号, 产品, 品名, 规格, 采购价, 起订量, 供应商, 来源合同, 更新时间
       FROM (SELECT *, (${score}) AS _score FROM base)
       WHERE _score > 0
       ORDER BY _score DESC, 采购价 ASC
       LIMIT ${cap}`
    )
    .all(params);
}

/* ==================== 从合同文件名里认供应商 ==================== */

// 文件名一般长这样:EJ26001-FK 乐清锋强（批头）.xlsx
// 项目号+客户码 / 供应商 / 括号里的品类 / 各种批注尾巴。
//
// 但项目号不一定在开头(「嘉兴英伦户外用品有限公司EJ26070-FK 帐篷.xlsx」),
// 中间也不一定有横杠(「EJ26049FK 澳德立…」),所以全局匹配、匹配到哪删到哪。
const PROJECT_CODE = /[A-Za-z]{1,4}\d{4,10}(?:\s*-\s*\d{1,2})?(?:\s*-?\s*[A-Za-z]{1,6})?(?:\s*-\s*\d{1,2})?/g;
const TAIL_NOISE = /(修改以此为准|以此为准|最终版|合同取消|取消|合同|单网|报价单|报价|副本|\d{4}[.\-]\d{1,2}[.\-]\d{1,2})/g;

// 带这些后缀的更像公司名 —— 两段都没别处佐证时,用它来挑
const COMPANY_HINT = /(有限公司|公司|工具厂|器材厂|制品厂|五金厂|厂|五金|工具|机械|电器|塑业|实业|贸易|科技|制品|模具厂)$/;

// 一眼就不是公司名的:数量词开头(1米、500个小帆布包),或者带这些字眼(样品单、新订单、喉箍展架)。
// 中文数字必须后面跟着量词才算 —— 否则「九鑫」「三彩」「三恒」这些正经公司会被误伤。
const NOT_A_COMPANY =
  /^\d|^[一二三四五六七八九十百千万]+(米|厘米|毫米|寸|个|件|支|套|只|条|张|片|台|把|克|公斤|斤|包|箱)|(样品|订单|唛头|图纸|清单|明细|报价|展架|模具|尺寸|规格|外箱)/;

/** 单个文件名 → {segments, category}。认不出来就返回空 segments。 */
function parseContractName(filename) {
  let s = String(filename || '').replace(/\.(xlsx?|xlsm|csv|pdf|docx?)$/i, '');
  s = s.replace(PROJECT_CODE, ' ');

  let category = null;
  const paren = s.match(/[（(]([^）)]*)[）)]/);
  if (paren) {
    category = paren[1].trim() || null;
    s = s.replace(paren[0], ' ');
  }

  s = s.replace(TAIL_NOISE, ' ').replace(/[-—–]/g, ' ');
  const segments = s.split(/[\s　]+/).map((t) => t.trim()).filter(Boolean);
  return { segments, category };
}

/**
 * 扫全部合同,归纳出供应商候选。
 *
 * 两遍:第一遍统计"单独成名"的次数(启惠 在别处是自己一个词);
 * 第二遍遇到多段的(铝件-启惠)就挑那个更常单独出现的段。
 * 还有粘一起的(仙桃志博一次性防护服),用已知名字做前缀切一刀。
 */
function scanSuppliers() {
  const files = db.prepare('SELECT DISTINCT filename FROM contracts ORDER BY filename').all().map((r) => r.filename);
  const parsed = files.map((f) => ({ filename: f, ...parseContractName(f) }));

  const soloCount = new Map();
  for (const p of parsed) {
    if (p.segments.length === 1) {
      const k = p.segments[0];
      soloCount.set(k, (soloCount.get(k) || 0) + 1);
    }
  }
  const knownSolo = [...soloCount.keys()].filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);

  for (const p of parsed) {
    if (!p.segments.length) {
      p.guess = null;
      continue;
    }
    if (p.segments.length === 1) {
      const only = p.segments[0];
      // 「仙桃志博一次性防护服」:别处见过「仙桃志博」单独出现,就在那儿切开
      const hit = knownSolo.find((k) => k !== only && only.startsWith(k));
      if (hit) {
        p.guess = hit;
        p.category = p.category || only.slice(hit.length) || null;
      } else {
        p.guess = only;
      }
      continue;
    }
    // 多段:谁更常单独当名字用谁就是供应商;都没别处佐证时,看谁像公司名;再不行取第一段
    let best = p.segments[0];
    let bestN = soloCount.get(best) || 0;
    for (const seg of p.segments.slice(1)) {
      const n = soloCount.get(seg) || 0;
      if (n > bestN) {
        best = seg;
        bestN = n;
      }
    }
    if (bestN === 0) {
      const named = p.segments.find((seg) => COMPANY_HINT.test(seg));
      if (named) best = named;
    }
    p.guess = best;
    const rest = p.segments.filter((x) => x !== best);
    if (rest.length) p.category = p.category || rest.join('/');
  }

  const byName = new Map();
  for (const p of parsed) {
    if (!p.guess) continue;
    if (!byName.has(p.guess)) byName.set(p.guess, { name: p.guess, files: [], categories: new Set() });
    const e = byName.get(p.guess);
    e.files.push(p.filename);
    if (p.category) e.categories.add(p.category);
  }
  return { byName, parsed, unmatched: parsed.filter((p) => !p.guess).map((p) => p.filename) };
}

const countSkus = db.prepare(
  `SELECT COUNT(*) c FROM products WHERE source_contract IN (SELECT value FROM json_each(?))`
);

function supplierCandidates() {
  const { byName, unmatched } = scanSuppliers();
  const rows = [...byName.values()]
    .map((e) => {
      const skus = countSkus.get(JSON.stringify(e.files)).c;

      // 存疑要分清是"哪种"存疑,不能混成一坨。
      // 混在一起的后果实测过:模型看见「利华」和「样品单」并列在存疑名单里,
      // 就把利华这种正经公司也一起 skip 了。
      // 只标"一眼就不是公司名"这一种,而且带出过真货号的一律不标。
      //
      // 本来还标过一种「零货号」(合同里没解析出货号来)。去掉了:那些其实大多是
      // 真公司(利华、宁波宏迪…),只是那份合同没解析出行。摆进存疑名单的下场是
      // 模型连它们一起 skip 掉 —— 白丢档案,一点好处没有。
      // 判断题给模型出得越少,它做错的越少;真有空档案,事后 audit_suppliers 会报。
      const reason = skus === 0 && NOT_A_COMPANY.test(e.name) ? '像不是公司名' : null;

      return {
        候选供应商: e.name,
        合同数: e.files.length,
        货号数: skus,
        品类: [...e.categories].slice(0, 4).join('、') || null,
        存疑: reason,
        示例文件: e.files[0],
      };
    })
    .sort((a, b) => b.货号数 - a.货号数 || b.合同数 - a.合同数);
  return { rows, unmatched };
}

/* ============================== 工具表 ============================== */

const SUPPLIER_FIELDS = [
  'short_name', 'contact_person', 'phone', 'email',
  'address', 'website', 'payment_terms', 'main_categories', 'notes',
];

function findSupplier(name) {
  const n = String(name || '').trim();
  return (
    db.prepare('SELECT * FROM suppliers WHERE name = ?').get(n) ||
    db.prepare('SELECT * FROM suppliers WHERE name LIKE ? ORDER BY LENGTH(name) LIMIT 1').get(`%${n}%`)
  );
}

const TOOLS = {
  /* ---------------------------- 只读 ---------------------------- */

  database_overview: {
    description:
      '先看库里现在有什么:供应商数、产品数、货号数、合同数,以及有多少货号还没归属供应商。' +
      '不清楚该从哪下手时先调这个,别凭空猜库里有没有数据。',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const one = (sql) => db.prepare(sql).get().c;
      const stat = {
        供应商数: one('SELECT COUNT(*) c FROM suppliers'),
        产品数: one('SELECT COUNT(*) c FROM product_groups'),
        货号数: one('SELECT COUNT(*) c FROM products'),
        合同数: one('SELECT COUNT(*) c FROM contracts'),
        未归属供应商的货号: one('SELECT COUNT(*) c FROM products WHERE supplier_id IS NULL'),
        未归属供应商的合同: one('SELECT COUNT(*) c FROM contracts WHERE supplier_id IS NULL'),
        没有价格的货号: one('SELECT COUNT(*) c FROM products WHERE price IS NULL'),
        调价记录数: one('SELECT COUNT(*) c FROM price_history'),
      };
      const hint =
        stat.供应商数 === 0
          ? '供应商表是空的,但合同文件名里带着供应商名字。想整理供应商就先调 scan_contract_suppliers 看候选。'
          : stat.未归属供应商的货号 > 0
          ? `还有 ${stat.未归属供应商的货号} 个货号没挂供应商,可以调 scan_contract_suppliers 补。`
          : '供应商归属已经完整。';
      return { rows: [stat], message: hint };
    },
  },

  search_products: {
    description:
      '按关键词搜货号/产品/规格/参数,返回价格、起订量、供应商,按相关度和价格排好序。' +
      '关键词只给核心词(如"绝缘工具""电缆钳"),不要把整句问话传进来。' +
      '一次就会返回足够多的结果,不用反复搜。',
    // 故意不给 limit 旋钮:小模型会自作聪明传 limit=1,把自己框死在一条上,
    // 然后拿这一条当"扭力扳手的价格"回答用户。条数由这里说了算。
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '产品名、货号或规格里的核心词' },
        supplier: { type: 'string', description: '可选,限定供应商(名字对不上时也会去匹配合同文件名)' },
      },
      required: ['keyword'],
    },
    run: ({ keyword, supplier }) => ({ rows: runSearch({ keyword, supplier, limit: 30 }) }),
  },

  product_detail: {
    description: '看某个货号的完整信息:价格、起订量、规格参数、交付要求、来源合同。',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string', description: '货号,大小写和连字符可以不管' } },
      required: ['sku'],
    },
    run: ({ sku }) => {
      const key = String(sku || '').toUpperCase().replace(/[\s\-_./]/g, '');
      const p = db
        .prepare(
          `SELECT p.display_sku AS 货号, g.name AS 产品, p.name AS 品名, p.spec AS 规格,
                  p.price AS 采购价, p.moq AS 起订量, COALESCE(s.name,'(未归属)') AS 供应商,
                  p.description AS 交付要求, p.source_contract AS 来源合同, p.last_updated AS 更新时间
           FROM products p
           LEFT JOIN product_groups g ON g.id = p.group_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE p.sku = ?`
        )
        .get(key);
      if (!p) return { rows: [], message: `库里没有货号 ${sku}` };
      const attrs = db
        .prepare('SELECT name, value FROM item_attributes WHERE sku = ? ORDER BY sort, id')
        .all(key);
      return { rows: [{ ...p, 参数: attrs.map((a) => `${a.name}=${a.value}`).join('; ') || null }] };
    },
  },

  price_history: {
    description: '查某个货号的调价历史,看它涨过还是降过。',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string', description: '货号' } },
      required: ['sku'],
    },
    run: ({ sku }) => {
      const key = String(sku || '').toUpperCase().replace(/[\s\-_./]/g, '');
      return {
        rows: db
          .prepare(
            `SELECT changed_at AS 时间, old_price AS 原价, new_price AS 新价,
                    old_moq AS 原起订量, new_moq AS 新起订量, source_contract AS 来源
             FROM price_history WHERE sku = ? ORDER BY changed_at DESC LIMIT 30`
          )
          .all(key),
      };
    },
  },

  compare_prices: {
    description: '同类产品跨供应商比价,找最便宜的来源。args 里的 keyword 给品类词,比如"砂纸""钢丝钳"。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '品类关键词' } },
      required: ['keyword'],
    },
    run: ({ keyword }) => {
      const rows = runSearch({ keyword, limit: 60 }).filter((r) => r.采购价 != null);
      return { rows, message: rows.length ? `按采购价从低到高排,共 ${rows.length} 条` : '没查到带价格的同类货号' };
    },
  },

  recent_changes: {
    description: '最近哪些产品调过价。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 15' } },
    },
    run: ({ limit }) => ({
      rows: db
        .prepare(
          `SELECT h.changed_at AS 时间, p.display_sku AS 货号, g.name AS 产品,
                  h.old_price AS 原价, h.new_price AS 新价, h.source_contract AS 来源
           FROM price_history h
           LEFT JOIN products p ON p.sku = h.sku
           LEFT JOIN product_groups g ON g.id = p.group_id
           ORDER BY h.changed_at DESC LIMIT ?`
        )
        .all(Math.min(Number(limit) || 15, 50)),
    }),
  },

  list_suppliers: {
    description: '列出已建档的供应商及其类目、联系人、货号数。注意:这只看 suppliers 表,表可能是空的。',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const rows = db
        .prepare(
          `SELECT s.name AS 供应商, s.main_categories AS 主营类目, s.contact_person AS 联系人,
                  s.phone AS 电话, s.address AS 地址,
                  (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS 货号数,
                  (SELECT COUNT(*) FROM contracts c WHERE c.supplier_id = s.id) AS 合同数
           FROM suppliers s ORDER BY 货号数 DESC, s.name`
        )
        .all();
      return {
        rows,
        message: rows.length
          ? `共 ${rows.length} 家已建档`
          : '供应商表是空的。供应商名字还在合同文件名里,先调 scan_contract_suppliers。',
      };
    },
  },

  supplier_detail: {
    description: '看某家供应商的档案、供货类目分布和价格区间。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '供应商名,支持部分匹配' } },
      required: ['name'],
    },
    run: ({ name }) => {
      const s = findSupplier(name);
      if (!s) return { rows: [], message: `没有叫「${name}」的供应商档案` };
      const items = db
        .prepare(
          `SELECT g.name AS 产品, COUNT(*) AS 货号数, MIN(p.price) AS 最低价, MAX(p.price) AS 最高价
           FROM products p LEFT JOIN product_groups g ON g.id = p.group_id
           WHERE p.supplier_id = ? GROUP BY g.name ORDER BY 货号数 DESC LIMIT 40`
        )
        .all(s.id);
      // 只报有值的字段。原来把空字段一个个列成"联系人 空｜电话 空",
      // 模型看着像张待办清单,用户明明只问"恩光供什么货",它转头就去调 update_supplier 填联系人。
      const profile = [
        ['联系人', s.contact_person],
        ['电话', s.phone],
        ['地址', s.address],
        ['邮箱', s.email],
        ['付款条件', s.payment_terms],
        ['主营类目', s.main_categories],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} ${v}`);

      return {
        rows: items,
        message:
          `${s.name}${profile.length ? '｜' + profile.join('｜') : ''}｜供货 ${items.length} 类产品(见下表)。` +
          '下面这张表就是用户要的答案,照着它回答。',
      };
    },
  },

  audit_suppliers: {
    description:
      '给供应商档案做体检。默认只报**该动手的问题**:名字疑似重复(同一家两种写法)、一个货号都没挂的空档案。' +
      '想看谁缺联系方式就传 include="missing_contact"。用户说"整理供应商""清理一下"时先调这个。',
    parameters: {
      type: 'object',
      properties: {
        include: {
          type: 'string',
          enum: ['problems', 'missing_contact', 'all'],
          description: 'problems=只看重复和空档案(默认);missing_contact=只看缺联系方式的;all=全都要',
        },
      },
    },
    run: ({ include } = {}) => {
      const mode = ['problems', 'missing_contact', 'all'].includes(include) ? include : 'problems';
      const all = db.prepare('SELECT * FROM suppliers').all();
      if (!all.length) {
        return {
          rows: [],
          message: '供应商表是空的,没什么可体检的。要先从合同建档,调 scan_contract_suppliers。',
        };
      }
      const counts = new Map(
        db
          .prepare('SELECT supplier_id id, COUNT(*) c FROM products WHERE supplier_id IS NOT NULL GROUP BY supplier_id')
          .all()
          .map((r) => [r.id, r.c])
      );

      const rows = [];
      let missingContact = 0;
      for (const s of all) {
        const missing = ['contact_person', 'phone', 'address'].filter((f) => !s[f]);
        if (missing.length) missingContact++;
        const n = counts.get(s.id) || 0;
        // 一家的名字被另一家整个包含,多半是同一家的两种写法(衡健 / 玉环衡健)
        const near = all.filter((o) => o.id !== s.id && (o.name.includes(s.name) || s.name.includes(o.name)));
        const isProblem = near.length > 0 || n === 0;

        const wanted =
          mode === 'all' ? isProblem || missing.length : mode === 'missing_contact' ? missing.length : isProblem;
        if (!wanted) continue;

        rows.push({
          供应商: s.name,
          货号数: n,
          疑似重复: near.map((o) => o.name).join('、') || null,
          缺失字段:
            missing.map((f) => ({ contact_person: '联系人', phone: '电话', address: '地址' }[f])).join('、') || null,
        });
      }

      const dupes = rows.filter((r) => r.疑似重复).length;
      const empty = rows.filter((r) => r.货号数 === 0).length;
      return {
        rows,
        message:
          `共 ${all.length} 家。疑似重复 ${dupes} 家,空档案(零货号) ${empty} 家,缺联系方式 ${missingContact} 家。` +
          (mode === 'problems' && missingContact
            ? '缺联系方式的没列出来(合同里本来就没这些信息,不算错),要看就传 include="missing_contact"。'
            : ''),
      };
    },
  },

  scan_contract_suppliers: {
    description:
      '从合同文件名里认出供应商候选(文件名格式是「项目号-客户码 供应商（品类）」),返回候选名单。' +
      '这一步只看不改。绝大多数候选是靠谱的,只有少数**存疑**的需要你判断 —— ' +
      '判断完用 apply_supplier_extraction 带上 skip/overrides 落库。',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const { rows, unmatched } = supplierCandidates();
      const doubtful = rows.filter((r) => r.存疑);
      const clean = rows.length - doubtful.length;
      const empty = rows.filter((r) => !r.存疑 && r.货号数 === 0).length;

      // 名字互相包含的,基本就是同一家的简写/全称,直接把配对算好递给模型,
      // 别指望它自己从两百多个名字里两两比对找出来。
      // 该跳过的(订单/新订单 这种)不进配对 —— 那是要 skip 的,不是要合并的。
      const names = rows.filter((r) => r.存疑 !== '像不是公司名').map((r) => r.候选供应商);
      const pairs = [];
      for (const a of names) {
        for (const b of names) {
          if (a !== b && b.includes(a) && !pairs.some((p) => p.短 === a && p.长 === b)) pairs.push({ 短: a, 长: b });
        }
      }

      return {
        rows, // 完整名单给界面
        // 给模型的只有存疑那几条:剩下两百多条都正常,逐行重读纯属浪费本地模型的时间
        modelRows: doubtful.map(({ 品类, 示例文件, ...r }) => r),
        message:
          `识别出 ${rows.length} 个候选,${unmatched.length} 个文件名没认出来。` +
          `其中 ${clean} 个是正常公司名,会照单建档,**不用管、不要 skip**` +
          (empty ? `(里面有 ${empty} 个一个货号都没带出来 —— 那是合同没解析出行,不是名字有问题,照样建档)` : '') +
          `。\n下面这 ${doubtful.length} 个一眼就不是公司名,请放进 skip:\n` +
          (pairs.length
            ? `· 下面这几对名字互相包含,基本是同一家的简写/全称,用 overrides 把短的并到长的:${pairs
                .slice(0, 15)
                .map((p) => `${p.短}→${p.长}`)
                .join('、')}\n`
            : '') +
          '**这些判断你自己做,现在就做,不要回头问用户,也不要只在回答里描述你打算怎么做。**' +
          '想清楚就直接调 apply_supplier_extraction(带上 skip 和 overrides),一次把全部候选处理掉,' +
          '然后在回答里说明你跳过了哪些、合并了哪些 —— 他不认可可以让你整笔撤销。',
      };
    },
  },

  list_operations: {
    description: '看助手最近做过哪些写操作,以及每笔能不能回退。用户问"你刚才改了什么"时调这个。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 30' } },
    },
    run: ({ limit }) => {
      const rows = log.list({ limit });
      return { rows, message: rows.length ? `最近 ${rows.length} 笔操作` : '还没有任何写操作' };
    },
  },

  /* ---------------------------- 写库 ---------------------------- */

  apply_supplier_extraction: {
    description:
      '把 scan_contract_suppliers 的候选真正建成供应商档案,并把对应的合同、货号、调价记录挂上去。' +
      '必须先调 scan_contract_suppliers 看过名单再调这个。已存在的同名供应商会复用,不会重复建。' +
      '**一次就把全部候选处理完**(skip 里的除外),不用分批、不用挑几家先试 —— 做错了整笔回退就行。' +
      '候选名单在一次对话里不会变,扫一次就够,不要来回重扫。',
    // 原本还有个 only 参数(只处理指定的几家)。删了:7b 模型几乎每次都会去抓它,
    // 随手挑两家做完就说"接下来继续处理剩余的",然后停在那儿,活永远干不完。
    // 反正整笔都能回退,不需要"小范围先试"这个档位。
    parameters: {
      type: 'object',
      properties: {
        skip: {
          type: 'array',
          items: { type: 'string' },
          description: '不是供应商、要跳过的候选名,必须照抄候选名单里的原文,如 ["外箱唛头","样品单"]',
        },
        overrides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: '候选名单里的原名(照抄原文)' },
              to: { type: 'string', description: '改成的正确名字;两条 override 指向同一个 to 就等于合并' },
            },
            required: ['from', 'to'],
          },
          description:
            '纠正认错的名字,或把**同一家**的多种写法归并到一个名字(如 永康大信隆 / 永康市大信隆工贸)。' +
            '只在一个名字明显是另一个的简写或全称时才合并 —— 长得像不等于是同一家,' +
            '「浙江欣兴」和「浙江昕迈」是两家不同的公司,不要合。拿不准就别合,让它们各自建档。',
        },
      },
    },
    write: true,
    run: (args) =>
      log.runWrite('apply_supplier_extraction', args, () => {
        const skip = new Set((args.skip || []).map((x) => String(x).trim()));
        const rename = new Map((args.overrides || []).map((o) => [String(o.from).trim(), String(o.to).trim()]));

        const { byName } = scanSuppliers();

        // 名单里没有的名字要说出来,不能默默忽略 —— 模型很爱把文件名片段
        // (「又工（ 开口敲击扳手 ）」)当成候选名传进来,不吭声它就以为生效了
        const unknown = [...skip, ...rename.keys()].filter((n) => !byName.has(n));

        // 两个名字互不包含却被合到一起,多半是"长得像"就合了(浙江欣兴 vs 浙江昕迈)。
        // 不拦 —— 拦了就没法处理简称/全称之外的正当情况 —— 但要摆到明面上让人复核。
        const risky = [...rename.entries()]
          .filter(([from, to]) => from !== to && !from.includes(to) && !to.includes(from))
          .map(([from, to]) => `${from}→${to}`);

        // 归并:改名后可能多个候选指向同一家,文件列表要合起来
        const final = new Map();
        for (const [guess, e] of byName) {
          if (skip.has(guess)) continue;
          const name = rename.get(guess) || guess;
          if (skip.has(name)) continue;
          if (!final.has(name)) final.set(name, { name, files: [], categories: new Set() });
          const t = final.get(name);
          t.files.push(...e.files);
          for (const c of e.categories) t.categories.add(c);
        }
        if (!final.size) throw new Error('过滤之后没有可建档的供应商,检查 skip 是不是把候选全排除了');

        const now = new Date().toISOString();
        const createdIds = [];
        const oldProducts = [];
        const oldContracts = [];
        const oldGroups = [];
        const oldHistory = [];
        let linkedSkus = 0;

        const insSupplier = db.prepare(
          `INSERT INTO suppliers (name, main_categories, created_at) VALUES (?, ?, ?)`
        );
        const selProducts = db.prepare(
          'SELECT sku, supplier_id, group_id FROM products WHERE source_contract IN (SELECT value FROM json_each(?))'
        );
        const selContracts = db.prepare(
          'SELECT id, supplier_id FROM contracts WHERE filename IN (SELECT value FROM json_each(?))'
        );
        const selHistory = db.prepare(
          'SELECT id, supplier_id FROM price_history WHERE source_contract IN (SELECT value FROM json_each(?))'
        );
        const updProduct = db.prepare('UPDATE products SET supplier_id = ? WHERE sku = ?');
        const updContract = db.prepare('UPDATE contracts SET supplier_id = ? WHERE id = ?');
        const updGroup = db.prepare('UPDATE product_groups SET supplier_id = ? WHERE id = ?');
        const updHistory = db.prepare('UPDATE price_history SET supplier_id = ? WHERE id = ?');

        db.transaction(() => {
          for (const e of final.values()) {
            let s = db.prepare('SELECT * FROM suppliers WHERE name = ?').get(e.name);
            if (!s) {
              const info = insSupplier.run(e.name, [...e.categories].slice(0, 6).join('、') || null, now);
              s = { id: Number(info.lastInsertRowid) };
              createdIds.push(s.id);
            }
            const filesJson = JSON.stringify(e.files);

            for (const p of selProducts.all(filesJson)) {
              oldProducts.push([p.sku, p.supplier_id]);
              updProduct.run(s.id, p.sku);
              linkedSkus++;
              if (p.group_id) {
                const g = db.prepare('SELECT id, supplier_id FROM product_groups WHERE id = ?').get(p.group_id);
                if (g && g.supplier_id !== s.id) {
                  oldGroups.push([g.id, g.supplier_id]);
                  updGroup.run(s.id, g.id);
                }
              }
            }
            for (const c of selContracts.all(filesJson)) {
              oldContracts.push([c.id, c.supplier_id]);
              updContract.run(s.id, c.id);
            }
            for (const h of selHistory.all(filesJson)) {
              oldHistory.push([h.id, h.supplier_id]);
              updHistory.run(s.id, h.id);
            }
          }
        })();

        return {
          summary: `从合同建档 ${final.size} 家供应商(新建 ${createdIds.length} 家),挂上 ${linkedSkus} 个货号、${oldContracts.length} 份合同`,
          affected: createdIds.length + linkedSkus + oldContracts.length,
          message:
            `已建档 ${final.size} 家,${linkedSkus} 个货号归位。跳过 ${skip.size} 个,改名 ${rename.size} 个。` +
            (unknown.length
              ? `注意:这些名字不在候选名单里,没起作用 —— ${unknown.slice(0, 10).join('、')}。` +
                '请照抄 scan_contract_suppliers 返回的「候选供应商」列原文。'
              : '') +
            (risky.length
              ? `另外这几个合并两边名字互不包含,请在回答里告诉用户复核:${risky.slice(0, 10).join('、')}。`
              : ''),
          rows: [...final.values()].map((e) => ({
            供应商: e.name,
            合同数: e.files.length,
            品类: [...e.categories].slice(0, 4).join('、') || null,
          })),
          undo: {
            steps: [
              { op: 'set', table: 'products', column: 'supplier_id', pairs: oldProducts },
              { op: 'set', table: 'product_groups', column: 'supplier_id', pairs: oldGroups },
              { op: 'set', table: 'contracts', column: 'supplier_id', pairs: oldContracts },
              { op: 'set', table: 'price_history', column: 'supplier_id', pairs: oldHistory },
              { op: 'delete', table: 'suppliers', ids: createdIds },
            ],
          },
        };
      }),
  },

  update_supplier: {
    description: '补全或修改某家供应商的档案字段(联系人、电话、邮箱、地址、网址、付款条件、主营类目、简称、备注)。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '供应商名' },
        fields: {
          type: 'object',
          description: '要改的字段,键用英文:short_name/contact_person/phone/email/address/website/payment_terms/main_categories/notes',
          properties: Object.fromEntries(SUPPLIER_FIELDS.map((f) => [f, { type: 'string' }])),
        },
      },
      required: ['name', 'fields'],
    },
    write: true,
    run: (args) =>
      log.runWrite('update_supplier', args, () => {
        const s = findSupplier(args.name);
        if (!s) throw new Error(`没有叫「${args.name}」的供应商`);
        const patch = Object.entries(args.fields || {}).filter(([k]) => SUPPLIER_FIELDS.includes(k));
        if (!patch.length) throw new Error(`没有可改的字段。能改的是:${SUPPLIER_FIELDS.join(', ')}`);

        db.prepare(
          `UPDATE suppliers SET ${patch.map(([k]) => `${k} = @${k}`).join(', ')} WHERE id = @id`
        ).run({ id: s.id, ...Object.fromEntries(patch) });

        return {
          summary: `改了 ${s.name} 的 ${patch.map(([k]) => k).join('、')}`,
          affected: 1,
          message: `${s.name} 已更新:${patch.map(([k, v]) => `${k}=${v}`).join(', ')}`,
          undo: { steps: [{ op: 'restore', table: 'suppliers', rows: [s] }] },
        };
      }),
  },

  merge_suppliers: {
    description:
      '把两家其实是同一家的供应商合并:from 名下的货号、产品、合同、调价记录全部转到 into,然后删掉 from。' +
      '合并前请先用 supplier_detail 确认两边确实是同一家。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '被合并掉的那家(会消失)' },
        into: { type: 'string', description: '保留的那家' },
      },
      required: ['from', 'into'],
    },
    write: true,
    run: (args) =>
      log.runWrite('merge_suppliers', args, () => {
        const from = findSupplier(args.from);
        const into = findSupplier(args.into);
        if (!from) throw new Error(`没有叫「${args.from}」的供应商`);
        if (!into) throw new Error(`没有叫「${args.into}」的供应商`);
        if (from.id === into.id) throw new Error('这两个名字指向同一家,不用合并');

        const moved = { products: [], product_groups: [], contracts: [], price_history: [] };
        db.transaction(() => {
          for (const [table, pk] of [
            ['products', 'sku'],
            ['product_groups', 'id'],
            ['contracts', 'id'],
            ['price_history', 'id'],
          ]) {
            const ids = db.prepare(`SELECT ${pk} k FROM ${table} WHERE supplier_id = ?`).all(from.id).map((r) => r.k);
            moved[table] = ids.map((k) => [k, from.id]);
            db.prepare(`UPDATE ${table} SET supplier_id = ? WHERE supplier_id = ?`).run(into.id, from.id);
          }
          db.prepare('DELETE FROM suppliers WHERE id = ?').run(from.id);
        })();

        const n = moved.products.length;
        return {
          summary: `把「${from.name}」并进「${into.name}」,转移 ${n} 个货号、${moved.contracts.length} 份合同`,
          affected: n + moved.contracts.length + 1,
          message: `已合并。${into.name} 现在有 ${db
            .prepare('SELECT COUNT(*) c FROM products WHERE supplier_id = ?')
            .get(into.id).c} 个货号。`,
          undo: {
            steps: [
              { op: 'restore', table: 'suppliers', rows: [from] },
              { op: 'set', table: 'products', column: 'supplier_id', pairs: moved.products },
              { op: 'set', table: 'product_groups', column: 'supplier_id', pairs: moved.product_groups },
              { op: 'set', table: 'contracts', column: 'supplier_id', pairs: moved.contracts },
              { op: 'set', table: 'price_history', column: 'supplier_id', pairs: moved.price_history },
            ],
          },
        };
      }),
  },

  rename_supplier: {
    description: '给供应商改名(比如把简称改成全称)。目标名字已经存在时不会改,那种情况该用 merge_suppliers。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '现在的名字' },
        to: { type: 'string', description: '改成的名字' },
      },
      required: ['from', 'to'],
    },
    write: true,
    run: (args) =>
      log.runWrite('rename_supplier', args, () => {
        const s = findSupplier(args.from);
        if (!s) throw new Error(`没有叫「${args.from}」的供应商`);
        const to = String(args.to || '').trim();
        if (!to) throw new Error('新名字不能为空');
        if (db.prepare('SELECT id FROM suppliers WHERE name = ? AND id != ?').get(to, s.id)) {
          throw new Error(`已经有一家叫「${to}」了。如果它俩是同一家,改用 merge_suppliers。`);
        }
        db.prepare('UPDATE suppliers SET name = ? WHERE id = ?').run(to, s.id);
        return {
          summary: `供应商改名:${s.name} → ${to}`,
          affected: 1,
          message: `已改名为「${to}」`,
          undo: { steps: [{ op: 'restore', table: 'suppliers', rows: [s] }] },
        };
      }),
  },

  delete_supplier: {
    description: '删掉一条供应商档案。名下还挂着货号的不让删 —— 那种情况要么先合并,要么先转移。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '供应商名' } },
      required: ['name'],
    },
    write: true,
    run: (args) =>
      log.runWrite('delete_supplier', args, () => {
        const s = findSupplier(args.name);
        if (!s) throw new Error(`没有叫「${args.name}」的供应商`);
        const n = db.prepare('SELECT COUNT(*) c FROM products WHERE supplier_id = ?').get(s.id).c;
        if (n > 0) throw new Error(`「${s.name}」名下还有 ${n} 个货号,不能直接删。要合并请用 merge_suppliers。`);
        db.prepare('DELETE FROM suppliers WHERE id = ?').run(s.id);
        return {
          summary: `删除供应商档案「${s.name}」`,
          affected: 1,
          message: `已删除「${s.name}」`,
          undo: { steps: [{ op: 'restore', table: 'suppliers', rows: [s] }] },
        };
      }),
  },

  undo_operation: {
    description:
      '把之前某笔写操作原样退回去。先用 list_operations 拿到操作 id。' +
      '用户说"撤销""退回去""刚才那步不对"时用这个。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'list_operations 里的操作 id' } },
      required: ['id'],
    },
    write: true,
    run: ({ id }) => {
      const r = log.undo(id);
      return { message: r.summary, rows: log.list({ limit: 10 }) };
    },
  },
};

/** 喂给模型的工具清单(不含 run)。 */
function toolSpecs() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: t.parameters,
  }));
}

module.exports = { TOOLS, toolSpecs, runSearch, searchTerms, cleanQuery, supplierCandidates, parseContractName };
