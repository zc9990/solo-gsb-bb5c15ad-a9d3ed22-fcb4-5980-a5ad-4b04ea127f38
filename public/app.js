'use strict';

/* 骑马钉拼版预演前端：调用 /api/impose 获取拼版结果，用原生 Canvas 逐张绘制纸面。 */

const BINDING_TEXT = { left: '左装订', right: '右装订' };
const FLIP_TEXT = { long: '长边翻转', short: '短边翻转' };

const CANVAS_W = 1240;
const CANVAS_H = 720;

const form = document.getElementById('imposeForm');
const errorBox = document.getElementById('errorBox');
const resultCard = document.getElementById('resultCard');
const summaryBox = document.getElementById('summary');
const sheetSelect = document.getElementById('sheetSelect');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const exportBtn = document.getElementById('exportBtn');
const canvas = document.getElementById('sheetCanvas');
const tableBody = document.querySelector('#sheetTable tbody');
const jsonPreview = document.getElementById('jsonPreview');
const balancedSplitBox = document.getElementById('balancedSplit');
const chapterSplitBox = document.getElementById('chapterSplit');
const chapterStartsInput = document.getElementById('chapterStarts');

/* 试印核验面板元素 */
const addObservationBtn = document.getElementById('addObservationBtn');
const observationListEl = document.getElementById('observationList');
const observationCountEl = document.getElementById('observationCount');
const verifyBtn = document.getElementById('verifyBtn');
const clearTrialBtn = document.getElementById('clearTrialBtn');
const trialErrorEl = document.getElementById('trialError');
const trialResultEl = document.getElementById('trialResult');

const TRIAL_STATUS_TEXT = { verified: '核验通过', inconclusive: '无法判定', mismatch: '核验未通过' };
const SIDE_TEXT = { front: '正面', back: '背面' };
const POSITION_TEXT = { left: '左页位', right: '右页位' };
const ORIENTATION_TEXT = { up: '页首朝上', down: '页首朝下' };
const FIELD_TEXT = { blank: '空白', page: '页码', orientation: '朝向' };
const COMBO_TEXT = {
  'left-long': '左装订 · 长边翻转',
  'left-short': '左装订 · 短边翻转',
  'right-long': '右装订 · 长边翻转',
  'right-short': '右装订 · 短边翻转',
};

/* 章节优先分帖与均衡分帖互斥；勾选章节模式时才允许填写章节起始页 */
chapterSplitBox.addEventListener('change', () => {
  chapterStartsInput.disabled = !chapterSplitBox.checked;
  if (chapterSplitBox.checked) {
    balancedSplitBox.checked = false;
    chapterStartsInput.focus();
  }
});
balancedSplitBox.addEventListener('change', () => {
  if (balancedSplitBox.checked) {
    chapterSplitBox.checked = false;
    chapterStartsInput.disabled = true;
  }
});

/** 解析章节起始页输入：支持逗号 / 顿号 / 分号 / 空白分隔；无法解析的 token 原样上送，由服务端给出明确错误。 */
function parseChapterStarts(raw) {
  return raw
    .split(/[,，、;；\s]+/)
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      return Number.isInteger(n) ? n : token;
    });
}

const state = {
  result: null,
  flat: [], // 展平的 (帖, 张) 索引，便于逐张浏览
  idx: 0,
  observationDrafts: [], // 试印观察录入草稿（未随拼版重算前可自由增删）
  highlight: null,       // 页位高亮：{ signature, sheet, side, position }（点击差异跳转后设置）
};

/** 由表单构造拼版请求参数；withObservations=true 时附带录入的试印观察。 */
function buildPayload(withObservations) {
  const chapterSplit = chapterSplitBox.checked;
  const payload = {
    totalPages: Number(document.getElementById('totalPages').value),
    sheetsPerSignature: Number(document.getElementById('sheetsPerSignature').value),
    balancedSplit: balancedSplitBox.checked,
    chapterSplit,
    chapterStarts: chapterSplit ? parseChapterStarts(chapterStartsInput.value) : [],
    binding: document.getElementById('binding').value,
    flip: document.getElementById('flip').value,
    paperThickness: Number(document.getElementById('paperThickness').value),
    maxCompensation: Number(document.getElementById('maxCompensation').value),
    paperWidth: Number(document.getElementById('paperWidth').value),
    paperHeight: Number(document.getElementById('paperHeight').value),
    pageWidth: Number(document.getElementById('pageWidth').value),
    pageHeight: Number(document.getElementById('pageHeight').value),
    bleedMm: Number(document.getElementById('bleedMm').value),
    safetyMm: Number(document.getElementById('safetyMm').value),
  };
  if (withObservations) {
    payload.observations = collectObservations();
  }
  return payload;
}

/* ------------------------------ 数据获取与渲染 ------------------------------ */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  trialErrorEl.hidden = true;

  const payload = buildPayload(false);

  try {
    const data = await postImpose(payload);
    state.result = data;
    state.flat = [];
    data.signatures.forEach((sig, si) => {
      sig.sheets.forEach((sheet, shi) => state.flat.push({ si, shi }));
    });
    state.idx = 0;
    // 重新生成拼版后清空旧观察草稿、核验结果与高亮（页码结构可能已变）
    state.observationDrafts = [];
    state.highlight = null;
    resultCard.hidden = false;
    renderAll();
  } catch (err) {
    errorBox.textContent = `生成失败：${err.message}`;
    errorBox.hidden = false;
  }
});

/** 调用 /api/impose 并在非 2xx 时抛出服务端错误信息。 */
async function postImpose(payload) {
  const resp = await fetch('/api/impose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `服务器返回 ${resp.status}`);
  }
  return data;
}

function gotoSheet(index) {
  if (index < 0 || index >= state.flat.length || index === state.idx) return;
  state.idx = index;
  state.highlight = null; // 手动换张时清除差异高亮
  renderSheetNav();
  draw();
}

prevBtn.addEventListener('click', () => gotoSheet(state.idx - 1));

nextBtn.addEventListener('click', () => gotoSheet(state.idx + 1));

sheetSelect.addEventListener('change', () => gotoSheet(Number(sheetSelect.value)));

exportBtn.addEventListener('click', () => {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `imposition-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* ------------------------------ 试印核验 ------------------------------ */

/** 当前预览张位置 -> 观察草稿的初始值。 */
function currentSheetLocation() {
  const pos = state.flat[state.idx];
  const sig = state.result.signatures[pos.si];
  const sheet = sig.sheets[pos.shi];
  return { signature: sig.index, sheet: sheet.index };
}

/** 新增一条观察草稿：默认定位在当前预览张的正面左页位。 */
function addObservationDraft(preset) {
  const loc = currentSheetLocation();
  state.observationDrafts.push({
    signature: loc.signature,
    sheet: loc.sheet,
    side: 'front',
    position: 'left',
    blank: false,
    page: '',
    orientation: 'up',
    ...(preset || {}),
  });
  renderObservations();
}

addObservationBtn.addEventListener('click', () => addObservationDraft());

clearTrialBtn.addEventListener('click', () => {
  state.observationDrafts = [];
  state.highlight = null;
  trialErrorEl.hidden = true;
  if (state.result) {
    state.result.trialVerification = { enabled: false };
    renderSummary();
    renderTrialResult();
    jsonPreview.textContent = JSON.stringify(state.result, null, 2);
    draw();
  }
  renderObservations();
});

observationListEl.addEventListener('click', (event) => {
  const delBtn = event.target.closest('.obs-delete');
  if (!delBtn) return;
  const i = Number(delBtn.dataset.index);
  state.observationDrafts.splice(i, 1);
  renderObservations();
});

observationListEl.addEventListener('change', (event) => {
  const el = event.target;
  const row = el.closest('.obs-row');
  if (!row) return;
  const i = Number(row.dataset.index);
  const draft = state.observationDrafts[i];
  const field = el.dataset.field;
  if (field === 'signature' || field === 'sheet') {
    draft[field] = Number(el.value);
  } else if (field === 'blank') {
    draft.blank = el.value === 'true';
    if (draft.blank) draft.page = '';
    renderObservations(); // 切换空白时显示 / 隐藏页码输入
    return;
  } else {
    draft[field] = el.value;
  }
  // 帖变化时钳制张号到新帖实际张数范围，并刷新张下拉选项（各帖张数可能不同）
  if (field === 'signature') {
    const sig = state.result.signatures[draft.signature - 1];
    if (draft.sheet > sig.sheets.length) draft.sheet = sig.sheets.length;
    renderObservations();
  }
});

/** 从草稿收集观察；页码缺失等明显录入问题在前端先行提示。 */
function collectObservations() {
  return state.observationDrafts.map((d) => {
    const obs = {
      signature: Number(d.signature),
      sheet: Number(d.sheet),
      side: d.side,
      position: d.position,
      blank: d.blank,
      orientation: d.orientation,
    };
    if (!d.blank) {
      const page = String(d.page).trim() === '' ? NaN : Number(d.page);
      if (!Number.isInteger(page)) {
        throw new Error('存在未填写页码或页码非整数的观察（空白页请勾选「看到空白」）');
      }
      obs.page = page;
    }
    return obs;
  });
}

/** 渲染观察录入列表。 */
function renderObservations() {
  const r = state.result;
  observationCountEl.textContent = `${state.observationDrafts.length} / 12`;
  addObservationBtn.disabled = state.observationDrafts.length >= 12 || !r;
  observationListEl.innerHTML = '';
  if (state.observationDrafts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'trial-empty';
    empty.textContent = '尚未录入观察：可逐张翻看预览，点「＋ 按当前纸张新增观察」记录实物所见。';
    observationListEl.appendChild(empty);
    return;
  }
  state.observationDrafts.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'obs-row';
    row.dataset.index = String(i);

    const select = (field, options, value) => {
      const sel = document.createElement('select');
      sel.dataset.field = field;
      options.forEach(({ value: v, text }) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        if (String(v) === String(value)) opt.selected = true;
        sel.appendChild(opt);
      });
      return sel;
    };

    const sigSel = select('signature', r.signatures.map((sig) => ({
      value: sig.index,
      text: `第 ${sig.index} 帖`,
    })), d.signature);
    const sig = r.signatures[Number(d.signature) - 1];
    const sheetSel = select('sheet', sig.sheets.map((sh) => ({
      value: sh.index,
      text: `第 ${sh.index} 张`,
    })), d.sheet);
    const sideSel = select('side', [
      { value: 'front', text: '正面' },
      { value: 'back', text: '背面' },
    ], d.side);
    const posSel = select('position', [
      { value: 'left', text: '左页位' },
      { value: 'right', text: '右页位' },
    ], d.position);
    const blankSel = select('blank', [
      { value: 'false', text: '看到页码' },
      { value: 'true', text: '看到空白' },
    ], String(d.blank));
    const oriSel = select('orientation', [
      { value: 'up', text: '页首朝上' },
      { value: 'down', text: '页首朝下' },
    ], d.orientation);

    const pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.max = String(r.input.totalPages);
    pageInput.step = '1';
    pageInput.placeholder = '页码';
    pageInput.dataset.field = 'page';
    pageInput.value = d.page ?? '';
    if (d.blank) pageInput.disabled = true;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'obs-delete ghost';
    del.dataset.index = String(i);
    del.textContent = '删除';

    [sigSel, sheetSel, sideSel, posSel, blankSel, pageInput, oriSel, del].forEach((node) => row.appendChild(node));
    observationListEl.appendChild(row);
  });
}

/** 点击「试印核验」：携带观察重新调用同一接口，合并返回的核验结果。 */
verifyBtn.addEventListener('click', async () => {
  if (!state.result) return;
  trialErrorEl.hidden = true;
  if (state.observationDrafts.length === 0) {
    trialErrorEl.textContent = '请先至少录入 1 条实物观察（无观察时保持普通拼版流程，无需核验）。';
    trialErrorEl.hidden = false;
    return;
  }
  let observations;
  try {
    observations = collectObservations();
  } catch (err) {
    trialErrorEl.textContent = err.message;
    trialErrorEl.hidden = false;
    return;
  }
  verifyBtn.disabled = true;
  try {
    // 以「当前拼版结果的输入参数 + 观察」重算，保证候选中的 current 组合与画布所示一致
    // （核验针对的是当前拼版结果；改了表单需先重新「生成拼版」）。
    const payload = { ...state.result.input, observations };
    const data = await postImpose(payload);
    state.result.trialVerification = data.trialVerification;
    renderSummary();
    renderTrialResult();
    jsonPreview.textContent = JSON.stringify(state.result, null, 2);
  } catch (err) {
    trialErrorEl.textContent = `核验失败：${err.message}`;
    trialErrorEl.hidden = false;
  } finally {
    verifyBtn.disabled = false;
  }
});

function comboTextOf(c) {
  return COMBO_TEXT[`${c.binding}-${c.flip}`];
}

function seenValueText(seen) {
  if (seen.blank) return '空白';
  return `第 ${seen.page} 页 · ${ORIENTATION_TEXT[seen.orientation]}`;
}

function expectedValueText(exp) {
  const base = exp.blank ? '空白' : `第 ${exp.page} 页`;
  return `${base} · ${ORIENTATION_TEXT[exp.orientation]}`;
}

/** 渲染核验结论与四个候选评分。 */
function renderTrialResult() {
  const tv = state.result && state.result.trialVerification;
  trialResultEl.innerHTML = '';
  if (!tv || !tv.enabled) {
    const p = document.createElement('p');
    p.className = 'trial-empty';
    p.textContent = '尚未核验：录入观察后点击「试印核验」。';
    trialResultEl.appendChild(p);
    return;
  }
  const c = tv.conclusion;
  const banner = document.createElement('div');
  banner.className = `trial-banner ${c.status}`;
  banner.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = TRIAL_STATUS_TEXT[c.status];
  banner.appendChild(title);
  const msg = document.createElement('span');
  msg.textContent = c.message;
  banner.appendChild(msg);
  trialResultEl.appendChild(banner);

  const list = document.createElement('div');
  list.className = 'candidate-list';
  tv.candidates.forEach((cand) => {
    const item = document.createElement('details');
    item.className = 'candidate' + (cand.current ? ' current' : '') + (cand.zeroDifference ? ' zero' : '');
    if (cand.rank === 1) item.open = true;

    const sum = document.createElement('summary');
    const tags = [];
    if (cand.current) tags.push('当前');
    if (cand.zeroDifference) tags.push('零差异');
    const tagText = tags.length ? `（${tags.join('，')}）` : '';
    sum.textContent = `#${cand.rank} ${comboTextOf(cand)}${tagText}：错误观察 ${cand.wrongObservations} · 错误字段 ${cand.wrongFields}`;
    item.appendChild(sum);

    cand.observations.forEach((o) => {
      const line = document.createElement('div');
      line.className = 'candidate-obs' + (o.match ? ' match' : ' diff');
      const locText = `第 ${o.location.signature} 帖第 ${o.location.sheet} 张${SIDE_TEXT[o.location.side]}${POSITION_TEXT[o.location.position]}`;
      const head = document.createElement('span');
      head.className = 'obs-loc';
      head.textContent = o.match
        ? `✓ ${locText}：${seenValueText(o.observed)}`
        : `✗ ${locText}：实物「${seenValueText(o.observed)}」≠ 拼版「${expectedValueText(o.expected)}」（不符：${o.mismatches.map((m) => FIELD_TEXT[m]).join('、')}）`;
      line.appendChild(head);
      if (!o.match) {
        line.classList.add('jump-target');
        line.dataset.signature = String(o.location.signature);
        line.dataset.sheet = String(o.location.sheet);
        line.dataset.side = o.location.side;
        line.dataset.position = o.location.position;
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'jump-btn ghost';
        jump.textContent = '跳到该纸并高亮页位 →';
        line.appendChild(jump);
      }
      item.appendChild(line);
    });
    list.appendChild(item);
  });
  trialResultEl.appendChild(list);
}

/* 点击差异条目：跳到对应纸张并高亮该页位（跨帖 / 跨张定位）。 */
trialResultEl.addEventListener('click', (event) => {
  const target = event.target.closest('.jump-target');
  if (!target) return;
  jumpToLocation({
    signature: Number(target.dataset.signature),
    sheet: Number(target.dataset.sheet),
    side: target.dataset.side,
    position: target.dataset.position,
  });
});

/** 按 (帖, 张) 定位 flat 索引并设置高亮，然后滚动到画布。 */
function jumpToLocation(loc) {
  const idx = state.flat.findIndex(
    (p) => state.result.signatures[p.si].index === loc.signature
      && state.result.signatures[p.si].sheets[p.shi].index === loc.sheet,
  );
  if (idx < 0) return;
  state.idx = idx;
  state.highlight = loc;
  renderSheetNav();
  draw();
  canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAll() {
  renderSummary();
  renderSheetNav();
  renderTable();
  renderObservations();
  renderTrialResult();
  jsonPreview.textContent = JSON.stringify(state.result, null, 2);
  draw();
}

/** 本帖覆盖章节的可读文本，如「第 2 章」/「第 2–3 章」（非章节模式返回空串）。 */
function sigChaptersText(sig) {
  if (!sig.chapters || sig.chapters.length === 0) return '';
  const first = sig.chapters[0].index;
  const last = sig.chapters[sig.chapters.length - 1].index;
  return first === last ? `第 ${first} 章` : `第 ${first}–${last} 章`;
}

function renderSummary() {
  const r = state.result;
  const balanced = r.balanced && r.balanced.enabled;
  const chapterMode = r.chapters && r.chapters.enabled;
  const modeText = chapterMode
    ? `章节优先分帖：${r.chapters.count} 章 · 上限 ${r.input.sheetsPerSignature} 张/帖`
    : balanced
      ? `均衡分帖：上限 ${r.input.sheetsPerSignature} 张/帖`
      : `固定分帖：每帖 ${r.input.sheetsPerSignature} 张（${r.pagesPerSignature} 页）`;
  const chips = [
    { text: `成品 ${r.input.totalPages} 页` },
    { text: modeText, cls: balanced ? 'balanced' : chapterMode ? 'chapter' : '' },
    { text: `共 ${r.signatureCount} 帖` },
    { text: `补白后 ${r.paddedPages} 页` },
    { text: r.blankPages > 0 ? `自动补空白页 ${r.blankPages} 页` : '无需补白', cls: r.blankPages > 0 ? 'warn' : '' },
    { text: BINDING_TEXT[r.input.binding] },
    { text: FLIP_TEXT[r.input.flip] },
  ];
  if (chapterMode) {
    const counts = r.chapters.actualSheetCounts;
    chips.push({
      text: `章节起始页：[${r.chapters.starts.join(', ')}]`,
      cls: 'chapter',
    });
    chips.push({
      text: r.chapters.splitCount > 0
        ? `章节被拆分 ${r.chapters.splitCount} 次（第 ${r.chapters.splitChapters.join('、')} 章）`
        : '章节均未被拆分',
      cls: r.chapters.splitCount > 0 ? 'warn' : 'chapter',
    });
    chips.push({
      text: `各帖实际张数 [${counts.join(', ')}]`,
      cls: 'chapter',
    });
  }
  if (balanced) {
    const counts = r.balanced.actualSheetCounts;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    chips.push({
      text: min === max
        ? `各帖实际均为 ${min} 张`
        : `各帖实际 ${min}～${max} 张（[${counts.join(', ')}]）`,
      cls: 'balanced',
    });
    if (r.balanced.savedBlankPages > 0) {
      chips.push({
        text: `较固定分帖（${r.balanced.fixedPaddedPages} 页）节省空白页 ${r.balanced.savedBlankPages} 页`,
        cls: 'saved',
      });
    } else {
      chips.push({ text: '本页数下与固定分帖用纸相同', cls: 'balanced' });
    }
  }
  chips.push(
    r.creep.enabled
      ? { text: `爬移补偿：纸厚 ${formatMm(r.input.paperThickness)} mm · 上限 ${formatMm(r.input.maxCompensation)} mm`, cls: 'creep' }
      : { text: '爬移补偿：未启用', cls: 'creep-off' },
  );
  if (r.fit && r.fit.enabled) {
    chips.push(
      r.fit.ok
        ? { text: `适配检查：${r.fit.totalSlots} 个页位全部通过`, cls: 'fit-ok' }
        : { text: `适配检查：${r.fit.failCount} / ${r.fit.totalSlots} 页位不适配`, cls: 'fit-fail' }
    );
  }
  if (r.trialVerification && r.trialVerification.enabled) {
    const c = r.trialVerification.conclusion;
    const clsMap = { verified: 'trial-verified', inconclusive: 'trial-inconclusive', mismatch: 'trial-mismatch' };
    chips.push({
      text: `试印核验：${TRIAL_STATUS_TEXT[c.status]}（${r.trialVerification.observations.length} 条观察）`
        + (c.status === 'verified' && !c.matchesCurrent ? ' · 零差异组合非当前设置' : ''),
      cls: c.status === 'verified' && !c.matchesCurrent ? 'trial-inconclusive' : clsMap[c.status],
    });
  }
  summaryBox.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    summaryBox.appendChild(span);
  });
}

/** mm 数值格式化为两位小数（保留正负号）。 */
function formatMm(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** 一张纸四个页位（正面左右 + 背面左右）。 */
function sheetSlots(sheet) {
  return [sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right];
}

/** 该张纸是否存在适配检查不合格的页位。 */
function sheetHasFitFail(sheet) {
  return sheetSlots(sheet).some((s) => s.fit && !s.fit.ok);
}

function renderSheetNav() {
  const r = state.result;
  const fitOn = r.fit && r.fit.enabled;
  sheetSelect.innerHTML = '';
  state.flat.forEach((pos, i) => {
    const sig = r.signatures[pos.si];
    const sheet = sig.sheets[pos.shi];
    const opt = document.createElement('option');
    opt.value = String(i);
    const chapterNote = sigChaptersText(sig) ? ` · ${sigChaptersText(sig)}` : '';
    opt.textContent = `第 ${sig.index} 帖（${sig.actualSheetCount} 张${chapterNote}） · 第 ${sheet.index} 张${fitOn && sheetHasFitFail(sheet) ? ' ⚠' : ''}`;
    sheetSelect.appendChild(opt);
  });
  sheetSelect.value = String(state.idx);
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === state.flat.length - 1;
}

function slotText(slot) {
  return slot.blank ? '空白' : `第 ${slot.page} 页`;
}

function renderTable() {
  const r = state.result;
  const creepOn = r.creep.enabled;
  const fitOn = r.fit && r.fit.enabled;
  const flipNote = r.input.flip === 'long'
    ? '背面：左右页位不变，内容旋转 180°'
    : '背面：左右页位互换';
  const creepNote = creepOn
    ? `爬移：左页位 ${r.input.binding === 'left' ? '+' : '−'} / 右页位 ${r.input.binding === 'left' ? '−' : '+'}，上限 ${formatMm(r.input.maxCompensation)} mm`
    : '爬移补偿未启用，offsetMm 均为 0';
  tableBody.innerHTML = '';
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      [
        { name: '正面', side: sheet.front, note: '正面' },
        { name: '背面', side: sheet.back, note: flipNote },
      ].forEach(({ name, side, note }) => {
        const tr = document.createElement('tr');
        // 帖号单元格：各帖实际张数不同于上限时追加标注；章节优先分帖下追加覆盖章节
        const tdSig = document.createElement('td');
        if (name === '正面') {
          const parts = [];
          if (sig.actualSheetCount !== r.input.sheetsPerSignature) parts.push(`${sig.actualSheetCount} 张`);
          if (sigChaptersText(sig)) parts.push(sigChaptersText(sig));
          tdSig.textContent = `${sig.index}${parts.length ? `（${parts.join(' · ')}）` : ''}`;
        } else {
          tdSig.textContent = '';
        }
        tr.appendChild(tdSig);
        [String(sheet.index), name].forEach((t) => {
          const td = document.createElement('td');
          td.textContent = t;
          tr.appendChild(td);
        });
        [side.left, side.right].forEach((slot) => {
          const td = document.createElement('td');
          const main = document.createElement('div');
          main.textContent = slotText(slot);
          if (slot.blank) main.className = 'slot-blank';
          td.appendChild(main);
          const off = document.createElement('div');
          off.className = 'slot-offset' + (creepOn && slot.offsetMm !== 0 ? ' nonzero' : '');
          off.textContent = `偏移 ${slot.offsetMm > 0 ? '+' : ''}${formatMm(slot.offsetMm)} mm`;
          td.appendChild(off);
          if (fitOn && slot.fit) {
            const fitDiv = document.createElement('div');
            if (slot.fit.ok) {
              fitDiv.className = 'slot-fit ok';
              fitDiv.textContent = '✓ 适配';
            } else {
              const vs = slot.fit.violations;
              fitDiv.className = 'slot-fit fail';
              fitDiv.textContent = `⚠ ${vs[0].message}${vs.length > 1 ? `（共 ${vs.length} 项）` : ''}`;
              fitDiv.title = vs.map((v) => v.message).join('\n');
              td.classList.add('fit-fail');
            }
            td.appendChild(fitDiv);
          }
          if (slot.blank) td.classList.add('blank');
          tr.appendChild(td);
        });
        const tdNote = document.createElement('td');
        tdNote.textContent = `${note}；${creepNote}`;
        tr.appendChild(tdNote);
        tableBody.appendChild(tr);
      });
    });
  });
}

/* ------------------------------ Canvas 绘制 ------------------------------ */

function setupCanvas(height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS_W * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  const r = state.result;
  if (!r) return;
  const pos = state.flat[state.idx];
  const sig = r.signatures[pos.si];
  const sheet = sig.sheets[pos.shi];
  const { flip, binding } = r.input;
  const fitOn = r.fit && r.fit.enabled;

  // 当前张全部超限原因（用于底部说明，并据此加高画布）
  const violations = [];
  if (fitOn) {
    [
      ['正面', sheet.front],
      ['背面', sheet.back],
    ].forEach(([sideName, side]) => {
      [
        ['左', side.left],
        ['右', side.right],
      ].forEach(([posName, slot]) => {
        if (slot.fit && !slot.fit.ok) {
          slot.fit.violations.forEach((v) => violations.push(`${sideName}${posName}页位（${slotText(slot)}）：${v.message}`));
        }
      });
    });
  }
  const noteLines = buildNotes(r.input, r.creep, fitOn ? r.fit : null, violations);
  const canvasH = Math.max(CANVAS_H, 540 + noteLines.length * 25 + 16);
  const ctx = setupCanvas(canvasH);

  // 背景
  ctx.fillStyle = '#f4f6fa';
  ctx.fillRect(0, 0, CANVAS_W, canvasH);

  // 标题区
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 22px system-ui, sans-serif';
  const chapterMode = r.chapters && r.chapters.enabled;
  const sigRangeText = chapterMode
    ? `真实页码 ${sig.pageStart}–${sig.pageEnd} · ${sigChaptersText(sig)}${sig.blankPages > 0 ? ` · 本帖补白 ${sig.blankPages} 页` : ''}`
    : `页码 ${sig.pageStart}–${sig.pageEnd}`;
  ctx.fillText(
    `第 ${sig.index} / ${r.signatureCount} 帖 · 第 ${sheet.index} / ${sig.sheets.length} 张（本帖实际 ${sig.actualSheetCount} 张 · ${sigRangeText}）`,
    40, 44
  );
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = '#5a6b85';
  const sigCreepArr = sig.sheetCompensationMm || r.creep.sheetCompensationMm;
  const creepSubtitle = r.creep.enabled
    ? `　爬移补偿：纸厚 ${formatMm(r.input.paperThickness)} mm · 上限 ${formatMm(r.input.maxCompensation)} mm · 本张补偿 ${formatMm(sigCreepArr[sheet.index - 1])} mm`
    : '　爬移补偿未启用';
  const modeSubtitle = chapterMode
    ? `　章节优先分帖（共 ${r.chapters.count} 章 · 拆分 ${r.chapters.splitCount} 次 · 起始页 [${r.chapters.starts.join(', ')}]）`
    : r.balanced && r.balanced.enabled
      ? `　均衡分帖（各帖实际张数差 ≤ 1）${r.balanced.savedBlankPages > 0 ? ` · 较固定分帖节省 ${r.balanced.savedBlankPages} 个空白页` : ''}`
      : '　固定分帖';
  ctx.fillText(
    `装订：${BINDING_TEXT[binding]}　双面翻转：${FLIP_TEXT[flip]}　成品 ${r.input.totalPages} 页 · 补白 ${r.blankPages} 页 · 共 ${r.paddedPages} 页${creepSubtitle}${modeSubtitle}`,
    40, 70
  );
  if (fitOn) {
    ctx.font = 'bold 14px system-ui, sans-serif';
    if (r.fit.ok) {
      ctx.fillStyle = '#1e7e34';
      ctx.fillText(
        `✓ 适配检查通过：纸张 ${formatMm(r.fit.paperWidth)}×${formatMm(r.fit.paperHeight)} mm，全部 ${r.fit.totalSlots} 个页位适配`,
        40, 94
      );
    } else {
      ctx.fillStyle = '#c92a2a';
      ctx.fillText(
        `✗ 适配检查未通过：${r.fit.failCount} / ${r.fit.totalSlots} 个页位超限（本张 ${violations.length} 项），详见下方说明与清单`,
        40, 94
      );
    }
  }

  const sheetW = 460;
  const sheetH = 340;
  const top = 136;
  const frontRect = { x: 70, y: top, w: sheetW, h: sheetH };
  const backRect = { x: 710, y: top, w: sheetW, h: sheetH };

  // 面板标题
  ctx.textAlign = 'center';
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillText('正面（第 1 面）', frontRect.x + sheetW / 2, top - 16);
  ctx.fillText(
    flip === 'long' ? '背面（第 2 面 · 内容旋转 180°）' : '背面（第 2 面）',
    backRect.x + sheetW / 2, top - 16
  );

  // 爬移像素比例：示意性放大，保证最大补偿量在页位内至少留 18px 边距且不超过页位宽 35%。
  // 均衡分帖下各帖按实际层数独立计算，故取所有帖补偿量的最大值。
  const perSigCreep = r.signatures.map((sg) => sg.sheetCompensationMm || r.creep.sheetCompensationMm);
  const allCreepVals = perSigCreep.flat();
  const maxCreepMm = r.creep.enabled && allCreepVals.length ? Math.max(...allCreepVals) : 0;
  const creepPxPerMm = maxCreepMm > 0
    ? Math.max(1, Math.min(30, (sheetW / 2 * 0.35 - 18) / maxCreepMm))
    : 0;
  const drawOpts = { creepPxPerMm, creepEnabled: r.creep.enabled, fitEnabled: fitOn };

  drawSheet(ctx, frontRect, sheet.front, { rotated: false, isBack: false, ...drawOpts });
  drawSheet(ctx, backRect, sheet.back, { rotated: flip === 'long', isBack: true, ...drawOpts });
  drawHighlight(ctx, { frontRect, backRect, sig, sheet });
  drawFlipDiagram(ctx, { x: 530, y: top, w: 180, h: sheetH }, flip);
  drawNotes(ctx, noteLines);
}

/** 差异跳转高亮：在被核对页位上叠加红色醒目框与「核验差异」徽标。 */
function drawHighlight(ctx, { frontRect, backRect, sig, sheet }) {
  const hl = state.highlight;
  if (!hl || hl.signature !== sig.index || hl.sheet !== sheet.index) return;
  const rect = hl.side === 'front' ? frontRect : backRect;
  const x = hl.position === 'left' ? rect.x : rect.x + rect.w / 2;
  const slotRect = { x, y: rect.y, w: rect.w / 2, h: rect.h };
  ctx.save();
  ctx.fillStyle = 'rgba(224, 49, 49, 0.10)';
  ctx.fillRect(slotRect.x, slotRect.y, slotRect.w, slotRect.h);
  ctx.strokeStyle = '#e03131';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 7]);
  ctx.strokeRect(slotRect.x + 3, slotRect.y + 3, slotRect.w - 6, slotRect.h - 6);
  ctx.setLineDash([]);
  ctx.fillStyle = '#e03131';
  roundRect(ctx, slotRect.x + 10, slotRect.y + 10, 118, 26, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('核验差异页位', slotRect.x + 69, slotRect.y + 24);
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

/** 绘制一张纸的一面：纸面、裁切角线、左右页位、折线与骑马钉。 */
function drawSheet(ctx, rect, side, opts) {
  // 阴影 + 纸面
  ctx.save();
  ctx.fillStyle = 'rgba(15, 30, 60, 0.12)';
  roundRect(ctx, rect.x + 5, rect.y + 7, rect.w, rect.h, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#33415c';
  ctx.lineWidth = 1.6;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawCropMarks(ctx, rect);

  const midX = rect.x + rect.w / 2;
  drawSlot(ctx, { x: rect.x, y: rect.y, w: rect.w / 2, h: rect.h }, side.left, opts, '左');
  drawSlot(ctx, { x: midX, y: rect.y, w: rect.w / 2, h: rect.h }, side.right, opts, '右');

  // 折线（订口）与骑马钉
  ctx.save();
  ctx.strokeStyle = '#d6336c';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(midX, rect.y + 2);
  ctx.lineTo(midX, rect.y + rect.h - 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a94a6';
  [0.28, 0.72].forEach((t) => {
    const y = rect.y + rect.h * t;
    roundRect(ctx, midX - 2.5, y - 9, 5, 18, 2.5);
    ctx.fill();
  });
  ctx.fillStyle = '#d6336c';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('折线 · 订口（骑马钉）', midX, rect.y + rect.h + 20);
  ctx.restore();
}

/** 绘制一个页位：原始页位虚线框（爬移前）+ 补偿后实线框；页码 / 空白斜纹 / 页首方向 / 背面物理关系标注。 */
function drawSlot(ctx, rect, slot, opts, posName) {
  const pad = 10;
  const inner = { x: rect.x + pad, y: rect.y + pad, w: rect.w - pad * 2, h: rect.h - pad * 2 };

  // 爬移偏移（屏幕像素）：offsetMm 正 = 向右，负 = 向左
  let shiftPx = 0;
  if (opts.creepEnabled && slot.offsetMm) {
    shiftPx = slot.offsetMm * opts.creepPxPerMm;
    // 限制在页位内部，避免超出纸面
    const maxShift = rect.w - pad * 2 - 24;
    shiftPx = Math.max(-maxShift, Math.min(maxShift, shiftPx));
  }

  // 原始页位（爬移补偿前）：虚线框，仅在确有偏移时叠加显示
  if (shiftPx !== 0) {
    ctx.save();
    ctx.strokeStyle = '#b0691a';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 适配检查可视化：把页位可用矩形（mm）等比映射到页位内框，
  // 叠加成品页裁切框、出血框与安全区框（trim 坐标已含爬移偏移，故不随 shiftPx 平移）
  if (opts.fitEnabled && slot.fit) {
    const f = slot.fit;
    const sx = inner.w / f.rect.width;
    const sy = inner.h / f.rect.height;
    const map = (box) => ({
      x: inner.x + (box.x - f.rect.x) * sx,
      y: inner.y + (box.y - f.rect.y) * sy,
      w: Math.max(2, box.width * sx),
      h: Math.max(2, box.height * sy),
    });
    ctx.save();
    // 出血框：绿 = 落在纸张内，红 = 超出纸张
    const b = map(f.bleedBox);
    ctx.strokeStyle = f.ok ? '#2f9e44' : '#e03131';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    // 成品页裁切框
    const t = map(f.trim);
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    // 安全区框
    if (f.safeBox) {
      const s = map(f.safeBox);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // 不合格页位：红色圆徽标记
  if (opts.fitEnabled && slot.fit && !slot.fit.ok) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(rect.x + rect.w - 18, rect.y + 18, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#e03131';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', rect.x + rect.w - 18, rect.y + 19);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  // 补偿后的页位（整体平移 shiftPx 后按原样式绘制）
  ctx.save();
  ctx.translate(shiftPx, 0);

  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;

  ctx.strokeStyle = shiftPx !== 0 ? '#e8820c' : '#c4ccd9';
  ctx.lineWidth = shiftPx !== 0 ? 1.8 : 1;
  ctx.strokeRect(inner.x, inner.y, inner.w, inner.h);

  if (slot.blank) {
    // 空白页：灰色斜纹（补偿后位置）
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    ctx.strokeStyle = '#e3e8f0';
    for (let d = -inner.h; d < inner.w + inner.h; d += 12) {
      ctx.beginPath();
      ctx.moveTo(inner.x + d, inner.y);
      ctx.lineTo(inner.x + d + inner.h, inner.y + inner.h);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#9aa5b8';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('空白页', cx, cy);
    ctx.textBaseline = 'alphabetic';
  } else {
    ctx.save();
    if (opts.rotated) {
      // 长边翻转：背面内容旋转 180°（页首朝下）
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI);
      ctx.translate(-cx, -cy);
    }
    ctx.fillStyle = '#1d4ed8';
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(slot.page), cx, cy - 8);
    ctx.fillStyle = '#5a6b85';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(`第 ${slot.page} 页`, cx, cy + 30);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('▲ 页首', cx, inner.y + (shiftPx !== 0 ? 30 : 16));
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  // 爬移偏移量标注（补偿后框内顶部）
  if (shiftPx !== 0) {
    ctx.fillStyle = '#b0691a';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const sign = slot.offsetMm > 0 ? '+' : '';
    ctx.fillText(`爬移 ${sign}${formatMm(slot.offsetMm)} mm`, cx, inner.y + 14);
  }

  // 页位角标
  ctx.fillStyle = '#8a94a6';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = posName === '左' ? 'left' : 'right';
  ctx.fillText(`${posName}页位`, posName === '左' ? inner.x + 2 : inner.x + inner.w - 2, inner.y + inner.h - 6);

  // 背面页位：标注物理上位于哪一正面页之背（折叠后阅读顺序校验）
  if (opts.isBack && !slot.blank && slot.backOf != null) {
    ctx.fillStyle = '#0f766e';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`位于正面第 ${slot.backOf} 页之背`, cx, inner.y + inner.h - 22);
  }
  ctx.restore();
}

/** 裁切角线。 */
function drawCropMarks(ctx, rect) {
  const len = 14;
  const gap = 5;
  const corners = [
    [rect.x, rect.y, -1, -1],
    [rect.x + rect.w, rect.y, 1, -1],
    [rect.x, rect.y + rect.h, -1, 1],
    [rect.x + rect.w, rect.y + rect.h, 1, 1],
  ];
  ctx.save();
  ctx.strokeStyle = '#8a94a6';
  ctx.lineWidth = 1;
  corners.forEach(([x, y, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(x + sx * gap, y);
    ctx.lineTo(x + sx * (gap + len), y);
    ctx.moveTo(x, y + sy * gap);
    ctx.lineTo(x, y + sy * (gap + len));
    ctx.stroke();
  });
  ctx.restore();
}

function drawArrowHead(ctx, x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-9, -5);
  ctx.lineTo(-9, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 正背面之间的翻转示意图：翻转轴 + 弧形箭头 + 说明。 */
function drawFlipDiagram(ctx, zone, flip) {
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;

  ctx.save();
  // 正面 -> 背面 大箭头
  const ay = zone.y + 34;
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = '#2563eb';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(zone.x + 10, ay);
  ctx.lineTo(zone.x + zone.w - 20, ay);
  ctx.stroke();
  drawArrowHead(ctx, zone.x + zone.w - 10, ay, 0, '#2563eb');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('翻面印刷', cx, ay - 10);

  // 小纸张图标
  const iw = 84;
  const ih = 60;
  const ix = cx - iw / 2;
  const iy = cy - 46;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#33415c';
  ctx.lineWidth = 1.4;
  ctx.fillRect(ix, iy, iw, ih);
  ctx.strokeRect(ix, iy, iw, ih);

  const iconCy = iy + ih / 2;
  const radius = iw / 2 + 16;

  ctx.strokeStyle = '#d6336c';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  if (flip === 'short') {
    ctx.moveTo(cx, iy - 18);
    ctx.lineTo(cx, iy + ih + 18);
  } else {
    ctx.moveTo(ix - 18, iconCy);
    ctx.lineTo(ix + iw + 18, iconCy);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 弧形翻转箭头
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (flip === 'short') {
    // 绕垂直轴：上方弧形箭头（左 -> 右）
    const a0 = Math.PI * 1.18;
    const a1 = Math.PI * 1.82;
    ctx.arc(cx, iconCy, radius, a0, a1);
    ctx.stroke();
    drawArrowHead(
      ctx,
      cx + radius * Math.cos(a1),
      iconCy + radius * Math.sin(a1),
      a1 + Math.PI / 2,
      '#2563eb'
    );
  } else {
    // 绕水平轴：右侧弧形箭头（上 -> 下）
    const a0 = -Math.PI / 3;
    const a1 = Math.PI / 3;
    ctx.arc(cx, iconCy, radius, a0, a1);
    ctx.stroke();
    drawArrowHead(
      ctx,
      cx + radius * Math.cos(a1),
      iconCy + radius * Math.sin(a1),
      a1 + Math.PI / 2,
      '#2563eb'
    );
  }

  // 说明文字
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(FLIP_TEXT[flip], cx, iy + ih + 34);
  ctx.fillStyle = '#5a6b85';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(flip === 'short' ? '绕垂直短边翻转' : '绕水平长边翻转', cx, iy + ih + 54);
  ctx.fillText(flip === 'short' ? '背面左右页位互换' : '背面内容旋转 180°', cx, iy + ih + 72);
  ctx.restore();
}

/** 组装底部图例与规则说明行（含适配检查结果）。 */
function buildNotes(input, creep, fit, violations) {
  const lines = [
    { text: '图例：蓝色数字 = 成品页码；灰色斜纹 = 自动补齐的空白页；红色虚线 = 对折线（订口）；灰色小角线 = 裁切标记。' },
    {
      text: input.flip === 'long'
        ? '长边翻转：纸张绕水平长边翻转，背面左右页位与正面相同，背面内容旋转 180°（页首朝下）。'
        : '短边翻转：纸张绕垂直短边翻转，背面左右页位与正面互换，背面内容方向不变。',
    },
    {
      text: input.binding === 'left'
        ? '左装订：第 1 页位于正面右页位，书脊在左。'
        : '右装订：第 1 页位于正面左页位，书脊在右。',
    },
    { text: '背面每个页位标注了它物理上位于哪一正面页之背；沿折线对折并配帖装订后，页码首尾相接，阅读顺序连续。' },
  ];
  if (input.balancedSplit) {
    lines.push({
      text: '均衡分帖：以每帖张数为上限取最少帖数，整本所需纸张在各帖间均匀分配，各帖实际张数差不超过 1，各帖按自身页数连续编号，空白页只出现在末帖末尾；爬移补偿按各帖实际层数独立重算。',
      color: '#0b7285',
    });
  }
  if (input.chapterSplit) {
    lines.push({
      text: '章节优先分帖：在每帖张数上限与整数张约束下，按「章节被拆分次数最少 → 补白页总数最少 → 帖数最少 → 前帖优先装满」确定唯一方案；章节末尾允许插入帖内空白（灰色斜纹），后续真实页码保持连续并正确进入下一帖。',
      color: '#5f3dc4',
    });
  }
  if (creep && creep.enabled) {
    lines.push(
      {
        text: `爬移补偿：每帖由外向内第 i 张（i 从 0 起）补偿量 = min(i × ${formatMm(input.paperThickness)} mm × 2, ${formatMm(input.maxCompensation)} mm)；画布位移为示意性放大，非真实比例。`,
        color: '#b0691a',
      },
      {
        text: input.binding === 'left'
          ? '符号约定：左装订时左页位向外侧（+，向右）、右页位向外侧（−，向左）平移；橙色实线框为补偿后页位，橙色虚线框为原始页位。'
          : '符号约定：右装订时符号整体反转，右页位向外侧（+，向右）、左页位向外侧（−，向左）平移；橙色实线框为补偿后页位，橙色虚线框为原始页位。',
        color: '#b0691a',
      }
    );
  } else {
    lines.push({ text: '爬移补偿未启用（纸张厚度或最大补偿量为 0）：各页位 offsetMm 均为 0，仅显示原始拼版页位。', color: '#b0691a' });
  }
  if (fit && fit.enabled) {
    lines.push({
      text: `适配检查：纸张 ${formatMm(fit.paperWidth)}×${formatMm(fit.paperHeight)} mm · 页位 ${formatMm(fit.slotWidth)}×${formatMm(fit.slotHeight)} mm · 成品页 ${formatMm(fit.pageWidth)}×${formatMm(fit.pageHeight)} mm · 出血 ${formatMm(fit.bleedMm)} mm · 安全边距 ${formatMm(fit.safetyMm)} mm；蓝框 = 裁切线，绿/红虚框 = 出血范围（红 = 超出纸张），灰点框 = 安全区，红色圆徽 = 页位不适配。`,
    });
    if (violations.length === 0) {
      lines.push({ text: '✓ 本张全部页位适配通过。', color: '#1e7e34' });
    } else {
      violations.slice(0, 5).forEach((v) => lines.push({ text: `⚠ ${v}`, color: '#c92a2a' }));
      if (violations.length > 5) {
        lines.push({ text: `…其余 ${violations.length - 5} 项超限详见下方拼版清单。`, color: '#c92a2a' });
      }
    }
  }
  return lines;
}

/** 底部图例与规则说明。 */
function drawNotes(ctx, lines) {
  ctx.save();
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.fillStyle = line.color || '#5a6b85';
    ctx.fillText(`· ${line.text}`, 70, 540 + i * 25);
  });
  ctx.restore();
}
