const db = require('../db/db');

/**
 * 助手写操作的流水账 + 回退引擎。
 *
 * 规矩:**助手每做一次改动,必须同时交出把它退回去的办法**。
 * 没有 undo 的写操作不允许落库(见 runWrite)。
 *
 * 逆操作是一段极小的"程序",只认三种步骤,按数组顺序执行:
 *   {op:'restore', table, pk, rows:[{整行}]}          整行写回(先删同 pk 再插,幂等)
 *   {op:'delete',  table, pk, ids:[...]}              删掉当时新增的行
 *   {op:'set',     table, pk, column, pairs:[[id,旧值]]}  把某列改回旧值
 *
 * 为什么不用"反向 SQL 字符串":那等于把 SQL 存进数据库再执行,
 * 日志一旦被改就是注入。这里表名/列名全过白名单,值全部参数化。
 */

// 只有这些表允许被回退触碰。图片/设置不归助手管,不放进来。
const PK = {
  suppliers: 'id',
  products: 'sku',
  product_groups: 'id',
  contracts: 'id',
  price_history: 'id',
  item_attributes: 'id',
};

const colCache = new Map();

/** 表的真实列名集合 —— 逆操作里出现的列名必须在里面,否则拒绝执行。 */
function columnsOf(table) {
  if (!colCache.has(table)) {
    colCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
  }
  return colCache.get(table);
}

function checkTable(table) {
  if (!Object.prototype.hasOwnProperty.call(PK, table)) {
    throw new Error(`回退拒绝:不认识的表 ${table}`);
  }
  return PK[table];
}

function checkColumn(table, column) {
  if (!columnsOf(table).has(column)) {
    throw new Error(`回退拒绝:${table} 没有列 ${column}`);
  }
  return column;
}

const insertOp = db.prepare(
  `INSERT INTO agent_operations (at, tool, args, summary, affected, undo)
   VALUES (@at, @tool, @args, @summary, @affected, @undo)`
);

/** 记一笔。undo 传 null 表示这笔不可回退(回退操作本身)。 */
function record({ tool, args, summary, affected = 0, undo = null }) {
  const info = insertOp.run({
    at: new Date().toISOString(),
    tool: String(tool),
    args: args === undefined ? null : JSON.stringify(args),
    summary: String(summary || ''),
    affected: Number(affected) || 0,
    undo: undo ? JSON.stringify(undo) : null,
  });
  return Number(info.lastInsertRowid);
}

function rowToPublic(r) {
  return {
    id: r.id,
    时间: r.at,
    操作: r.tool,
    说明: r.summary,
    影响行数: r.affected,
    可回退: r.undo && !r.undone_at ? '是' : '否',
    已回退: r.undone_at ? r.undone_at : null,
  };
}

function list({ limit = 30 } = {}) {
  return db
    .prepare('SELECT * FROM agent_operations ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 30, 1), 200))
    .map(rowToPublic);
}

function get(id) {
  return db.prepare('SELECT * FROM agent_operations WHERE id = ?').get(Number(id));
}

/** 执行一段逆操作。整段包在一个事务里 —— 要么全退回去,要么一点都不动。 */
function applyUndo(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) throw new Error('这笔操作没有可执行的逆操作');

  let affected = 0;

  db.transaction(() => {
    for (const step of steps) {
      const table = String(step.table || '');
      const pk = checkTable(table);

      if (step.op === 'restore') {
        const rows = Array.isArray(step.rows) ? step.rows : [];
        for (const row of rows) {
          const cols = Object.keys(row).filter((c) => columnsOf(table).has(c));
          if (!cols.includes(pk)) throw new Error(`回退拒绝:${table} 的整行数据缺主键 ${pk}`);
          const values = Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]]));

          // 行还在就 UPDATE,行没了才 INSERT。
          // 不能图省事写成"先删再插":改名的回退里那行还被上千个货号引用着,
          // 一删就撞外键(better-sqlite3 默认是开着外键约束的)。
          const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${pk} = ?`).get(row[pk]);
          if (exists) {
            const sets = cols.filter((c) => c !== pk).map((c) => `${c} = @${c}`);
            if (sets.length) {
              db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${pk} = @${pk}`).run(values);
            }
          } else {
            db.prepare(
              `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
            ).run(values);
          }
          affected++;
        }
      } else if (step.op === 'delete') {
        const ids = Array.isArray(step.ids) ? step.ids : [];
        const stmt = db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`);
        for (const id of ids) affected += stmt.run(id).changes;
      } else if (step.op === 'set') {
        const column = checkColumn(table, String(step.column || ''));
        const pairs = Array.isArray(step.pairs) ? step.pairs : [];

        // 同一行可能被记了不止一次(一个产品组下面挂着好几家供应商的货号,
        // 每家都会记一次它的"旧值")。要还原的是操作**之前**的样子,
        // 所以同主键只认第一次记的值 —— 用后写的那个会把 supplier_id 指向
        // 一个马上要被删掉的供应商,回退到最后一步就撞外键了。
        const first = new Map();
        for (const [id, value] of pairs) if (!first.has(id)) first.set(id, value);

        const stmt = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${pk} = ?`);
        for (const [id, value] of first) affected += stmt.run(value === undefined ? null : value, id).changes;
      } else {
        throw new Error(`回退拒绝:不认识的步骤 ${step.op}`);
      }
    }
  })();

  return affected;
}

/**
 * 回退第 id 笔操作。
 * 回退动作本身也记一笔(不可再回退),所以流水账永远是完整的。
 */
function undo(id) {
  const op = get(id);
  if (!op) throw new Error(`没有第 ${id} 号操作`);
  if (op.undone_at) throw new Error(`第 ${id} 号操作已经在 ${op.undone_at} 回退过了`);
  if (!op.undo) throw new Error(`第 ${id} 号操作(${op.tool})不支持回退`);

  let plan;
  try {
    plan = JSON.parse(op.undo);
  } catch {
    throw new Error(`第 ${id} 号操作的回退数据已损坏`);
  }

  const affected = applyUndo(plan);
  const undoId = record({
    tool: 'undo_operation',
    args: { id },
    summary: `回退了第 ${id} 号操作(${op.summary || op.tool}),影响 ${affected} 行`,
    affected,
    undo: null, // 回退不能再回退,避免来回反复把人绕晕
  });
  db.prepare('UPDATE agent_operations SET undone_at = ?, undone_by = ? WHERE id = ?').run(
    new Date().toISOString(),
    undoId,
    id
  );

  return { id: undoId, undone: id, affected, summary: `已回退第 ${id} 号操作,${affected} 行还原` };
}

/**
 * 写操作的统一入口:跑 fn,拿到 {summary, affected, undo, ...},落一笔流水。
 * fn 必须返回 undo —— 交不出回退方案的写操作直接报错,不许落库。
 */
function runWrite(tool, args, fn) {
  // 改动和流水必须同生共死:流水写不进去就把改动一起回滚,
  // 否则会留下"库变了但没人记得"的孤儿状态,那正是最不敢回退的情况。
  // better-sqlite3 的事务可嵌套(内层走 savepoint),工具内部自己再开事务没问题。
  return db.transaction(() => {
    const result = fn();
    if (!result || !result.undo || !Array.isArray(result.undo.steps) || !result.undo.steps.length) {
      throw new Error(`内部错误:${tool} 没有给出回退方案,已拒绝执行`);
    }
    const opId = record({
      tool,
      args,
      summary: result.summary,
      affected: result.affected,
      undo: result.undo,
    });
    return { ...result, operation_id: opId, undo: undefined };
  })();
}

module.exports = { record, list, get, undo, runWrite, PK };
