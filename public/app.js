'use strict';

const content = document.getElementById('content');
const state = { view: 'search', suppliers: [], q: '', supplierFilter: '', onlyLow: false };

/* -------------------------------- 工具函数 -------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => (n == null ? '—' : Number(n).toFixed(2));

function priceRange(min, max) {
  if (min == null) return '—';
  if (max == null || Number(min) === Number(max)) return money(min);
  return `${money(min)}~${money(max)}`;
}

function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

const ICON = {
  search: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  box: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg>',
  building: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 21V7l6-4 6 4v14"/><path d="M15 21V11l6 4v6"/><path d="M3 21h18"/></svg>',
  alert: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  upload: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/></svg>',
  image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  star: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  pencil: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

function emptyState(icon, title, hint) {
  return `<div class="empty">${icon}<div class="empty-title">${title}</div><div class="empty-hint">${hint}</div></div>`;
}

/* --------------------------------- 主题 --------------------------------- */

const SUN_PATH = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON_PATH = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  document.getElementById('themeIcon').innerHTML = dark ? SUN_PATH : MOON_PATH;
  document.getElementById('themeLabel').textContent = dark ? '浅色模式' : '深色模式';
  localStorage.setItem('theme', theme);
}

document.getElementById('themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// 浅色为默认 —— 深色背景在白天办公环境下可见度差
applyTheme(localStorage.getItem('theme') || 'light');

/* -------------------------------- 视图切换 -------------------------------- */

const VIEWS = {
  search: { title: '产品查询', sub: '按货号、品名、规格、材质或参数检索产品与采购价', render: renderSearch },
  suppliers: { title: '供应商管理', sub: '联系人、地址与供货清单', render: renderSuppliers },
  import: { title: '合同导入', sub: '拖入合同文件,或扫描指定文件夹批量解析', render: renderImport },
};

// 设置不再占一个页面视图 —— 齿轮打开弹窗,内容独立滚动,不带动整页
document.getElementById('gearBtn').addEventListener('click', () => openSettings());

function go(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('viewTitle').textContent = VIEWS[view].title;
  document.getElementById('viewSub').textContent = VIEWS[view].sub;
  VIEWS[view].render();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => go(btn.dataset.view));
});

async function refreshStats() {
  const s = await api('/api/stats');
  document.getElementById('mSku').textContent = s.total_skus;
  document.getElementById('mSupplier').textContent = s.total_suppliers;
  document.getElementById('mLow').textContent = s.low_confidence;
  document.getElementById('navSkuCount').textContent = s.total_groups ?? s.total_skus;
  document.getElementById('navSupplierCount').textContent = s.total_suppliers;
  document.getElementById('navContractCount').textContent = s.contracts_processed;
}

async function loadSuppliers() {
  state.suppliers = await api('/api/suppliers');
  return state.suppliers;
}

function supplierOptions(selected) {
  return (
    '<option value="">未指定供应商</option>' +
    state.suppliers
      .map((s) => `<option value="${s.id}" ${String(selected) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`)
      .join('')
  );
}

function thumbHtml(r) {
  if (!r.thumb) return `<div class="thumb-empty">${ICON.image}</div>`;
  const extra = r.image_count > 1 ? `<span class="thumb-badge">${r.image_count}</span>` : '';
  return `<span class="thumb-wrap"><img class="thumb" src="/product-images/${encodeURIComponent(r.thumb)}" alt="" loading="lazy" />${extra}</span>`;
}

/* ------------------------------ 参数编辑器 ------------------------------ */

let attrNamesLoaded = false;
async function ensureAttrDatalist() {
  let dl = document.getElementById('attrNames');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'attrNames';
    document.body.appendChild(dl);
  }
  if (!attrNamesLoaded) {
    try {
      const names = await api('/api/attr-names');
      dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
      attrNamesLoaded = true;
    } catch { /* 忽略 */ }
  }
}

function attrRowHtml(a = {}) {
  return `<div class="attr-row">
    <input type="text" class="attr-name" list="attrNames" placeholder="参数名,如 夹紧力" value="${esc(a.name ?? '')}" />
    <input type="text" class="attr-value" placeholder="值,如 200kg" value="${esc(a.value ?? '')}" />
    <button type="button" class="icon-btn attr-del" title="删除">${ICON.close}</button>
  </div>`;
}

function attrEditorHtml(attrs) {
  const rows = (attrs && attrs.length ? attrs : []).map(attrRowHtml).join('');
  return `<div class="attr-editor">
    <div class="attr-rows">${rows}</div>
    <button type="button" class="btn btn-sm add-attr-row">${ICON.plus} 加一个参数</button>
  </div>`;
}

function setupAttrEditor(container) {
  ensureAttrDatalist();
  container.querySelectorAll('.attr-editor').forEach((ed) => {
    ed.querySelector('.add-attr-row').addEventListener('click', () => {
      ed.querySelector('.attr-rows').insertAdjacentHTML('beforeend', attrRowHtml());
      bindAttrDeletes(ed);
      const inputs = ed.querySelectorAll('.attr-name');
      inputs[inputs.length - 1].focus();
    });
    bindAttrDeletes(ed);
  });
}

function bindAttrDeletes(ed) {
  ed.querySelectorAll('.attr-del').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => btn.closest('.attr-row').remove());
  });
}

function collectAttrs(container) {
  const out = [];
  container.querySelectorAll('.attr-row').forEach((row) => {
    const name = row.querySelector('.attr-name').value.trim();
    const value = row.querySelector('.attr-value').value.trim();
    if (name) out.push({ name, value });
  });
  return out;
}

/* ------------------------------- 抽屉骨架 ------------------------------- */

function makeDrawer({ wide = false } = {}) {
  document.querySelectorAll('.drawer-backdrop, .drawer').forEach((el) => el.remove());
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer' + (wide ? ' wide' : '');
  drawer.id = 'drawer';
  document.body.append(backdrop, drawer);

  const close = () => {
    backdrop.remove();
    drawer.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.lightbox')) close();
  };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return { drawer, close };
}

/* ================================ 产品查询 ================================ */

function renderSearch() {
  content.innerHTML = `
    <div class="toolbar">
      <div class="grow">
        <input type="search" id="q" placeholder="输入货号 / 品名 / 规格 / 参数 关键词…" value="${esc(state.q)}" autocomplete="off" />
      </div>
      <select id="supplierFilter">
        <option value="">全部供应商</option>
        <option value="none" ${state.supplierFilter === 'none' ? 'selected' : ''}>未分类(无供应商)</option>
        ${state.suppliers
          .map((s) => `<option value="${s.id}" ${state.supplierFilter === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`)
          .join('')}
      </select>
      <label class="check"><input type="checkbox" id="onlyLow" ${state.onlyLow ? 'checked' : ''} /> 只看待核对</label>
      <button class="btn btn-primary" id="addProduct">+ 新增产品</button>
    </div>
    <div id="results"></div>`;

  const qEl = document.getElementById('q');
  let timer;
  qEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = qEl.value.trim();
      runSearch();
    }, 200);
  });
  document.getElementById('supplierFilter').addEventListener('change', (e) => {
    state.supplierFilter = e.target.value;
    runSearch();
  });
  document.getElementById('onlyLow').addEventListener('change', (e) => {
    state.onlyLow = e.target.checked;
    runSearch();
  });
  document.getElementById('addProduct').addEventListener('click', () => openNewProduct());

  qEl.focus();
  runSearch();
}

async function runSearch() {
  const box = document.getElementById('results');
  if (!box) return;
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.supplierFilter) params.set('supplier_id', state.supplierFilter);
  if (state.onlyLow) params.set('only_low', '1');

  const rows = await api('/api/search?' + params);

  if (!rows.length) {
    box.innerHTML = state.q || state.supplierFilter || state.onlyLow
      ? emptyState(ICON.search, '没有匹配的记录', '换个关键词试试,或者用右上角「+ 新增产品」直接建一个。')
      : emptyState(ICON.box, '产品库还是空的', '到「合同导入」页把进货合同拖进来自动提取,或者用「+ 新增产品」手工建档。');
    return;
  }

  box.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th></th><th>产品</th><th style="text-align:right">货号数</th>
          <th style="text-align:right">采购价</th><th>供应商</th><th>更新时间</th>
        </tr></thead>
        <tbody>${rows.map(groupRowHtml).join('')}</tbody>
      </table>
    </div>`;

  box.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () =>
      openGroup(Number(tr.dataset.gid), tr.dataset.hit || null)
    );
  });
}

function groupRowHtml(g) {
  const low = g.low_count > 0 ? ' <span class="badge badge-warn">待核对</span>' : '';
  const hits = (g.matched_items || [])
    .slice(0, 6)
    .map((m) => esc(m.display_sku || m.sku))
    .join('、');
  const hitLine = hits
    ? `<div class="hit-line">命中货号:${hits}${g.matched_items.length > 6 ? ' …' : ''}</div>`
    : '';
  const meta = [g.brand, g.category].filter(Boolean).map(esc).join(' · ');

  return `<tr data-clickable data-gid="${g.id}" data-hit="${esc(g.matched_items?.[0]?.sku || '')}">
    <td class="thumb-cell">${thumbHtml(g)}</td>
    <td class="name"><div>${esc(g.name)}</div>${meta ? `<div class="dim" style="font-size:11.5px">${meta}</div>` : ''}${hitLine}</td>
    <td class="num">${g.item_count}</td>
    <td class="num price"><span class="unit">¥</span>${priceRange(g.price_min, g.price_max)}${low}</td>
    <td>${g.supplier_name ? esc(g.supplier_short || g.supplier_name) : '<span class="dim">未指定</span>'}</td>
    <td class="dim">${fmtDate(g.last_updated)}</td>
  </tr>`;
}

/* ------------------------------ 产品详情抽屉 ------------------------------ */

async function openGroup(groupId, highlightSku = null) {
  const { close } = makeDrawer({ wide: true });
  await paintGroup(groupId, close, highlightSku);
}

async function paintGroup(groupId, close, highlightSku = null) {
  const drawer = document.getElementById('drawer');
  if (!drawer) return;
  const { group: g, groupAttributes, items, images } = await api('/api/group/' + groupId);

  // 货号×参数对比表的列 = 所有货号参数名的并集
  const attrCols = [];
  for (const it of items) {
    for (const a of it.attributes) {
      if (!attrCols.includes(a.name)) attrCols.push(a.name);
    }
  }

  const meta = [g.brand, g.category, g.supplier_name].filter(Boolean).map(esc).join(' · ');

  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h3 style="font-family:var(--font-display);font-size:20px">${esc(g.name)}</h3>
        <div class="sub">${meta || '<span style="opacity:.6">品牌/分类/供应商 未填写</span>'} · ${items.length} 个货号</div>
      </div>
      <button class="icon-btn" id="editGroupBtn" title="编辑产品信息">${ICON.pencil}</button>
      <button class="icon-btn close" id="drawerClose" title="关闭">${ICON.close}</button>
    </div>
    <div class="drawer-body">
      ${g.description ? `<div class="panel"><div class="panel-title">产品说明</div><div class="spec-text">${esc(g.description)}</div></div>` : ''}

      ${groupAttributes.length ? `<div class="panel">
        <div class="panel-title">通用参数(全部货号共用)</div>
        <div class="chip-row">${groupAttributes
          .map((a) => `<span class="chip"><b>${esc(a.name)}</b>${a.value ? ' ' + esc(a.value) : ''}</span>`)
          .join('')}</div>
      </div>` : ''}

      <div class="panel">
        <div class="panel-title">货号与参数</div>
        <div class="table-wrap" style="max-height:380px">
          <table>
            <thead><tr>
              <th>货号</th><th>规格</th><th style="text-align:right">采购价</th>
              <th style="text-align:right">MOQ</th>
              ${attrCols.map((c) => `<th>${esc(c)}</th>`).join('')}
              <th></th>
            </tr></thead>
            <tbody>${items.map((it) => itemRowHtml(it, attrCols, highlightSku)).join('')}</tbody>
          </table>
        </div>
        <div style="margin-top:11px">
          <button class="btn btn-sm" id="addItemBtn">${ICON.plus} 新增货号</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">产品图片</div>
        <div class="gallery" id="gallery">
          ${images.map(galleryItem).join('')}
          <label class="add-image" id="addImage">
            ${ICON.plus}<span>添加图片</span>
            <input type="file" id="imageInput" accept="image/*" multiple />
          </label>
        </div>
      </div>
    </div>`;

  drawer.querySelector('#drawerClose').addEventListener('click', close);
  drawer.querySelector('#editGroupBtn').addEventListener('click', () =>
    groupEditForm(g, groupAttributes, close)
  );
  drawer.querySelector('#addItemBtn').addEventListener('click', () =>
    itemForm({ groupId, group: g, items, close })
  );
  drawer.querySelectorAll('tr[data-sku]').forEach((tr) => {
    tr.addEventListener('click', () => itemEditor(tr.dataset.sku, groupId, close));
  });
  setupGallery(groupId, close);

  const hit = drawer.querySelector('tr.hit');
  if (hit) hit.scrollIntoView({ block: 'center' });
}

function itemRowHtml(it, attrCols, highlightSku) {
  const attrMap = {};
  for (const a of it.attributes) attrMap[a.name] = a.value;
  const low = it.confidence === 'low' ? ' <span class="badge badge-warn">待核对</span>' : '';
  const hit = highlightSku && it.sku === highlightSku ? ' hit' : '';

  return `<tr data-clickable data-sku="${esc(it.sku)}" class="${hit.trim()}">
    <td class="sku">${esc(it.display_sku || it.sku)}</td>
    <td class="dim">${esc(it.spec) || '—'}</td>
    <td class="num price"><span class="unit">¥</span>${money(it.price)}${low}</td>
    <td class="num">${it.moq ?? '—'}</td>
    ${attrCols.map((c) => `<td class="dim">${esc(attrMap[c] ?? '') || '—'}</td>`).join('')}
    <td><button class="btn btn-sm">编辑</button></td>
  </tr>`;
}

/* ------------------------------ 产品编辑表单 ------------------------------ */

function groupEditForm(g, groupAttributes, close) {
  const drawer = document.getElementById('drawer');
  drawer.querySelector('.drawer-body').innerHTML = `
    <div class="panel">
      <div class="panel-title">编辑产品</div>
      <label class="field"><span>产品名称 *</span>
        <input type="text" data-key="name" value="${esc(g.name)}" /></label>
      <div class="grid-2">
        <label class="field"><span>品牌</span>
          <input type="text" data-key="brand" value="${esc(g.brand ?? '')}" /></label>
        <label class="field"><span>分类</span>
          <input type="text" data-key="category" value="${esc(g.category ?? '')}" /></label>
      </div>
      <label class="field"><span>供应商</span>
        <select data-key="supplier_id">${supplierOptions(g.supplier_id)}</select></label>
      <label class="field"><span>产品说明</span>
        <textarea data-key="description" rows="4">${esc(g.description ?? '')}</textarea></label>
      <label class="field"><span>通用参数(全部货号共用,如 材质)</span></label>
      ${attrEditorHtml(groupAttributes)}
      <div style="display:flex;gap:9px;margin-top:14px">
        <button class="btn btn-primary" id="saveGroup">保存</button>
        <button class="btn" id="cancelGroup">取消</button>
      </div>
    </div>`;

  setupAttrEditor(drawer);
  drawer.querySelector('#cancelGroup').addEventListener('click', () => paintGroup(g.id, close));

  drawer.querySelector('#saveGroup').addEventListener('click', async () => {
    const payload = { attributes: collectAttrs(drawer) };
    drawer.querySelectorAll('[data-key]').forEach((el) => {
      payload[el.dataset.key] = el.value;
    });
    if (!payload.name.trim()) return toast('产品名称不能为空', true);

    try {
      await api('/api/group/' + g.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast('已保存');
      attrNamesLoaded = false;
      await paintGroup(g.id, close);
      if (state.view === 'search') runSearch();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* --------------------------- 货号表单(新增) --------------------------- */

function itemForm({ groupId, group, items, close }) {
  const drawer = document.getElementById('drawer');
  const copyOptions = items.length
    ? `<label class="field"><span>从现有货号复制参数</span>
        <select id="copyFrom">
          <option value="">不复制</option>
          ${items.map((it) => `<option value="${esc(it.sku)}">${esc(it.display_sku || it.sku)}</option>`).join('')}
        </select></label>`
    : '';

  drawer.querySelector('.drawer-body').innerHTML = `
    <div class="panel">
      <div class="panel-title">新增货号 · ${esc(group.name)}</div>
      <div class="grid-2">
        <label class="field"><span>货号 *</span>
          <input type="text" data-key="sku" placeholder="例如 FC-50200" /></label>
        <label class="field"><span>规格</span>
          <input type="text" data-key="spec" placeholder="例如 50×200mm" /></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>采购价</span>
          <input type="number" min="0" step="0.01" data-key="price" placeholder="可留空" /></label>
        <label class="field"><span>起订量 MOQ</span>
          <input type="number" min="0" step="1" data-key="moq" placeholder="可留空" /></label>
      </div>
      <label class="field"><span>交付标准与要求</span>
        <textarea data-key="description" rows="4" placeholder="材质、包装要求等"></textarea></label>
      ${copyOptions}
      <label class="field"><span>货号参数(随尺寸变的,如 夹紧力/开口)</span></label>
      ${attrEditorHtml([])}
      <div style="display:flex;gap:9px;margin-top:14px">
        <button class="btn btn-primary" id="createItem">创建</button>
        <button class="btn" id="cancelItem">取消</button>
      </div>
      <div id="itemErr" style="margin-top:12px"></div>
    </div>`;

  setupAttrEditor(drawer);
  drawer.querySelector('#cancelItem').addEventListener('click', () => paintGroup(groupId, close));

  const copySel = drawer.querySelector('#copyFrom');
  if (copySel) {
    copySel.addEventListener('change', () => {
      const src = items.find((it) => it.sku === copySel.value);
      const rowsBox = drawer.querySelector('.attr-rows');
      rowsBox.innerHTML = (src ? src.attributes : []).map(attrRowHtml).join('');
      const ed = drawer.querySelector('.attr-editor');
      ed.querySelectorAll('.attr-del').forEach((b) => delete b.dataset.bound);
      bindAttrDeletes(ed);
    });
  }

  drawer.querySelector('[data-key="sku"]').focus();

  drawer.querySelector('#createItem').addEventListener('click', async () => {
    const payload = { attributes: collectAttrs(drawer) };
    drawer.querySelectorAll('[data-key]').forEach((el) => {
      payload[el.dataset.key] = el.value;
    });
    if (!payload.sku.trim()) {
      drawer.querySelector('#itemErr').innerHTML =
        '<div class="result-row failed"><div class="result-name">货号不能为空</div></div>';
      return;
    }
    try {
      await api(`/api/group/${groupId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast('已创建');
      attrNamesLoaded = false;
      await Promise.all([refreshStats(), loadSuppliers()]);
      await paintGroup(groupId, close);
      if (state.view === 'search') runSearch();
    } catch (err) {
      drawer.querySelector('#itemErr').innerHTML = `<div class="result-row failed">
        <div class="result-name">${esc(err.message)}</div>
      </div>`;
    }
  });
}

/* ------------------------------ 货号编辑器 ------------------------------ */

async function itemEditor(sku, groupId, close) {
  const drawer = document.getElementById('drawer');
  const { product: p, history } = await api('/api/product/' + encodeURIComponent(sku));

  // 合同解析出来的价格不给手改:改了下次导入同一份合同还会被覆盖,
  // 反而让人以为改丢了。手工建的货号没有这个问题。
  const priceEditable = !p.contract_id;

  // 移动目标:现有产品列表(取最近的一批)
  let groupChoices = [];
  try {
    groupChoices = await api('/api/search');
  } catch { /* 忽略 */ }

  const lowNote = p.confidence === 'low'
    ? `<div class="note">${ICON.alert}<div>这条价格来自扫描件 OCR 识别,数字可能有误。报价前建议对一下原始合同 <b>${esc(p.source_contract)}</b>。</div></div>`
    : '';

  drawer.querySelector('.drawer-body').innerHTML = `
    ${lowNote}
    <div class="note note-info">${ICON.alert}<div>${
      priceEditable
        ? '这个货号是手工建的,<b>采购价可以直接改</b>,每次改动都会记进调价历史。'
        : '<b>采购价不可手改</b> —— 它来自合同 ' + esc(p.source_contract || '') + ',必须保持可追溯。其余字段随便改。'
    }</div></div>

    <div class="panel">
      <div class="panel-title">编辑货号 ${esc(p.display_sku || p.sku)}</div>
      <div class="grid-2">
        ${priceEditable
          ? `<label class="field"><span>采购价</span>
               <input type="number" min="0" step="0.01" data-key="price" value="${p.price ?? ''}" /></label>`
          : `<label class="field"><span>采购价(合同锁定)</span>
               <input type="text" value="¥${money(p.price)}" disabled /></label>`}
        <label class="field"><span>起订量 MOQ</span>
          <input type="number" min="0" step="1" data-key="moq" value="${p.moq ?? ''}" /></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>品名(该货号自己的叫法)</span>
          <input type="text" data-key="name" value="${esc(p.name ?? '')}" /></label>
        <label class="field"><span>规格</span>
          <input type="text" data-key="spec" value="${esc(p.spec ?? '')}" /></label>
      </div>
      <label class="field"><span>交付标准与要求</span>
        <textarea data-key="description" rows="5">${esc(p.description ?? '')}</textarea></label>
      <label class="field"><span>所属产品</span>
        <select id="moveGroup">
          ${groupChoices
            .map(
              (gc) =>
                `<option value="${gc.id}" ${gc.id === p.group_id ? 'selected' : ''}>${esc(gc.name)}(${gc.item_count} 个货号)</option>`
            )
            .join('')}
          <option value="new">— 独立成新产品 —</option>
        </select></label>
      <label class="field"><span>货号参数</span></label>
      ${attrEditorHtml(p.attributes)}
      <div style="display:flex;gap:9px;margin-top:14px">
        <button class="btn btn-primary" id="saveItem">保存</button>
        <button class="btn" id="cancelItemEdit">返回</button>
        <button class="btn btn-danger" id="deleteItem" style="margin-left:auto">删除货号</button>
      </div>
    </div>

    ${p.contract_terms
      ? `<div class="panel"><details class="terms">
           <summary>来源合同通用要求</summary>
           <div class="spec-text">${esc(p.contract_terms)}</div>
         </details></div>`
      : ''}

    <div class="panel">
      <div class="panel-title">调价记录</div>
      ${history.length ? `<div class="timeline">${history.map(tlItem).join('')}</div>`
        : '<div class="empty-hint" style="text-align:left">还没有调价记录。</div>'}
    </div>`;

  setupAttrEditor(drawer);
  drawer.querySelector('#cancelItemEdit').addEventListener('click', () => paintGroup(groupId, close));

  drawer.querySelector('#saveItem').addEventListener('click', async () => {
    const payload = { attributes: collectAttrs(drawer) };
    drawer.querySelectorAll('[data-key]').forEach((el) => {
      payload[el.dataset.key] = el.value;
    });
    const mv = drawer.querySelector('#moveGroup').value;
    if (mv && String(mv) !== String(p.group_id)) payload.group_id = mv;

    try {
      const r = await api('/api/product/' + encodeURIComponent(p.sku), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast('已保存');
      attrNamesLoaded = false;
      await Promise.all([refreshStats(), loadSuppliers()]);
      await paintGroup(r.group_id || groupId, close);
      if (state.view === 'search') runSearch();
    } catch (err) {
      toast(err.message, true);
    }
  });

  drawer.querySelector('#deleteItem').addEventListener('click', async () => {
    if (!confirm(`删除货号「${p.display_sku || p.sku}」?\n\n调价历史会保留备查;所在产品若变空会一并清理。`)) return;
    try {
      await api('/api/product/' + encodeURIComponent(p.sku), { method: 'DELETE' });
      toast('已删除');
      await Promise.all([refreshStats(), loadSuppliers()]);
      // 产品可能已被清理,回列表最稳
      close();
      if (state.view === 'search') runSearch();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ------------------------------ 新增产品表单 ------------------------------ */

function openNewProduct() {
  const { drawer, close } = makeDrawer({ wide: false });

  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h3 style="font-family:var(--font-display);font-size:20px">新增产品</h3>
        <div class="sub">先建产品,再往里加货号;合同还没到的货也可以先建档</div>
      </div>
      <button class="icon-btn close" id="newClose" title="关闭">${ICON.close}</button>
    </div>
    <div class="drawer-body">
      <div class="panel">
        <div class="panel-title">产品信息</div>
        <label class="field"><span>产品名称 *</span>
          <input type="text" data-g="name" placeholder="例如 重型F夹" /></label>
        <div class="grid-2">
          <label class="field"><span>品牌</span><input type="text" data-g="brand" /></label>
          <label class="field"><span>分类</span><input type="text" data-g="category" /></label>
        </div>
        <label class="field"><span>供应商</span>
          <select data-g="supplier_id">${supplierOptions('')}</select></label>
        <label class="field"><span>产品说明</span>
          <textarea data-g="description" rows="3" placeholder="所有尺寸共用的介绍,可留空"></textarea></label>
      </div>
      <div class="panel">
        <div class="panel-title">第一个货号</div>
        <div class="grid-2">
          <label class="field"><span>货号 *</span>
            <input type="text" data-i="sku" placeholder="例如 FC-50200" /></label>
          <label class="field"><span>规格</span>
            <input type="text" data-i="spec" placeholder="例如 50×200mm" /></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>采购价</span>
            <input type="number" min="0" step="0.01" data-i="price" placeholder="可留空" /></label>
          <label class="field"><span>起订量 MOQ</span>
            <input type="number" min="0" step="1" data-i="moq" placeholder="可留空" /></label>
        </div>
        <label class="field"><span>交付标准与要求</span>
          <textarea data-i="description" rows="3" placeholder="材质、包装要求等"></textarea></label>
        <label class="field"><span>货号参数(如 夹紧力/开口/功率)</span></label>
        ${attrEditorHtml([])}
        <div style="display:flex;gap:9px;margin-top:14px">
          <button class="btn btn-primary" id="createGroup">创建</button>
          <button class="btn" id="cancelNew">取消</button>
        </div>
        <div id="createErr" style="margin-top:12px"></div>
      </div>
    </div>`;

  setupAttrEditor(drawer);
  drawer.querySelector('#newClose').addEventListener('click', close);
  drawer.querySelector('#cancelNew').addEventListener('click', close);
  drawer.querySelector('[data-g="name"]').focus();

  drawer.querySelector('#createGroup').addEventListener('click', async () => {
    const payload = { item: { attributes: collectAttrs(drawer) } };
    drawer.querySelectorAll('[data-g]').forEach((el) => (payload[el.dataset.g] = el.value));
    drawer.querySelectorAll('[data-i]').forEach((el) => (payload.item[el.dataset.i] = el.value));

    if (!payload.name.trim() || !payload.item.sku.trim()) {
      drawer.querySelector('#createErr').innerHTML =
        '<div class="result-row failed"><div class="result-name">产品名称和货号都不能为空</div></div>';
      return;
    }

    try {
      const { group_id } = await api('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast('已创建');
      attrNamesLoaded = false;
      await Promise.all([refreshStats(), loadSuppliers()]);
      if (state.view === 'search') runSearch();
      close();
      openGroup(group_id);
    } catch (err) {
      drawer.querySelector('#createErr').innerHTML = `<div class="result-row failed">
        <div class="result-name">${esc(err.message)}</div>
        <div class="result-stat">${/已存在/.test(err.message) ? '这个货号已经在库里,直接搜索它进去编辑' : ''}</div>
      </div>`;
    }
  });
}

/* --------------------------------- 图库 --------------------------------- */

function galleryItem(img) {
  return `<div class="gallery-item ${img.is_primary ? 'is-primary' : ''}" data-id="${img.id}">
    <img src="/product-images/${encodeURIComponent(img.filename)}" alt="${esc(img.original_name || '')}" loading="lazy" />
    ${img.is_primary ? '<span class="primary-flag">封面</span>' : ''}
    <div class="gallery-tools">
      ${img.is_primary ? '' : `<button class="setPrimary" title="设为封面">${ICON.star}</button>`}
      <button class="del" title="删除">${ICON.trash}</button>
    </div>
  </div>`;
}

function setupGallery(groupId, close) {
  const gallery = document.getElementById('gallery');
  if (!gallery) return;
  const input = document.getElementById('imageInput');
  const addBox = document.getElementById('addImage');

  input.addEventListener('change', async () => {
    if (input.files.length) await uploadImages(groupId, input.files, close);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    addBox.addEventListener(ev, (e) => {
      e.preventDefault();
      addBox.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    addBox.addEventListener(ev, (e) => {
      e.preventDefault();
      addBox.classList.remove('over');
    })
  );
  addBox.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) await uploadImages(groupId, files, close);
  });

  gallery.querySelectorAll('.gallery-item').forEach((item) => {
    const id = item.dataset.id;

    item.querySelector('img').addEventListener('click', () => lightbox(item.querySelector('img').src));

    const star = item.querySelector('.setPrimary');
    if (star) {
      star.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api(`/api/images/${id}/primary`, { method: 'POST' });
        await paintGroup(groupId, close);
        if (state.view === 'search') runSearch();
      });
    }

    item.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除这张图片?')) return;
      await api(`/api/images/${id}`, { method: 'DELETE' });
      await paintGroup(groupId, close);
      if (state.view === 'search') runSearch();
    });
  });
}

async function uploadImages(groupId, files, close) {
  const fd = new FormData();
  [...files].forEach((f) => fd.append('images', f));
  try {
    await api(`/api/group/${groupId}/images`, { method: 'POST', body: fd });
    toast(`已添加 ${files.length} 张图片`);
    await paintGroup(groupId, close);
    if (state.view === 'search') runSearch();
  } catch (err) {
    toast(err.message, true);
  }
}

function lightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${src}" alt="" />`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

function tlItem(h) {
  const up = h.new_price > h.old_price;
  const dir = h.old_price == null ? '' : up ? 'up' : 'down';
  const pct = h.old_price ? ` (${up ? '+' : ''}${(((h.new_price - h.old_price) / h.old_price) * 100).toFixed(1)}%)` : '';
  const moqChanged = h.old_moq !== h.new_moq && h.new_moq != null;

  return `<div class="tl-item">
    <div class="tl-date">${fmtDate(h.changed_at)}</div>
    <div class="tl-change">
      <span class="from">¥${money(h.old_price)}</span>
      <span class="arrow">→</span>
      <span class="${dir}">¥${money(h.new_price)}${pct}</span>
    </div>
    ${moqChanged ? `<div class="tl-src">起订量 ${h.old_moq ?? '—'} → ${h.new_moq}</div>` : ''}
    <div class="tl-src">${esc(h.source_contract)}${h.confidence === 'low' ? ' · OCR 识别' : ''}</div>
  </div>`;
}

/* =============================== 供应商管理 =============================== */

async function renderSuppliers() {
  const [, unassigned] = await Promise.all([
    loadSuppliers(),
    api('/api/suppliers/unassigned/count').catch(() => ({ count: 0 })),
  ]);

  const unassignedCard = unassigned.count
    ? `<div class="supplier-card unassigned" data-unassigned="1">
         <div class="sc-name">未分类</div>
         <div class="sc-contact"><span class="none">还没归属供应商的产品</span></div>
         <div class="sc-foot"><span class="sc-count"><b>${unassigned.count}</b> 个产品</span></div>
       </div>`
    : '';

  if (!state.suppliers.length && !unassigned.count) {
    content.innerHTML = `
      <div class="toolbar"><button class="btn btn-primary" id="addSupplier">+ 新建供应商</button></div>
      ${emptyState(ICON.building, '还没有供应商档案', '建好供应商后,导入合同时就能把价格归到对应供应商名下,查价时也能按供应商筛选。')}`;
  } else {
    content.innerHTML = `
      <div class="toolbar">
        <button class="btn btn-primary" id="addSupplier">+ 新建供应商</button>
        <span class="result-stat" style="margin-left:auto">共 ${state.suppliers.length} 家</span>
      </div>
      <div class="supplier-grid">${state.suppliers.map(supplierCard).join('')}${unassignedCard}</div>`;

    content.querySelectorAll('.supplier-card').forEach((card) => {
      card.addEventListener('click', () => {
        if (card.dataset.unassigned) {
          // 点未分类直接跳到产品查询并筛出这批货
          state.supplierFilter = 'none';
          state.q = '';
          go('search');
        } else {
          openSupplier(Number(card.dataset.id));
        }
      });
    });
    bindCatChips(content);
  }

  document.getElementById('addSupplier').addEventListener('click', () => supplierForm(null));
}

/** 主营类目:顿号/逗号/分号分隔的自由标签。 */
function splitCats(text) {
  return String(text || '')
    .split(/[、,，;；/|\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 类目标签,点一下 = 搜这家供应商的这类货(分类联动产品)。 */
function catChips(s, { clickable = true } = {}) {
  const cats = splitCats(s.main_categories);
  if (!cats.length) return '';
  return `<div class="chip-row sc-cats">${cats
    .map(
      (c) =>
        `<span class="chip ${clickable ? 'chip-link' : ''}" data-cat="${esc(c)}" data-sid="${s.id}">${esc(c)}</span>`
    )
    .join('')}</div>`;
}

function bindCatChips(root) {
  root.querySelectorAll('.chip-link').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      // 联动:按"该供应商 + 该类目关键词"过滤产品
      state.supplierFilter = chip.dataset.sid;
      state.q = chip.dataset.cat;
      go('search');
    });
  });
}

const PIN_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';

/**
 * 工厂所在地:地址通常是"××省××市××路××号"这种整串,
 * 列表里只要前两级(省/市)就够辨识,详情页再看完整地址。
 */
function shortLocation(address) {
  const a = String(address || '').trim();
  if (!a) return '';
  const m = a.match(/^(.{2,4}?(?:省|市|自治区|特别行政区))?\s*(.{2,6}?(?:市|自治州|地区|县|区))?/);
  const parts = [m?.[1], m?.[2]].filter(Boolean);
  if (parts.length) return parts.join('');
  return a.length > 12 ? a.slice(0, 12) + '…' : a;
}

function supplierCard(s) {
  const contact = [s.contact_person, s.phone].filter(Boolean).join(' · ');
  const loc = shortLocation(s.address);
  return `<div class="supplier-card" data-id="${s.id}">
    <div class="sc-name">${esc(s.name)}</div>
    <div class="sc-contact">${contact ? esc(contact) : '<span class="none">未填联系人</span>'}</div>
    <div class="sc-loc" title="${esc(s.address || '')}">
      ${PIN_ICON}${loc ? esc(loc) : '<span class="none">未填工厂所在地</span>'}
    </div>
    ${catChips(s) || '<div class="sc-cats"><span class="none" style="font-size:12px">未填主营类目</span></div>'}
    <div class="sc-foot">
      <span class="sc-count"><b>${s.group_count ?? s.sku_count}</b> 个产品 · ${s.sku_count} 个货号</span>
      ${s.payment_terms ? `<span class="badge badge-mute">${esc(s.payment_terms)}</span>` : ''}
    </div>
  </div>`;
}

const SUPPLIER_FIELDS = [
  ['name', '供应商名称', true], ['short_name', '简称'],
  ['contact_person', '联系人'], ['phone', '电话'],
  ['email', '邮箱'], ['website', '网址'],
  ['payment_terms', '付款条件'], ['address', '地址'],
];

function supplierForm(s) {
  const editing = !!s;
  content.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${editing ? '编辑供应商' : '新建供应商'}</h2>
        <div class="meta">${editing ? esc(s.name) : '填写基础档案,之后可以随时修改'}</div>
      </div>
      <div class="detail-actions"><button class="btn" id="cancel">返回</button></div>
    </div>
    <div class="panel" style="max-width:780px">
      <div class="panel-title">基础信息</div>
      <div class="grid-2">
        ${SUPPLIER_FIELDS.map(
          ([key, label, req]) => `<label class="field">
            <span>${label}${req ? ' *' : ''}</span>
            <input type="text" data-key="${key}" value="${esc(s?.[key] ?? '')}" />
          </label>`
        ).join('')}
      </div>
      <label class="field"><span>主营产品类目</span>
        <input type="text" data-key="main_categories" value="${esc(s?.main_categories ?? '')}"
          placeholder="用顿号或逗号分隔,例如:长嘴钳、老虎钳、斜口钳、卡簧钳" /></label>
      <label class="field"><span>备注</span><textarea data-key="notes">${esc(s?.notes ?? '')}</textarea></label>
      <div style="display:flex;gap:9px;margin-top:6px">
        <button class="btn btn-primary" id="save">保存</button>
        ${editing ? '<button class="btn btn-danger" id="del" style="margin-left:auto">删除该供应商</button>' : ''}
      </div>
    </div>`;

  document.getElementById('cancel').addEventListener('click', () =>
    editing ? openSupplier(s.id) : renderSuppliers()
  );

  document.getElementById('save').addEventListener('click', async () => {
    const payload = {};
    content.querySelectorAll('[data-key]').forEach((el) => {
      payload[el.dataset.key] = el.value.trim() || null;
    });
    if (!payload.name) return toast('供应商名称不能为空', true);

    try {
      if (editing) {
        await api(`/api/suppliers/${s.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('已保存');
        await loadSuppliers();
        openSupplier(s.id);
      } else {
        const { id } = await api('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('已创建');
        await Promise.all([loadSuppliers(), refreshStats()]);
        openSupplier(id);
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  const delBtn = document.getElementById('del');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`删除供应商「${s.name}」?\n\n该供应商名下的产品和价格会保留,只是变成"未指定供应商"。`)) return;
      await api(`/api/suppliers/${s.id}`, { method: 'DELETE' });
      toast('已删除');
      await Promise.all([loadSuppliers(), refreshStats()]);
      renderSuppliers();
    });
  }
}

async function openSupplier(id) {
  const { supplier: s, products, contracts } = await api('/api/suppliers/' + id);

  const kv = (label, val, mono) =>
    `<dt>${label}</dt><dd class="${val ? '' : 'none'}" ${mono ? 'style="font-family:var(--font-mono)"' : ''}>${
      val ? esc(val) : '未填写'
    }</dd>`;

  content.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(s.name)}</h2>
        <div class="meta">${s.short_name ? esc(s.short_name) + ' · ' : ''}供货 ${products.length} 个货号 · ${contracts.length} 份合同记录</div>
        ${catChips(s)}
      </div>
      <div class="detail-actions">
        <button class="btn" id="back">← 供应商列表</button>
        <button class="btn btn-primary" id="edit">编辑档案</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">联系方式</div>
      <div class="grid-2">
        <dl class="kv">
          ${kv('联系人', s.contact_person)}
          ${kv('电话', s.phone, true)}
          ${kv('邮箱', s.email, true)}
        </dl>
        <dl class="kv">
          ${kv('付款条件', s.payment_terms)}
          ${kv('网址', s.website, true)}
          ${kv('地址', s.address)}
        </dl>
      </div>
      ${s.notes ? `<dl class="kv" style="margin-top:12px"><dt>备注</dt><dd>${esc(s.notes)}</dd></dl>` : ''}
    </div>

    <div class="panel">
      <div class="panel-title">供货清单</div>
      ${products.length
        ? `<div class="table-wrap" style="max-height:420px"><table>
            <thead><tr><th></th><th>货号</th><th>所属产品</th><th style="text-align:right">采购价</th><th style="text-align:right">起订量</th><th>更新时间</th></tr></thead>
            <tbody>${products.map((p) => `<tr data-clickable data-gid="${p.group_id ?? ''}" data-sku="${esc(p.sku)}">
              <td class="thumb-cell">${thumbHtml(p)}</td>
              <td class="sku">${esc(p.display_sku || p.sku)}</td>
              <td class="name">${esc(p.group_name || p.name) || '<span class="dim">—</span>'}</td>
              <td class="num price"><span class="unit">¥</span>${money(p.price)}${
                p.confidence === 'low' ? ' <span class="badge badge-warn">待核对</span>' : ''
              }</td>
              <td class="num">${p.moq ?? '—'}</td>
              <td class="dim">${fmtDate(p.last_updated, false)}</td>
            </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty-hint" style="text-align:left">还没有归到这家供应商的货号。导入合同时在「合同导入」页选上这家供应商即可。</div>'}
    </div>

    <div class="panel">
      <div class="panel-title">合同导入记录</div>
      ${contracts.length
        ? `<div class="table-wrap" style="max-height:300px"><table>
            <thead><tr><th>文件名</th><th>类型</th><th style="text-align:right">新增</th><th style="text-align:right">更新</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>${contracts.map(contractRow).join('')}</tbody></table></div>`
        : '<div class="empty-hint" style="text-align:left">还没有该供应商的合同导入记录。</div>'}
    </div>`;

  document.getElementById('back').addEventListener('click', renderSuppliers);
  document.getElementById('edit').addEventListener('click', () => supplierForm(s));
  bindCatChips(content);
  content.querySelectorAll('tr[data-sku]').forEach((tr) => {
    tr.addEventListener('click', () => {
      if (tr.dataset.gid) openGroup(Number(tr.dataset.gid), tr.dataset.sku);
    });
  });
}

const FILE_TYPE_LABEL = {
  excel: 'Excel',
  'pdf-text': 'PDF 文字版',
  'pdf-scan': 'PDF 扫描件',
  unknown: '无法识别',
};

const STATUS_BADGE = { success: 'badge-ok', empty: 'badge-mute', failed: 'badge-warn' };
const STATUS_LABEL = { success: '成功', empty: '未识别到数据', failed: '失败' };

function contractRow(c) {
  return `<tr>
    <td class="sku">${esc(c.filename)}</td>
    <td class="dim">${FILE_TYPE_LABEL[c.file_type] || esc(c.file_type)}</td>
    <td class="num">${c.rows_new}</td>
    <td class="num">${c.rows_matched}</td>
    <td><span class="badge ${STATUS_BADGE[c.status] || 'badge-mute'}">${STATUS_LABEL[c.status] || esc(c.status)}</span></td>
    <td class="dim">${fmtDate(c.processed_at)}</td>
  </tr>`;
}

/* ================================ 合同导入 ================================ */

async function renderImport() {
  await loadSuppliers();

  content.innerHTML = `
    <div class="panel">
      <div class="panel-title">选择本批合同对应的供应商</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="importSupplier" style="min-width:240px;width:auto">${supplierOptions('')}</select>
        <span class="result-stat">解析出的价格会归到这家供应商名下,可留空。</span>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">方式一 · 拖入文件</div>
      <div class="dropzone" id="dz">
        <div class="dz-icon">${ICON.upload}</div>
        <div class="dz-title">把合同文件拖到这里</div>
        <div class="dz-hint">
          支持 Excel(.xlsx/.xls)、PDF 文字版、PDF 扫描件,可一次拖多个<br />
          也可以点击这里选择文件 · 上传的文件会归档到 archive 文件夹
        </div>
        <input type="file" id="fileInput" multiple accept=".xlsx,.xls,.pdf" />
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">方式二 · 扫描指定文件夹</div>
      <div class="note">${ICON.alert}<div>扫描是<b>只读</b>的:只会读取文件夹里的合同来提取价格,<b>不会移动、改名或删除你的原始档案</b>。</div></div>
      <label class="field" style="margin-bottom:11px">
        <span>合同所在文件夹</span>
        <div class="path-row">
          <input type="text" id="scanPath" placeholder="点右边「浏览…」选择,或直接粘贴路径" />
          <button class="btn" id="scanBrowse">浏览…</button>
        </div>
      </label>
      <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
        <label class="check"><input type="checkbox" id="scanRecursive" /> 含子文件夹</label>
        <span style="flex:1"></span>
        <button class="btn" id="previewBtn">先看有多少文件</button>
        <button class="btn btn-primary" id="scanBtn">开始扫描</button>
      </div>
    </div>

    <div id="importResults"></div>

    <div class="panel">
      <div class="panel-title">最近导入记录</div>
      <div id="contractLog"></div>
    </div>`;

  setupDropzone();
  setupScan();
  loadContractLog();
}

function currentSupplierId() {
  const el = document.getElementById('importSupplier');
  return el && el.value ? el.value : '';
}

function setupDropzone() {
  const dz = document.getElementById('dz');
  const input = document.getElementById('fileInput');

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) uploadFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('over');
    })
  );
  dz.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });

  ['dragover', 'drop'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      if (!dz.contains(e.target) && !e.target.closest('.add-image')) e.preventDefault();
    })
  );
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(xlsx|xls|pdf)$/i.test(f.name));
  if (!files.length) return toast('只支持 .xlsx / .xls / .pdf 文件', true);

  const box = document.getElementById('importResults');
  box.innerHTML = `<div class="panel"><div class="panel-title">正在解析</div>
    <div class="result-row"><div class="spinner"></div>
    <div class="result-name">正在处理 ${files.length} 个文件…</div>
    <div class="result-stat">扫描件需要 OCR,可能要等十几秒</div></div></div>`;

  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  const sid = currentSupplierId();
  if (sid) fd.append('supplier_id', sid);

  try {
    const { results } = await api('/api/upload', { method: 'POST', body: fd });
    showImportResults(results, '上传解析结果');
    await Promise.all([refreshStats(), loadSuppliers()]);
    loadContractLog();
  } catch (err) {
    box.innerHTML = '';
    toast(err.message, true);
  }
}

function setupScan() {
  attachFolderPicker(document.getElementById('scanPath'), document.getElementById('scanBrowse'));

  document.getElementById('previewBtn').addEventListener('click', async () => {
    const path = document.getElementById('scanPath').value.trim();
    if (!path) return toast('请先填写文件夹路径', true);
    try {
      const r = await api('/api/scan/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, recursive: document.getElementById('scanRecursive').checked }),
      });
      document.getElementById('importResults').innerHTML = `
        <div class="panel"><div class="panel-title">扫描预览</div>
          <div class="result-row ok"><div class="result-name">找到 ${r.count} 个可解析的合同文件</div></div>
          ${r.files.length ? `<div class="empty-hint" style="text-align:left;margin-top:10px;max-width:none">
            ${r.files.slice(0, 40).map(esc).join(' · ')}${r.count > 40 ? ` …等 ${r.count} 个` : ''}
          </div>` : ''}
        </div>`;
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('scanBtn').addEventListener('click', async () => {
    const path = document.getElementById('scanPath').value.trim();
    if (!path) return toast('请先填写文件夹路径', true);

    const box = document.getElementById('importResults');
    box.innerHTML = `<div class="panel"><div class="panel-title">正在扫描</div>
      <div class="result-row"><div class="spinner"></div>
      <div class="result-name">正在读取并解析 ${esc(path)}</div>
      <div class="result-stat">文件多或含扫描件时会比较慢</div></div></div>`;

    const sid = currentSupplierId();
    try {
      const { results } = await api('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          recursive: document.getElementById('scanRecursive').checked,
          supplier_id: sid || null,
        }),
      });
      showImportResults(results, '文件夹扫描结果');
      await Promise.all([refreshStats(), loadSuppliers()]);
      loadContractLog();
    } catch (err) {
      box.innerHTML = '';
      toast(err.message, true);
    }
  });
}

function showImportResults(results, title) {
  const total = results.reduce(
    (a, r) => ({
      created: a.created + (r.created || 0),
      matched: a.matched + (r.matched || 0),
      low: a.low + (r.lowConfidence || 0),
      failed: a.failed + (r.status === 'failed' ? 1 : 0),
    }),
    { created: 0, matched: 0, low: 0, failed: 0 }
  );

  const rows = results.length
    ? results.map((r) => {
        const cls = r.status === 'failed' ? 'failed' : r.status === 'empty' ? 'warn' : 'ok';
        const detail =
          r.status === 'failed'
            ? `<div class="result-stat" style="color:var(--warn)">${esc(r.error)}</div>`
            : r.status === 'empty'
              ? '<div class="result-stat">没识别出价格行 — 可能表头不是常见写法</div>'
              : `<div class="result-stat">新增 <b>${r.created}</b> · 更新 <b>${r.matched}</b>${
                  r.lowConfidence ? ` · <b style="color:var(--warn)">${r.lowConfidence}</b> 条待核对` : ''
                }${r.described ? ` · <b>${r.described}</b> 条带规格说明` : ''}${
                  r.hasTerms ? ' · 已抓取合同通用要求' : ''
                }</div>`;
        // 把识别到的列显示出来,识别错了能一眼看出是哪一列认歪了
        const report = r.columnReport
          ? `<div class="col-report">识别结果 · ${esc(r.columnReport)}${
              r.aiRejected ? ` · 模型有 ${r.aiRejected} 行未通过原文校验,已丢弃` : ''
            }${r.aiError ? ` · 本地 AI 未生效(${esc(r.aiError)}),已退回规则解析` : ''}</div>`
          : '';
        const method = r.parseMethod === 'ai'
          ? '<span class="badge badge-warn">本地 AI</span>'
          : '';
        return `<div class="result-row ${cls}">
          <div class="result-name">${esc(r.filename)}</div>
          <span class="badge badge-mute">${FILE_TYPE_LABEL[r.fileType] || '—'}</span>
          ${method}
          ${detail}
          ${report}
        </div>`;
      }).join('')
    : '<div class="empty-hint" style="text-align:left">这个文件夹里没有找到可解析的合同文件。</div>';

  document.getElementById('importResults').innerHTML = `
    <div class="panel">
      <div class="panel-title">${title}</div>
      ${results.length ? `<div class="result-row" style="border-left-color:var(--accent-line);background:var(--raised)">
        <div class="result-name">共处理 ${results.length} 个文件</div>
        <div class="result-stat">新增 <b>${total.created}</b> 个货号 · 更新 <b>${total.matched}</b> 个价格${
          total.low ? ` · <b style="color:var(--warn)">${total.low}</b> 条待核对` : ''
        }${total.failed ? ` · <b style="color:var(--warn)">${total.failed}</b> 个失败` : ''}</div>
      </div>` : ''}
      ${rows}
    </div>`;
}

async function loadContractLog() {
  const box = document.getElementById('contractLog');
  if (!box) return;
  const rows = await api('/api/contracts');
  box.innerHTML = rows.length
    ? `<div class="table-wrap" style="max-height:340px"><table>
        <thead><tr><th>文件名</th><th>供应商</th><th>类型</th><th style="text-align:right">新增</th><th style="text-align:right">更新</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${rows.map((c) => `<tr title="${esc(c.column_report || '')}">
          <td class="sku">${esc(c.filename)}</td>
          <td>${c.supplier_name ? esc(c.supplier_name) : '<span class="dim">未指定</span>'}</td>
          <td class="dim">${FILE_TYPE_LABEL[c.file_type] || esc(c.file_type)}</td>
          <td class="num">${c.rows_new}</td>
          <td class="num">${c.rows_matched}</td>
          <td><span class="badge ${STATUS_BADGE[c.status] || 'badge-mute'}">${
            { success: '成功', empty: '未识别', failed: '失败' }[c.status] || esc(c.status)
          }</span></td>
          <td class="dim">${fmtDate(c.processed_at)}</td>
        </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-hint" style="text-align:left">还没有导入记录。</div>';
}

/* ================================ 本地 AI ================================ */

/* ============================ 文件夹选择器 ============================ */

const FOLDER_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const DRIVE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>';

/**
 * 浏览器拿不到本地绝对路径(webkitdirectory 只给相对名),
 * 所以走服务端目录接口,让用户点着选。
 * @returns {Promise<string|null>} 选中的绝对路径,取消则 null
 */
function pickFolder(startPath) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '60';
    const box = document.createElement('div');
    box.className = 'picker';
    document.body.append(backdrop, box);

    let cur = startPath || '';

    const done = (val) => {
      backdrop.remove();
      box.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    backdrop.addEventListener('click', () => done(null));
    document.addEventListener('keydown', onKey);

    async function load(p) {
      const list = document.getElementById('pickerList');
      list.innerHTML = '<div class="picker-empty">读取中…</div>';
      let r;
      try {
        r = await api('/api/fs/list?path=' + encodeURIComponent(p || ''));
      } catch (err) {
        list.innerHTML = `<div class="picker-empty">${esc(err.message)}</div>`;
        return;
      }
      cur = r.path || '';
      document.getElementById('pickerCur').textContent = cur || '选择一个位置';
      document.getElementById('pickerUp').disabled = r.parent === null;
      document.getElementById('pickerChoose').disabled = !cur;
      document.getElementById('pickerNew').disabled = !cur;

      let html = '';
      if (!cur) {
        // 顶层:先给常用位置,再给盘符
        if (r.shortcuts?.length) {
          html += '<div class="picker-sep">常用位置</div>';
          html += r.shortcuts
            .map(
              (s) =>
                `<div class="picker-item shortcut" data-path="${esc(s.path)}">${FOLDER_ICON}${esc(s.name)}</div>`
            )
            .join('');
        }
        html += '<div class="picker-sep">此电脑</div>';
        html += r.roots
          .map((d) => `<div class="picker-item" data-path="${esc(d.path)}">${DRIVE_ICON}${esc(d.name)}</div>`)
          .join('');
      } else if (r.readError) {
        html = `<div class="picker-empty">${esc(r.readError)}</div>`;
      } else if (!r.entries.length) {
        html = '<div class="picker-empty">这个文件夹里没有子文件夹<br />可以直接点「选择此处」</div>';
      } else {
        html = r.entries
          .map((e) => `<div class="picker-item" data-path="${esc(e.path)}">${FOLDER_ICON}${esc(e.name)}</div>`)
          .join('');
      }
      list.innerHTML = html;
      list.scrollTop = 0;
      list.querySelectorAll('.picker-item').forEach((it) => {
        it.addEventListener('click', () => load(it.dataset.path));
      });
    }

    box.innerHTML = `
      <div class="picker-head">
        <h3 style="flex:1">选择文件夹</h3>
        <button class="icon-btn" id="pickerClose" title="取消">${ICON.close}</button>
      </div>
      <div class="picker-bar">
        <button class="btn btn-sm" id="pickerUp">← 上一级</button>
        <button class="btn btn-sm" id="pickerRoot">此电脑</button>
        <span class="picker-cur" id="pickerCur"></span>
      </div>
      <div class="picker-list" id="pickerList"></div>
      <div class="picker-foot">
        <button class="btn btn-sm" id="pickerNew">新建文件夹</button>
        <span style="flex:1"></span>
        <button class="btn" id="pickerCancel">取消</button>
        <button class="btn btn-primary" id="pickerChoose">选择此处</button>
      </div>`;

    box.querySelector('#pickerClose').addEventListener('click', () => done(null));
    box.querySelector('#pickerCancel').addEventListener('click', () => done(null));
    box.querySelector('#pickerChoose').addEventListener('click', () => done(cur));
    box.querySelector('#pickerRoot').addEventListener('click', () => load(''));
    box.querySelector('#pickerUp').addEventListener('click', async () => {
      const r = await api('/api/fs/list?path=' + encodeURIComponent(cur)).catch(() => null);
      load(r ? r.parent ?? '' : '');
    });
    box.querySelector('#pickerNew').addEventListener('click', async () => {
      const name = prompt('新文件夹名称:');
      if (!name) return;
      try {
        const r = await api('/api/fs/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: cur, name }),
        });
        load(r.path);
      } catch (err) {
        toast(err.message, true);
      }
    });

    load(startPath || '');
  });
}

/** 给一个输入框挂上「浏览…」按钮。 */
function attachFolderPicker(input, btn) {
  btn.addEventListener('click', async () => {
    const start = input.value.trim() || input.placeholder?.trim() || '';
    const picked = await pickFolder(start);
    if (picked) input.value = picked;
  });
}

/* ============================== 设置弹窗 ============================== */

const SETTINGS_SECTIONS = [
  {
    id: 'ai',
    label: 'AI 接入',
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>',
  },
  {
    id: 'paths',
    label: '存储位置',
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  },
  {
    id: 'backup',
    label: '备份迁移',
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  },
  {
    id: 'update',
    label: '版本更新',
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
  },
];

let settingsSection = 'ai';

/** 设置改为弹窗:内容独立滚动,不会带动整页。 */
async function openSettings(section) {
  if (section) settingsSection = section;
  document.querySelectorAll('.modal-backdrop, .settings-modal').forEach((el) => el.remove());

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.id = 'settingsModal';
  document.body.append(backdrop, modal);

  const close = () => {
    backdrop.remove();
    modal.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    // 文件夹选择器开着时,Esc 先关它
    if (e.key === 'Escape' && !document.querySelector('.picker')) close();
  };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const hasUpdate = document.getElementById('versionChip')?.classList.contains('has-update');

  modal.innerHTML = `
    <div class="settings-head">
      <div style="flex:1">
        <h2>设置</h2>
        <div class="sub">所有配置只存本机</div>
      </div>
      <button class="icon-btn" id="settingsClose" title="关闭">${ICON.close}</button>
    </div>
    <div class="settings-body">
      <div class="settings-nav" id="settingsNav">
        ${SETTINGS_SECTIONS.map(
          (s) => `<button data-section="${s.id}" class="${s.id === settingsSection ? 'active' : ''}">
            ${s.icon}${s.label}
            ${s.id === 'update' && hasUpdate ? '<span class="nav-flag"></span>' : ''}
          </button>`
        ).join('')}
      </div>
      <div class="settings-content" id="settingsContent"></div>
    </div>`;

  modal.querySelector('#settingsClose').addEventListener('click', close);
  modal.querySelectorAll('#settingsNav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      settingsSection = btn.dataset.section;
      modal.querySelectorAll('#settingsNav button').forEach((b) =>
        b.classList.toggle('active', b === btn)
      );
      paintSettingsSection();
    });
  });

  await paintSettingsSection();
}

async function paintSettingsSection() {
  const box = document.getElementById('settingsContent');
  if (!box) return;
  box.innerHTML = '<div class="result-row"><div class="spinner"></div><div class="result-name">加载中…</div></div>';
  box.scrollTop = 0;

  const s = await api('/api/settings');

  if (settingsSection === 'ai') {
    box.innerHTML = sectionAiHtml(s);
    setupAiPanel();
  } else if (settingsSection === 'paths') {
    box.innerHTML = `
      <div class="settings-section-title">存储位置</div>
      <div class="settings-section-desc">数据始终存在本机。改路径后<b>需要重启程序</b>才生效,留空 = 用默认位置。</div>
      <div id="pathsBox"><div class="result-row"><div class="spinner"></div><div class="result-name">读取中…</div></div></div>`;
    await setupPathsPanel();
  } else if (settingsSection === 'backup') {
    box.innerHTML = `
      <div class="settings-section-title">备份与迁移</div>
      <div class="settings-section-desc">
        导出会把<b>全部产品、货号、价格、调价历史、供应商、自定义参数和产品图片</b>打包进<b>一个 .db 文件</b>。
        换设备时把这个文件导进去,新机器就是原样的库 —— 图片也在里面,不用单独管。
      </div>
      <div class="settings-group">
        <div class="settings-group-title">导出 / 导入</div>
        <div class="settings-actions">
          <button class="btn btn-primary" id="exportBtn">导出备份文件</button>
          <label class="btn" id="importBtn">导入备份文件
            <input type="file" id="restoreInput" accept=".db" style="display:none" /></label>
        </div>
        <div id="backupResult" style="margin-top:14px"></div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">安全说明</div>
        <div class="spec-text">导入前会自动把当前库另存到 <code style="font-family:var(--font-mono)">data/backups/</code>,导错了能捞回来。

备份文件<b>不含任何密钥</b>(GitHub 令牌、AI API Key 都会被剔除),可以放心传给另一台设备。</div>
      </div>`;
    setupBackupPanel();
  } else if (settingsSection === 'update') {
    box.innerHTML = sectionUpdateHtml(s);
    setupUpdatePanel();
  }
}

function sectionAiHtml(s) {
  const on = s.ai_enabled === '1';
  const isCloud = s.ai_provider === 'cloud';
  return `
    <div class="settings-section-title">AI 接入</div>
    <div class="settings-section-desc">
      解析<b>先走规则</b>,只有规则搞不定的合同(认不出表格、扫描件、一行没识别出来)才调用模型。
      模型连不上会自动退回规则解析,<b>不会导致导入失败</b>。
    </div>

    <div class="settings-group">
      <label class="check">
        <input type="checkbox" id="aiEnabled" ${on ? 'checked' : ''} /> 启用 AI 兜底解析与对话查询
      </label>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">模型来源</div>
      <div class="radio-cards">
        <label class="radio-card ${isCloud ? '' : 'active'}" data-provider="local">
          <div class="radio-card-title">
            <input type="radio" name="aiProvider" value="local" ${isCloud ? '' : 'checked'} /> 本地模型
          </div>
          <div class="radio-card-desc">自己机器或内网上的 Ollama。<b>数据不出内网</b>,适合含机密的合同。</div>
        </label>
        <label class="radio-card ${isCloud ? 'active' : ''}" data-provider="cloud">
          <div class="radio-card-title">
            <input type="radio" name="aiProvider" value="cloud" ${isCloud ? 'checked' : ''} /> 云端接口
          </div>
          <div class="radio-card-desc">DeepSeek / OpenAI。效果好、免部署,但<b>合同全文会发给服务商</b>。</div>
        </label>
      </div>

      <div id="localCfg" ${isCloud ? 'hidden' : ''}>
        <label class="field"><span>Ollama 地址</span>
          <input type="text" id="aiUrl" value="${esc(s.ai_base_url)}" placeholder="http://127.0.0.1:11434" /></label>
        <label class="field"><span>模型名称</span>
          <input type="text" id="aiModel" value="${esc(s.ai_model)}" placeholder="qwen2.5:14b" /></label>
      </div>

      <div id="cloudCfg" ${isCloud ? '' : 'hidden'}>
        <div class="note">${ICON.alert}<div><b>合同全文会发送给服务商。</b>合同里通常含采购价、供应商信息,可能还有客户货号和客户专属要求 —— 这些往往受保密义务约束。用之前请确认公司政策允许,并核对对方的数据留存与训练条款。需要保密时请选本地模型。</div></div>
        <label class="field"><span>服务商</span>
          <select id="cloudPreset">
            <option value="deepseek" ${s.ai_cloud_preset === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
            <option value="openai" ${s.ai_cloud_preset === 'openai' ? 'selected' : ''}>OpenAI</option>
            <option value="custom" ${s.ai_cloud_preset === 'custom' ? 'selected' : ''}>自定义(OpenAI 兼容接口)</option>
          </select></label>
        <div class="grid-2">
          <label class="field"><span>接口地址</span>
            <input type="text" id="cloudUrl" value="${esc(s.ai_cloud_base_url)}" placeholder="留空用服务商默认" /></label>
          <label class="field"><span>模型</span>
            <input type="text" id="cloudModel" value="${esc(s.ai_cloud_model)}" placeholder="留空用服务商默认" /></label>
        </div>
        <label class="field"><span>API Key ${
          s.ai_cloud_key_set ? '<span class="badge badge-ok">已设置</span>' : ''
        }</span>
          <input type="password" id="cloudKey" autocomplete="off"
            placeholder="${s.ai_cloud_key_set ? '已保存,留空则不改动' : 'sk-…'}" /></label>
        <div class="spec-text" style="font-size:13px;color:var(--fg-mute);margin:-6px 0 4px">
          密钥只存本机数据库,不回传页面、不进备份文件、不进 git。
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">高级</div>
      <label class="field" style="max-width:200px"><span>超时(秒)</span>
        <input type="number" id="aiTimeout" min="10" value="${Math.round(Number(s.ai_timeout_ms) / 1000)}" /></label>
    </div>

    <div class="settings-actions">
      <button class="btn btn-primary" id="saveAi">保存</button>
      <button class="btn" id="probeBtn">测试连接</button>
      ${s.ai_cloud_key_set ? '<button class="btn btn-danger" id="clearCloudKey">清除 API Key</button>' : ''}
    </div>
    <div id="probeResult" style="margin-top:14px"></div>

    <div class="settings-group" style="margin-top:22px">
      <div class="settings-group-title">安全底线</div>
      <div class="spec-text">模型返回的每一行都会<b>回原文逐字校验</b>:货号必须在原文出现,价格必须在原文出现且落在合理区间。对不上的行直接丢弃,不会写进库。

这样即使模型看错数字(把 ¥102.00 认成 ¥120.00),错误价格也进不来。</div>
    </div>`;
}

function sectionUpdateHtml(s) {
  return `
    <div class="settings-section-title">版本更新</div>
    <div class="settings-section-desc">
      更新<b>只替换代码</b>,<code style="font-family:var(--font-mono)">data/</code> 目录原样不动。
      数据库结构如有变化,新版本启动时会自动补列,旧数据能被直接接管。
    </div>

    <div class="settings-group">
      <div class="settings-group-title">更新源</div>
      <label class="field"><span>GitHub 仓库</span>
        <input type="text" id="updateRepo" value="${esc(s.update_repo)}" placeholder="Drsakura/sku-manager" /></label>
      <label class="field"><span>访问令牌 ${
        s.update_token_set ? '<span class="badge badge-ok">已设置</span>' : '(仓库公开则留空)'
      }</span>
        <input type="password" id="updateToken" autocomplete="off"
          placeholder="${s.update_token_set ? '已保存,留空则不改动' : '私有仓库需要,只读权限即可'}" /></label>
      <div class="spec-text" style="font-size:13px;color:var(--fg-mute);margin:-6px 0 4px">
        令牌只存本机数据库,不进 git、不随更新包分发,也不会回传到这个页面。
      </div>
    </div>

    <div class="settings-actions">
      <button class="btn" id="saveUpdate">保存</button>
      <button class="btn" id="checkUpdate">检查更新</button>
      ${s.update_token_set ? '<button class="btn btn-danger" id="clearToken">清除令牌</button>' : ''}
      <button class="btn btn-primary" id="applyUpdate" hidden>下载并更新</button>
    </div>
    <div id="updateResult" style="margin-top:14px"></div>
    <div class="update-progress" id="updateProgress" hidden>
      <div class="update-progress-bar"><div class="update-progress-fill" id="updateProgressFill"></div></div>
      <div class="update-progress-text" id="updateProgressText"></div>
    </div>`;
}

/* ------------------------------ AI 设置面板 ------------------------------ */

function currentProvider() {
  return document.querySelector('input[name="aiProvider"]:checked')?.value || 'local';
}

function aiPayload() {
  const provider = currentProvider();
  const p = {
    ai_enabled: document.getElementById('aiEnabled').checked ? '1' : '0',
    ai_provider: provider,
    ai_timeout_ms: String(Math.max(10, Number(document.getElementById('aiTimeout').value) || 180) * 1000),
  };
  if (provider === 'local') {
    p.ai_base_url = document.getElementById('aiUrl').value.trim();
    p.ai_model = document.getElementById('aiModel').value.trim();
  } else {
    p.ai_cloud_preset = document.getElementById('cloudPreset').value;
    p.ai_cloud_base_url = document.getElementById('cloudUrl').value.trim();
    p.ai_cloud_model = document.getElementById('cloudModel').value.trim();
    p.ai_cloud_key = document.getElementById('cloudKey').value; // 空 = 不改动
  }
  return p;
}

function setupAiPanel() {
  // 切换本地/云端:只显示对应那组配置
  document.querySelectorAll('input[name="aiProvider"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const cloud = currentProvider() === 'cloud';
      document.getElementById('localCfg').hidden = cloud;
      document.getElementById('cloudCfg').hidden = !cloud;
      document.querySelectorAll('.radio-card').forEach((c) =>
        c.classList.toggle('active', (c.dataset.provider === 'cloud') === cloud)
      );
    });
  });

  document.getElementById('saveAi').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiPayload()),
      });
      const k = document.getElementById('cloudKey');
      if (k) k.value = '';
      toast('已保存');
      refreshAiBadge();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('clearCloudKey')?.addEventListener('click', async () => {
    if (!confirm('清除已保存的 API Key?\n\n清除后云端解析和对话查询将无法使用。')) return;
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_cloud_key: null }),
    });
    toast('已清除');
    paintSettingsSection();
  });

  document.getElementById('probeBtn').addEventListener('click', async () => {
    const box = document.getElementById('probeResult');
    box.innerHTML = '<div class="result-row"><div class="spinner"></div><div class="result-name">正在连接…</div></div>';

    // 先存再测:probe 走的是已保存的配置,否则测的是旧值
    try {
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiPayload()),
      });
      const k = document.getElementById('cloudKey');
      if (k) k.value = '';
    } catch (err) {
      box.innerHTML = `<div class="result-row failed"><div class="result-name">${esc(err.message)}</div></div>`;
      return;
    }

    const r = await api('/api/ai/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const isCloud = currentProvider() === 'cloud';

    if (!r.ok) {
      box.innerHTML = `<div class="result-row failed">
        <div class="result-name">连不上</div>
        <div class="result-stat" style="color:var(--warn)">${esc(r.error)}</div>
        <div class="col-report">${
          isCloud
            ? '检查:API Key 是否正确 · 账户是否有余额 · 网络能否访问该服务商'
            : '检查:Ollama 是否已启动 · 地址端口是否正确 · 跨机器访问需 OLLAMA_HOST=0.0.0.0'
        }</div>
      </div>`;
      return;
    }

    box.innerHTML = `<div class="result-row ${r.modelInstalled ? 'ok' : 'warn'}">
      <div class="result-name">连接成功</div>
      <div class="result-stat">${
        r.modelInstalled ? `模型 <b>${esc(r.model)}</b> 可用` : `<b style="color:var(--warn)">未找到模型 ${esc(r.model)}</b>`
      }</div>
      <div class="col-report">可用模型:${
        r.models.length ? r.models.slice(0, 12).map(esc).join(' · ') : (isCloud ? '(服务商未返回列表)' : '(一个都没有,需要先 ollama pull)')
      }</div>
    </div>`;
    refreshAiBadge();
  });
}

/* ------------------------------ 存储路径面板 ------------------------------ */

const PATH_FIELDS = [
  ['dataDir', '数据保存路径', 'data', '数据库、产品图片、自动备份'],
  ['archiveDir', '合同归档目录', 'archive', '导入过的合同原件存放处'],
  ['inboxDir', '收件目录', 'inbox', '放进来的文件会被自动解析'],
];

async function setupPathsPanel() {
  const box = document.getElementById('pathsBox');
  if (!box) return;
  let info;
  try {
    info = await api('/api/paths');
  } catch (err) {
    box.innerHTML = `<div class="result-row failed"><div class="result-name">${esc(err.message)}</div></div>`;
    return;
  }

  box.innerHTML = `
    ${PATH_FIELDS.map(
      ([key, label, curKey, hint]) => `
      <div class="settings-group">
        <div class="settings-group-title">${label}${
          info.envOverride[curKey] ? ' <span class="badge badge-warn">被环境变量覆盖</span>' : ''
        }</div>
        <div class="spec-text" style="font-size:13px;color:var(--fg-mute);margin-bottom:9px">${hint}</div>
        <div class="path-row">
          <input type="text" data-path="${key}" value="${esc(info.configured[key] || '')}"
            placeholder="${esc(info.current[curKey])}" ${info.envOverride[curKey] ? 'disabled' : ''} />
          <button class="btn" data-browse="${key}" ${info.envOverride[curKey] ? 'disabled' : ''}>浏览…</button>
        </div>
        <div class="spec-text" style="font-size:12.5px;color:var(--fg-mute);margin-top:7px">
          当前实际使用:<code style="font-family:var(--font-mono)">${esc(info.current[curKey])}</code>
        </div>
      </div>`
    ).join('')}
    <div class="settings-actions">
      <button class="btn btn-primary" id="savePaths">保存</button>
    </div>
    <div id="pathsResult" style="margin-top:12px"></div>`;

  box.querySelectorAll('[data-browse]').forEach((btn) => {
    if (btn.disabled) return;
    attachFolderPicker(box.querySelector(`[data-path="${btn.dataset.browse}"]`), btn);
  });

  document.getElementById('savePaths').addEventListener('click', async () => {
    const payload = {};
    box.querySelectorAll('[data-path]').forEach((el) => {
      if (!el.disabled) payload[el.dataset.path] = el.value.trim();
    });
    try {
      const r = await api('/api/paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('pathsResult').innerHTML = `<div class="result-row warn">
        <div class="result-name">已保存,重启后生效</div>
        <div class="result-stat">数据不会自动搬家 —— 若要沿用现有数据,请把原目录内容拷到新位置</div>
        <div class="col-report">配置文件:${esc(r.configFile)}</div>
      </div>`;
    } catch (err) {
      document.getElementById('pathsResult').innerHTML =
        `<div class="result-row failed"><div class="result-name">${esc(err.message)}</div></div>`;
    }
  });
}

/* ---------------------------- 备份 / 还原 ---------------------------- */

function setupBackupPanel() {
  const box = document.getElementById('backupResult');

  document.getElementById('exportBtn').addEventListener('click', () => {
    box.innerHTML =
      '<div class="result-row"><div class="spinner"></div><div class="result-name">正在打包(图片多时要等几秒)…</div></div>';
    // 直接走浏览器下载,大文件不用先读进内存
    window.location.href = '/api/backup';
    setTimeout(() => {
      box.innerHTML =
        '<div class="result-row ok"><div class="result-name">备份文件已开始下载</div><div class="result-stat">保存好这个 .db 文件,换设备时导入它即可</div></div>';
    }, 1500);
  });

  document.getElementById('restoreInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    box.innerHTML =
      '<div class="result-row"><div class="spinner"></div><div class="result-name">正在检查备份文件…</div></div>';

    const fd = new FormData();
    fd.append('file', file);

    let info;
    try {
      info = await api('/api/backup/inspect', { method: 'POST', body: fd });
    } catch (err) {
      box.innerHTML = `<div class="result-row failed"><div class="result-name">${esc(err.message)}</div></div>`;
      return;
    }

    const when = info.exported_at ? fmtDate(info.exported_at) : '未知时间';
    const ok = confirm(
      `即将用这份备份【替换当前全部数据】\n\n` +
        `备份内容:${info.groups} 个产品 · ${info.items} 个货号 · ${info.suppliers} 个供应商 · ${info.images} 张图片\n` +
        `导出时间:${when}\n\n` +
        `当前库会先自动另存一份到 data/backups/ 作为后悔药。\n确定继续?`
    );
    if (!ok) {
      box.innerHTML = '<div class="result-row"><div class="result-name">已取消</div></div>';
      return;
    }

    box.innerHTML =
      '<div class="result-row"><div class="spinner"></div><div class="result-name">正在导入…</div></div>';

    const fd2 = new FormData();
    fd2.append('file', file);
    try {
      const r = await api('/api/backup/restore', { method: 'POST', body: fd2 });
      box.innerHTML = `<div class="result-row ok">
        <div class="result-name">导入完成</div>
        <div class="result-stat">${r.groups} 个产品 · ${r.items} 个货号 · ${r.suppliers} 个供应商 · ${r.images} 张图片</div>
        <div class="col-report">还原前的数据已另存为 data/backups/${esc(r.safetyCopy)}</div>
      </div>`;
      attrNamesLoaded = false;
      await Promise.all([refreshStats(), loadSuppliers(), refreshAiBadge()]);
      toast('导入完成,数据已刷新');
    } catch (err) {
      box.innerHTML = `<div class="result-row failed"><div class="result-name">导入失败:${esc(err.message)}</div></div>`;
    }
  });
}

/* ================================ 对话助手 ================================ */

const CHAT_SAMPLES = [
  '电缆钳剪多少钱',
  '哪些套装里带测电笔',
  '最近哪些产品调过价',
  '华新供货哪些产品',
  '最便宜的螺丝刀是哪个',
];

let chatHistory = [];

/* ------------------------- 悬浮问一句(全局,右下角) ------------------------- */

const chatFab = document.getElementById('chatFab');
const chatWidget = document.getElementById('chatWidget');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatSamples = document.getElementById('chatSamples');
const chatExport = document.getElementById('chatExport');
const chatExportMenu = document.getElementById('chatExportMenu');

/** 最近一条带数据表(rows)的 AI 回复 —— 导出按钮只对它可用。 */
function latestAiRows() {
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (m.role === 'ai' && Array.isArray(m.rows) && m.rows.length) return m.rows;
  }
  return null;
}

function updateExportUi() {
  const can = !!latestAiRows();
  chatExport.disabled = !can;
  chatExport.title = can ? '导出查询结果' : '先查一次,有结果才能导出';
}

function renderSamples() {
  chatSamples.innerHTML = CHAT_SAMPLES.map((q) => `<span class="chat-sample">${esc(q)}</span>`).join('');
}

function openChat() {
  chatWidget.hidden = false;
  chatFab.hidden = true; // 小窗盖住 FAB,收起时再显示
  chatWidget.classList.add('open');
  chatLog.innerHTML = chatHistory.map(chatMsgHtml).join(''); // 以 history 为准重建,保证一致
  renderSamples();
  updateExportUi();
  refreshAiBadge(); // 刷新头部 开/关 徽标
  chatInput.focus();
  scrollChatToEnd(chatLog);
}

function closeChat() {
  chatWidget.classList.remove('open');
  chatWidget.hidden = true;
  chatFab.hidden = false;
  chatExportMenu.hidden = true;
}

chatFab.addEventListener('click', openChat);
document.getElementById('chatClose').addEventListener('click', closeChat);
document.getElementById('chatSend').addEventListener('click', () => sendChat(chatInput.value, { log: chatLog, input: chatInput }));
document.getElementById('chatClear').addEventListener('click', () => {
  chatHistory = [];
  chatLog.innerHTML = '';
  updateExportUi();
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat(chatInput.value, { log: chatLog, input: chatInput });
  }
});
chatSamples.addEventListener('click', (e) => {
  const chip = e.target.closest('.chat-sample');
  if (chip) sendChat(chip.textContent, { log: chatLog, input: chatInput });
});

// 导出:小菜单选格式 → POST /api/export → blob 触发下载
chatExport.addEventListener('click', (e) => {
  e.stopPropagation();
  chatExportMenu.hidden = !chatExportMenu.hidden;
});
document.addEventListener('click', () => { chatExportMenu.hidden = true; });
chatExportMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = e.target.closest('button[data-format]');
  if (btn) exportTable(btn.dataset.format);
});

async function exportTable(format) {
  const rows = latestAiRows();
  if (!rows) { toast('没有可导出的查询结果', true); return; }
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]; // 与 chatRowsHtml 同规则
  const wasDisabled = chatExport.disabled;
  chatExport.disabled = true;
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, columns, rows }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `导出失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    a.download = `查询结果_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${format}`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, true);
  } finally {
    chatExport.disabled = wasDisabled;
  }
}

function chatMsgHtml(m) {
  if (m.role === 'me') {
    return `<div class="chat-msg me"><div class="chat-bubble">${esc(m.text)}</div></div>`;
  }
  const cls = m.error ? 'err' : 'ai';
  const rows = m.rows && m.rows.length ? chatRowsHtml(m.rows) : '';
  return `<div class="chat-msg ${cls}"><div class="chat-bubble">${esc(m.text)}</div>${rows}</div>`;
}

/** 把查询结果渲染成表格 —— 这才是报价依据。 */
function chatRowsHtml(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return `<div class="chat-rows">
    <div class="chat-rows-note">依据数据(${rows.length} 条,来自数据库实时查询):</div>
    <div class="table-wrap"><table>
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map(
          (r) =>
            `<tr>${cols
              .map((c) => {
                const v = r[c];
                const isNum = typeof v === 'number';
                return `<td class="${isNum ? 'num' : 'dim'}">${v === null || v === undefined || v === '' ? '—' : esc(v)}</td>`;
              })
              .join('')}</tr>`
        )
        .join('')}</tbody>
    </table></div>
  </div>`;
}

function scrollChatToEnd(log) {
  const el = log || document.getElementById('chatLog');
  if (el) el.scrollTop = el.scrollHeight;
}

async function sendChat(text, opts = {}) {
  const q = String(text || '').trim();
  if (!q) return;
  const log = opts.log || document.getElementById('chatLog');
  const input = opts.input || document.getElementById('chatInput');
  if (!log || !input) return;

  chatHistory.push({ role: 'me', text: q });
  log.insertAdjacentHTML('beforeend', chatMsgHtml({ role: 'me', text: q }));
  log.insertAdjacentHTML(
    'beforeend',
    '<div class="chat-msg ai" id="chatPending"><div class="chat-bubble"><span class="spinner" style="display:inline-block;vertical-align:-2px"></span> 正在查…</div></div>'
  );
  input.value = '';
  scrollChatToEnd(log);

  try {
    const r = await api('/api/agent/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    const msg = {
      role: 'ai',
      text: r.answer + (r.degraded ? '\n\n(模型不可用,以上为关键词搜索结果)' : ''),
      rows: r.rows,
    };
    chatHistory.push(msg);
    const pending = document.getElementById('chatPending'); // 窗口可能中途收起,没元素就只留 history
    if (pending) pending.outerHTML = chatMsgHtml(msg);
  } catch (err) {
    const msg = { role: 'ai', text: err.message, error: true };
    chatHistory.push(msg);
    const pending = document.getElementById('chatPending');
    if (pending) pending.outerHTML = chatMsgHtml(msg);
  }
  scrollChatToEnd(log);
  updateExportUi();
}

/* ---------------------- 左下角版本徽标 ---------------------- */

const UPDATE_LABELS = {
  idle: '', checking: '检查中', downloading: '下载中', verifying: '校验中',
  extracting: '解压中', installing: '安装中', restarting: '重启中',
  available: '有新版', uptodate: '已最新', disabled: '未配置', error: '检查失败',
};
const BUSY_STATES = ['checking', 'downloading', 'verifying', 'extracting', 'installing', 'restarting'];

let versionPollTimer = null;

async function refreshVersionChip() {
  const chip = document.getElementById('versionChip');
  if (!chip) return;
  let v;
  try {
    v = await api('/api/version');
  } catch {
    chip.className = 'version-chip err';
    document.getElementById('versionState').textContent = '服务未响应';
    return;
  }

  const st = v.update_state || {};
  const state = st.state || 'idle';
  document.getElementById('versionNum').textContent = 'v' + v.version;

  const busy = BUSY_STATES.includes(state);
  const hasUpdate = state === 'available';
  chip.className =
    'version-chip' + (hasUpdate ? ' has-update' : '') + (busy ? ' busy' : '') +
    (state === 'uptodate' ? ' ok' : '') + (state === 'error' ? ' err' : '');

  let label = UPDATE_LABELS[state] ?? '';
  if (busy && st.percent) label += ` ${st.percent}%`;
  if (hasUpdate && st.latest) label = `新版 v${st.latest}`;
  document.getElementById('versionState').textContent = label;
  chip.title = state === 'error' && st.error ? st.error
    : hasUpdate ? `有新版 v${st.latest},点击查看` : '点击检查更新';

  // 齿轮上也挂个小红点,设置藏起来之后仍要能被注意到
  const dot = document.getElementById('gearDot');
  if (dot) dot.hidden = !hasUpdate;

  // 更新过程中持续轮询,结束后停掉
  if (busy && !versionPollTimer) {
    versionPollTimer = setInterval(refreshVersionChip, 1500);
  } else if (!busy && versionPollTimer) {
    clearInterval(versionPollTimer);
    versionPollTimer = null;
  }
}

document.getElementById('versionChip').addEventListener('click', async () => {
  const chip = document.getElementById('versionChip');
  if (chip.classList.contains('busy')) return;

  // 有新版就直接打开设置的"版本更新"分区;否则当场检查一次
  if (chip.classList.contains('has-update')) {
    openSettings('update');
    return;
  }
  document.getElementById('versionState').textContent = '检查中';
  try {
    const r = await api('/api/update/check');
    await refreshVersionChip();
    if (r.state === 'disabled') {
      toast('还没配置更新源,先填仓库地址');
      openSettings('update');
    } else if (r.hasUpdate) {
      toast(`发现新版 v${r.latest}`);
      openSettings('update');
    } else if (r.ok) {
      toast('已是最新版本');
    } else {
      toast(r.error || '检查失败', true);
    }
  } catch (err) {
    toast(err.message, true);
    refreshVersionChip();
  }
});

async function refreshAiBadge() {
  try {
    const s = await api('/api/settings');
    const txt = s.ai_enabled === '1' ? '开' : '关';
    const w = document.getElementById('chatAiState');
    if (w) {
      w.textContent = txt;
      w.classList.toggle('off', s.ai_enabled !== '1');
    }
  } catch { /* 忽略 */ }
}

/* ---------------------------- 自动更新 ---------------------------- */

const UPDATE_STATE_LABEL = {
  idle: '等待中', disabled: '未配置', uptodate: '已是最新', available: '有新版本',
  checking: '检查中', downloading: '下载中', verifying: '校验中',
  extracting: '解压中', installing: '安装依赖中', ready: '就绪', restarting: '重启中', error: '出错',
};

let updateStateCache = { update_state: { state: 'idle' } };

/** 版本状态统一由左下角徽标(refreshVersionChip)呈现。 */
async function refreshVersion() {
  try {
    updateStateCache = await api('/api/version');
  } catch { /* 后端未起时忽略 */ }
  return refreshVersionChip();
}

function setupUpdatePanel() {
  const box = document.getElementById('updateResult');
  const progressWrap = document.getElementById('updateProgress');
  const progressFill = document.getElementById('updateProgressFill');
  const progressText = document.getElementById('updateProgressText');
  const applyBtn = document.getElementById('applyUpdate');
  const repoInput = document.getElementById('updateRepo');

  const repo = () => repoInput.value.trim();

  document.getElementById('saveUpdate').addEventListener('click', async () => {
    const tokenInput = document.getElementById('updateToken');
    try {
      // 令牌留空 = 保持原样(后端不会覆盖),避免每次保存都要重输
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_repo: repo(), update_token: tokenInput.value }),
      });
      tokenInput.value = '';
      toast('已保存');
    } catch (err) {
      toast(err.message, true);
      return;
    }
    doCheck();
  });

  document.getElementById('clearToken')?.addEventListener('click', async () => {
    if (!confirm('清除已保存的访问令牌?\n\n清除后若仓库是私有的,将无法检查和下载更新。')) return;
    try {
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_token: null }),
      });
      toast('令牌已清除');
      paintSettingsSection();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function doCheck() {
    box.innerHTML =
      '<div class="result-row"><div class="spinner"></div><div class="result-name">正在检查更新…</div></div>';
    applyBtn.hidden = true;
    let r;
    try {
      r = await api('/api/update/check');
    } catch (err) {
      box.innerHTML = `<div class="result-row failed"><div class="result-name">${esc(err.message)}</div></div>`;
      return;
    }
    if (!r.ok) {
      box.innerHTML = `<div class="result-row failed"><div class="result-name">${esc(r.error || '检查失败')}</div></div>`;
      return;
    }
    if (r.state === 'disabled') {
      box.innerHTML =
        '<div class="result-row"><div class="result-name">未配置仓库,先填 owner/repo 再保存</div></div>';
      return;
    }
    if (r.hasUpdate) {
      box.innerHTML = `<div class="result-row warn">
        <div class="result-name">发现新版本 <b>v${esc(r.latest)}</b></div>
        <div class="result-stat">当前 v${esc(r.current)}${r.published_at ? ' · 发布于 ' + fmtDate(r.published_at) : ''}</div>
        <div class="col-report">${esc(r.notes || '(无发布说明)')}</div>
      </div>`;
      applyBtn.hidden = false;
    } else {
      box.innerHTML = `<div class="result-row ok"><div class="result-name">已是最新版本 v${esc(r.current)}</div></div>`;
    }
  }

  document.getElementById('checkUpdate').addEventListener('click', doCheck);

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = '更新中…';
    progressWrap.hidden = false;
    try {
      await api('/api/update/apply', { method: 'POST' });
    } catch { /* 服务可能已开始重启,连接断开是正常的 */ }
    pollProgress();
  });

  function pollProgress() {
    api('/api/version')
      .then((r) => {
        const st = r.update_state || {};
        if (st.state === 'restarting' || st.state === 'ready') {
          progressFill.style.width = '100%';
          progressText.textContent = '更新完成,服务重启中…';
          waitServerUp();
          return;
        }
        if (st.state === 'error') {
          progressText.textContent = '更新失败:' + (st.error || '未知错误');
          applyBtn.disabled = false;
          applyBtn.textContent = '下载并更新';
          return;
        }
        progressFill.style.width = (st.percent || 0) + '%';
        progressText.textContent =
          (UPDATE_STATE_LABEL[st.state] || st.state) + (st.percent ? ' ' + st.percent + '%' : '');
        setTimeout(pollProgress, 1000);
      })
      .catch(() => {
        progressText.textContent = '服务正在重启,等待重连…';
        waitServerUp();
      });
  }

  async function waitServerUp() {
    for (let i = 0; i < 90; i++) {
      try {
        const r = await api('/api/version');
        if (r.version) {
          window.location.reload();
          return;
        }
      } catch { /* 还没起来 */ }
      await new Promise((res) => setTimeout(res, 2000));
    }
    toast('服务重启后未恢复,请手动重启', true);
  }

  // 进入设置页时已配置则自动查一次
  if (repo()) doCheck();
}

/* --------------------------------- 启动 --------------------------------- */

(async function init() {
  try {
    await Promise.all([refreshStats(), loadSuppliers(), refreshAiBadge()]);
  } catch (err) {
    toast('无法连接后端服务:' + err.message, true);
  }
  await refreshVersion();
  const st = updateStateCache.update_state;
  if (st && st.state === 'available' && st.latest) {
    toast(`发现新版本 v${st.latest},点左下角版本号更新`);
  }
  go('search');
})();
