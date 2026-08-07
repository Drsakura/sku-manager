CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  short_name TEXT,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  website TEXT,
  payment_terms TEXT,
  main_categories TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- 产品(SPU)层:浏览时的"一个产品",下挂多个货号。
-- 归组规则:同一单品的不同尺寸归为一个产品;套装件数不同视为不同产品。
CREATE TABLE IF NOT EXISTS product_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  group_key TEXT,
  brand TEXT,
  category TEXT,
  description TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  display_sku TEXT,
  name TEXT,
  brand TEXT,
  category TEXT,
  spec TEXT,
  price REAL,
  currency TEXT DEFAULT 'CNY',
  moq INTEGER,
  description TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  contract_id INTEGER REFERENCES contracts(id),
  group_id INTEGER REFERENCES product_groups(id),
  parse_method TEXT DEFAULT 'rules',
  last_updated TEXT,
  source_contract TEXT,
  confidence TEXT DEFAULT 'high'
);

-- 自定义参数:参数名完全自由(夹紧力/开口/功率/内径…),
-- group_id 有值 = 产品级共用参数;sku 有值 = 货号级参数
CREATE TABLE IF NOT EXISTS item_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER REFERENCES product_groups(id),
  sku TEXT,
  name TEXT NOT NULL,
  value TEXT,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  old_price REAL,
  new_price REAL,
  old_moq INTEGER,
  new_moq INTEGER,
  currency TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  source_contract TEXT,
  confidence TEXT,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id),
  file_type TEXT,
  source_path TEXT,
  column_report TEXT,
  terms TEXT,
  parse_method TEXT DEFAULT 'rules',
  ai_rejected INTEGER DEFAULT 0,
  processed_at TEXT NOT NULL,
  rows_matched INTEGER DEFAULT 0,
  rows_new INTEGER DEFAULT 0,
  status TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 小推车:报价前先把要报的货号攒起来,排好顺序,再一次性出报价单。
-- 存库不存浏览器,换个标签页/重启应用都还在。
-- sku 唯一 —— 同一个货号加两次只是把它顶到已有位置,不产生重复行。
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  qty INTEGER,
  note TEXT,
  sort INTEGER DEFAULT 0,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  is_primary INTEGER DEFAULT 0,
  group_id INTEGER REFERENCES product_groups(id),
  created_at TEXT NOT NULL
);

-- 助手的写操作流水。每条都带 undo(逆操作 JSON),所以任何改动都能原样退回去。
-- 逆操作格式见 lib/agentLog.js —— 只认 restore/delete/set 三种步骤,表名走白名单。
CREATE TABLE IF NOT EXISTS agent_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT,          -- 调用参数 JSON,方便复盘"它当时想干什么"
  summary TEXT,       -- 人话摘要,列表里直接显示这个
  affected INTEGER DEFAULT 0,
  undo TEXT,          -- 逆操作 JSON;为空 = 不可回退(回退操作本身就是)
  undone_at TEXT,     -- 非空 = 已被回退
  undone_by INTEGER   -- 执行回退的那条操作 id
);

CREATE INDEX IF NOT EXISTS idx_agent_ops_at ON agent_operations(at DESC);

CREATE INDEX IF NOT EXISTS idx_images_sku ON product_images(sku);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_history_sku ON price_history(sku);
CREATE INDEX IF NOT EXISTS idx_contracts_supplier ON contracts(supplier_id);
CREATE INDEX IF NOT EXISTS idx_attr_sku ON item_attributes(sku);
CREATE INDEX IF NOT EXISTS idx_groups_key ON product_groups(group_key);
CREATE INDEX IF NOT EXISTS idx_cart_sort ON cart_items(sort);

-- 引用"后加列"(group_id)的索引不能写在这里:老库跑到这一步时
-- ensureColumn 还没补上该列,会直接报 no such column。
-- 这类索引统一放到 db.js 补列之后创建。
