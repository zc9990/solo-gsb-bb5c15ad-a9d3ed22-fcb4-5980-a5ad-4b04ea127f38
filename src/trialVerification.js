'use strict';

/**
 * 试印核验（trial print verification）。
 *
 * 用户拿到试印实物后，可在当前拼版结果上录入 1 ~ 12 条实物观察，每条观察指明：
 *   帖（signature，1 起）、张（sheet，帖内 1 起）、正 / 背面（side）、
 *   左 / 右页位（position）、看到的是页码还是空白（blank / page）、
 *   以及内容朝向（orientation：页首朝上 up / 朝下 down）。
 *
 * 服务端用同一份输入（成品页数、每帖张数、分帖模式、爬移 / 适配参数等）
 * 分别重算「左 / 右装订 × 长 / 短边翻转」四种组合，逐条比对每个页位的
 *   - blank       空白是否一致；
 *   - page        页码是否一致（仅观察报告了页码时参与比对：
 *                 实物为指定页码而拼版为空白，或页码不同均计不符）；
 *   - orientation 内容朝向是否一致（正面一律朝上；背面长边翻转朝下、短边翻转朝上）。
 *
 * 候选组合排序（证据优先，固定次序仅用于展示，绝不能把并列证据改写成唯一结论）：
 *   1. 错误观察数（含 ≥1 个不符字段的观察条数）最少；
 *   2. 错误字段数（所有观察不符字段总数）最少；
 *   3. 当前设置优先；
 *   4. 固定组合顺序：left/long → left/short → right/long → right/short。
 *
 * 结论：
 *   - verified     ：唯一零差异组合（zeroDifference 仅它一个），标记核验通过；
 *                    该组合不等于当前设置时 matchesCurrent=false，由调用方提示改设置；
 *   - inconclusive ：最优成绩（错误观察数 + 错误字段数）并列，返回无法判定及全部并列组合，
 *                    不做任何推荐；
 *   - mismatch     ：唯一最优但仍有差异，四种组合均不能零差异，不能标记通过。
 */

const MAX_OBSERVATIONS = 12;

/** 四种装订 / 翻转组合的固定排列顺序（order 即展示与兜底排序用的序号）。 */
const TRIAL_COMBOS = [
  { binding: 'left', flip: 'long', order: 0 },
  { binding: 'left', flip: 'short', order: 1 },
  { binding: 'right', flip: 'long', order: 2 },
  { binding: 'right', flip: 'short', order: 3 },
];

const SIDE_NAMES = { front: '正面', back: '背面' };
const POSITION_NAMES = { left: '左页位', right: '右页位' };
const BINDING_NAMES = { left: '左装订', right: '右装订' };
const FLIP_NAMES = { long: '长边翻转', short: '短边翻转' };
const ORIENTATION_NAMES = { up: '页首朝上', down: '页首朝下' };

/** 组合的可读名称，如「左装订 · 短边翻转」。 */
function comboName(combo) {
  return `${BINDING_NAMES[combo.binding]} · ${FLIP_NAMES[combo.flip]}`;
}

/** 观察位置的可读名称，如「第 1 帖第 2 张背面左页位」。 */
function locationName(loc) {
  return `第 ${loc.signature} 帖第 ${loc.sheet} 张${SIDE_NAMES[loc.side]}${POSITION_NAMES[loc.position]}`;
}

/**
 * 解析整数：接受数字或纯数字字符串；null / 布尔 / 空串 / 其他类型一律非法。
 */
function toObsInt(value, label) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  } else {
    throw new Error(`${label}必须为整数`);
  }
  if (!Number.isInteger(n)) {
    throw new Error(`${label}必须为整数（收到非法值：${value}）`);
  }
  return n;
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(allowed, value)) {
    throw new Error(`${label}必须为 ${Object.keys(allowed).map((k) => `'${k}'`).join(' / ')} 之一（收到：${value}）`);
  }
  return value;
}

/**
 * 校验并规范化试印观察。
 *
 * @param {Array} raw 输入的 observations 数组（调用方保证非空数组）
 * @param {object} result 当前拼版结果（用于校验帖 / 张索引范围；四种组合的帖张结构完全相同）
 * @returns {Array<object>} 规范化后的观察（{ signature, sheet, side, position, blank, page, orientation }）
 */
function normalizeObservations(raw, result) {
  if (raw.length > MAX_OBSERVATIONS) {
    throw new Error(`试印观察最多 ${MAX_OBSERVATIONS} 条（收到 ${raw.length} 条）`);
  }
  const seen = new Set();
  return raw.map((item, idx) => {
    const where = `第 ${idx + 1} 条观察`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where}必须为观察对象`);
    }
    const signature = toObsInt(item.signature, `${where}的帖号`);
    if (signature < 1 || signature > result.signatures.length) {
      throw new Error(`${where}的帖号 ${signature} 超出范围（1 ~ ${result.signatures.length}）`);
    }
    const sig = result.signatures[signature - 1];
    const sheet = toObsInt(item.sheet, `${where}的张号`);
    if (sheet < 1 || sheet > sig.sheets.length) {
      throw new Error(`${where}的张号 ${sheet} 超出第 ${signature} 帖范围（1 ~ ${sig.sheets.length}）`);
    }
    const side = enumValue(item.side, SIDE_NAMES, `${where}的正 / 背面`);
    const position = enumValue(item.position, POSITION_NAMES, `${where}的左 / 右页位`);
    if (typeof item.blank !== 'boolean') {
      throw new Error(`${where}（${locationName({ signature, sheet, side, position })}）的 blank 必须为布尔值（true = 看到空白）`);
    }
    let page = null;
    if (item.blank) {
      if (item.page !== undefined && item.page !== null) {
        throw new Error(`${where}（${locationName({ signature, sheet, side, position })}）已标记为空白，不应再填写页码`);
      }
    } else {
      page = toObsInt(item.page, `${where}（${locationName({ signature, sheet, side, position })}）看到的页码`);
      if (page < 1 || page > result.input.totalPages) {
        throw new Error(`${where}看到的页码 ${page} 超出成品页数范围（1 ~ ${result.input.totalPages}）`);
      }
    }
    const orientation = enumValue(item.orientation, ORIENTATION_NAMES, `${where}的内容朝向`);

    const key = `${signature}:${sheet}:${side}:${position}`;
    if (seen.has(key)) {
      throw new Error(`重复观察：${locationName({ signature, sheet, side, position })} 已存在一条观察，同一页位只能录入一次`);
    }
    seen.add(key);

    return { signature, sheet, side, position, blank: item.blank, page, orientation };
  });
}

/**
 * 取某候选拼版结果在指定观察位置上的页位。
 */
function slotAt(result, obs) {
  return result.signatures[obs.signature - 1].sheets[obs.sheet - 1][obs.side][obs.position];
}

/**
 * 该页位在给定组合下的内容朝向：正面一律朝上；背面长边翻转 180°（朝下），短边翻转朝上。
 * 与装订方向无关（与 fitCheck 的 rotation 规则一致，但不依赖适配检查是否启用）。
 */
function expectedOrientation(side, flip) {
  return side === 'back' && flip === 'long' ? 'down' : 'up';
}

/**
 * 对一种候选组合逐条打分。
 */
function scoreCandidate(observations, candidate, combo) {
  const observationResults = observations.map((obs) => {
    const slot = slotAt(candidate, obs);
    const expected = {
      blank: slot.blank,
      page: slot.blank ? null : slot.page,
      orientation: expectedOrientation(obs.side, combo.flip),
    };
    const observed = { blank: obs.blank, page: obs.page, orientation: obs.orientation };
    const mismatches = [];
    if (observed.blank !== expected.blank) {
      mismatches.push('blank');
    }
    // 仅当实物观察报告了具体页码时比对页码：拼版为空白或页码不同均计不符
    if (!observed.blank && (expected.blank || expected.page !== observed.page)) {
      mismatches.push('page');
    }
    if (observed.orientation !== expected.orientation) {
      mismatches.push('orientation');
    }
    return {
      location: {
        signature: obs.signature,
        sheet: obs.sheet,
        side: obs.side,
        position: obs.position,
      },
      observed,
      expected,
      mismatches,
      match: mismatches.length === 0,
    };
  });
  const wrongObservations = observationResults.filter((r) => !r.match).length;
  const wrongFields = observationResults.reduce((sum, r) => sum + r.mismatches.length, 0);
  return {
    binding: combo.binding,
    flip: combo.flip,
    order: combo.order,
    current: false,
    rank: 0,
    zeroDifference: wrongObservations === 0,
    wrongObservations,
    wrongFields,
    observations: observationResults,
  };
}

/**
 * 执行完整试印核验：规范化观察 → 重算四种组合 → 打分排序 → 给出结论。
 *
 * @param {object} input      原始请求参数（含 observations）
 * @param {object} baseResult 当前设置下的拼版结果
 * @param {Function} recompute 拼版计算函数 computeImposition（注入以避免循环依赖）
 * @returns {object} 顶层 trialVerification 结果
 */
function buildTrialVerification(input, baseResult, recompute) {
  if (!Array.isArray(input.observations)) {
    throw new Error('试印观察 observations 必须为数组');
  }
  const observations = normalizeObservations(input.observations, baseResult);
  const current = { binding: baseResult.input.binding, flip: baseResult.input.flip };

  // 四种组合用同一份输入重算；当前组合直接复用已算好的结果（重算时剥除 observations 防递归）。
  const candidates = TRIAL_COMBOS.map((combo) => {
    const isCurrent = combo.binding === current.binding && combo.flip === current.flip;
    const candidateResult = isCurrent
      ? baseResult
      : recompute({ ...input, binding: combo.binding, flip: combo.flip, observations: undefined });
    const scored = scoreCandidate(observations, candidateResult, combo);
    scored.current = isCurrent;
    return scored;
  });

  // 排序：错误观察数 → 错误字段数 → 当前设置优先 → 固定组合顺序
  candidates.sort((a, b) => (
    a.wrongObservations - b.wrongObservations ||
    a.wrongFields - b.wrongFields ||
    (a.current === b.current ? 0 : a.current ? -1 : 1) ||
    a.order - b.order
  ));
  candidates.forEach((c, i) => {
    c.rank = i + 1;
  });

  // 并列最优只按证据（错误观察数 + 错误字段数）判定，当前优先 / 固定顺序仅影响展示
  const best = candidates[0];
  const tied = candidates.filter(
    (c) => c.wrongObservations === best.wrongObservations && c.wrongFields === best.wrongFields
  );

  let conclusion;
  if (tied.length > 1) {
    conclusion = {
      status: 'inconclusive',
      message:
        `无法判定：${tied.length} 个组合并列最优（均为 ${best.wrongObservations} 条错误观察、` +
        `${best.wrongFields} 个错误字段）：${tied.map(comboName).join('、')}。` +
        '请增加实物观察后重试，系统不会在并列时强行推荐。',
      matchesCurrent: tied.some((c) => c.current),
      winner: null,
      tied: tied.map((c) => ({ binding: c.binding, flip: c.flip })),
    };
  } else if (best.wrongObservations === 0) {
    const winner = { binding: best.binding, flip: best.flip };
    conclusion = {
      status: 'verified',
      message: best.current
        ? `试印核验通过：${observations.length} 条实物观察与当前设置「${comboName(best)}」完全一致（页码、空白、朝向零差异）。`
        : `唯一零差异组合为「${comboName(best)}」，${observations.length} 条观察全部相符；但与当前设置「${comboName(current)}」不符，请核对设备的装订方向与双面翻转设置。`,
      matchesCurrent: best.current,
      winner,
      tied: [],
    };
  } else {
    conclusion = {
      status: 'mismatch',
      message:
        `四种装订 / 翻转组合均与观察存在差异，核验未通过；最接近的「${comboName(best)}」` +
        `仍有 ${best.wrongObservations} 条错误观察、${best.wrongFields} 个错误字段` +
        (best.current ? '（即当前设置）。' : '（当前设置并非最接近者）。') +
        '请核对实物与观察录入；该结果仅为评分事实，不构成设置推荐。',
      matchesCurrent: best.current,
      winner: { binding: best.binding, flip: best.flip },
      tied: [],
    };
  }

  return {
    enabled: true,
    observations,
    current,
    conclusion,
    candidates,
  };
}

module.exports = {
  MAX_OBSERVATIONS,
  TRIAL_COMBOS,
  normalizeObservations,
  buildTrialVerification,
  comboName,
  locationName,
};
