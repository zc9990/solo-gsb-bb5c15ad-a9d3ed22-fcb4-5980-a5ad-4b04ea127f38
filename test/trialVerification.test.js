'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

/*
 * 8 页、2 张/帖时第 1 张布局：
 *   left/short  front [8,1]  back [2,7](朝向 up)
 *   left/long   front [8,1]  back [7,2](朝向 down)
 *   right/short front [1,8]  back [7,2](朝向 up)
 *   right/long  front [1,8]  back [2,7](朝向 down)
 * 正面朝向恒为 up；背面 long -> down、short -> up。
 *
 * 10 页、2 张/帖（固定分帖）第 2 帖第 1 张：
 *   left/*  front [空白, 9]      right/* front [9, 空白]
 */

test('无观察时原流程兼容：trialVerification.enabled 为 false', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  assert.deepEqual(r.trialVerification, { enabled: false });
  const empty = computeImposition({
    totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', observations: [],
  });
  assert.deepEqual(empty.trialVerification, { enabled: false });
});

test('观察与当前设置（left/short）完全一致：唯一零差异，核验通过且 matchesCurrent', () => {
  const r = computeImposition({
    totalPages: 8,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'right', blank: false, page: 1, orientation: 'up' },
      { signature: 1, sheet: 1, side: 'back', position: 'left', blank: false, page: 2, orientation: 'up' },
    ],
  });
  const tv = r.trialVerification;
  assert.equal(tv.enabled, true);
  assert.equal(tv.conclusion.status, 'verified');
  assert.equal(tv.conclusion.matchesCurrent, true);
  assert.deepEqual(tv.conclusion.winner, { binding: 'left', flip: 'short' });
  assert.deepEqual(tv.conclusion.tied, []);
  const winner = tv.candidates.find((c) => c.binding === 'left' && c.flip === 'short');
  assert.equal(winner.zeroDifference, true);
  assert.equal(winner.rank, 1);
  assert.equal(winner.current, true);
  assert.equal(winner.wrongObservations, 0);
  assert.equal(winner.wrongFields, 0);
  winner.observations.forEach((o) => {
    assert.equal(o.match, true);
    assert.deepEqual(o.mismatches, []);
  });
  tv.candidates
    .filter((c) => !(c.binding === 'left' && c.flip === 'short'))
    .forEach((c) => assert.equal(c.zeroDifference, false));
});

test('并列零差异（right/long 与 right/short 证据相同）：inconclusive，返回并列组合且不推荐', () => {
  // 10 页书第 2 帖第 1 张正面右位：right/* 两组合均为空白，left/* 两组合均为第 9 页。
  // 单面观察无法区分 long/short（朝向只在背面有差异），故 right/long 与 right/short 并列零差异。
  const r = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'long',
    observations: [
      { signature: 2, sheet: 1, side: 'front', position: 'right', blank: true, orientation: 'up' },
    ],
  });
  const tv = r.trialVerification;
  assert.equal(tv.conclusion.status, 'inconclusive');
  assert.equal(tv.conclusion.winner, null);
  const tiedKeys = tv.conclusion.tied.map((c) => `${c.binding}/${c.flip}`).sort();
  assert.deepEqual(tiedKeys, ['right/long', 'right/short']);
  assert.equal(tv.conclusion.matchesCurrent, false);
  tv.candidates
    .filter((c) => tiedKeys.includes(`${c.binding}/${c.flip}`))
    .forEach((c) => assert.equal(c.zeroDifference, true));
  assert.ok(/无法判定/.test(tv.conclusion.message));
  assert.ok(/右装订/.test(tv.conclusion.message));
});

test('唯一零差异但不是当前设置：verified 且 matchesCurrent=false', () => {
  // 当前 left/long，实物按 left/short 印制（背面朝向 up，页位 [2,7]）
  const r = computeImposition({
    totalPages: 8,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'long',
    observations: [
      { signature: 1, sheet: 1, side: 'back', position: 'left', blank: false, page: 2, orientation: 'up' },
      { signature: 1, sheet: 1, side: 'back', position: 'right', blank: false, page: 7, orientation: 'up' },
    ],
  });
  const tv = r.trialVerification;
  assert.equal(tv.conclusion.status, 'verified');
  assert.equal(tv.conclusion.matchesCurrent, false);
  assert.deepEqual(tv.conclusion.winner, { binding: 'left', flip: 'short' });
});

test('唯一最优但有差异：mismatch，不标记通过', () => {
  const r = computeImposition({
    totalPages: 8,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [
      // front right 实物空白：四组合该处都是真实页码（left*=1、right*=8），
      // 每组合均 1 个字段错（观察为空白无页码字段，只记 blank），朝向一致。
      { signature: 1, sheet: 1, side: 'front', position: 'right', blank: true, orientation: 'up' },
      // back left 看到第 2 页且朝上：left/short 完全相符；left/long 页码与朝向俱错；
      // right/short 页码错；right/long 页码对但朝向错。
      { signature: 1, sheet: 1, side: 'back', position: 'left', blank: false, page: 2, orientation: 'up' },
    ],
  });
  const tv = r.trialVerification;
  assert.equal(tv.conclusion.status, 'mismatch');
  assert.deepEqual(tv.conclusion.winner, { binding: 'left', flip: 'short' });
  assert.equal(tv.conclusion.matchesCurrent, true);
  const winner = tv.candidates[0];
  assert.equal(winner.wrongObservations, 1);
  // 观察报告的是「空白」（无页码字段），故只记 blank 一项不符；朝向与正面期望一致
  assert.equal(winner.wrongFields, 1);
  assert.equal(winner.zeroDifference, false);
  assert.deepEqual(winner.observations[0].mismatches, ['blank']);
  tv.candidates.slice(1).forEach((c) => {
    assert.ok(c.wrongObservations > winner.wrongObservations);
  });
});

test('证据全并列时按「当前设置优先 → 固定组合顺序」排序，但结论仍是无法判定', () => {
  // 8 页观察 s1 front right 为空白：四组合该处都有页码，均 1 条错误观察、1 个错误字段。
  const obs = [{ signature: 1, sheet: 1, side: 'front', position: 'right', blank: true, orientation: 'up' }];
  const run = (binding, flip) => computeImposition(
    { totalPages: 8, sheetsPerSignature: 2, binding, flip, observations: obs },
  ).trialVerification;

  const currentLeftLong = run('left', 'long');
  assert.equal(currentLeftLong.conclusion.status, 'inconclusive');
  assert.equal(currentLeftLong.candidates[0].current, true);
  assert.deepEqual(
    currentLeftLong.conclusion.tied.map((c) => `${c.binding}/${c.flip}`),
    ['left/long', 'left/short', 'right/long', 'right/short'],
  );

  // 当前是 right/short 时，它因「当前优先」排到第 1，其余仍按固定顺序
  const currentRightShort = run('right', 'short');
  assert.deepEqual(
    currentRightShort.candidates.map((c) => `${c.binding}/${c.flip}`),
    ['right/short', 'left/long', 'left/short', 'right/long'],
  );
});

test('空白观察与朝向比对：加入非镜像观察后唯一零差异', () => {
  // 10 页：第 2 帖 s1 front left 空白（left/* 成立、right/* 不成立），
  // s2 back right 空白且朝上（short 成立、long 背面朝下），唯 left/short 零差异。
  const r = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: 2, sheet: 1, side: 'front', position: 'left', blank: true, orientation: 'up' },
      { signature: 2, sheet: 2, side: 'back', position: 'right', blank: true, orientation: 'up' },
    ],
  });
  const tv = r.trialVerification;
  assert.equal(tv.conclusion.status, 'verified');
  assert.deepEqual(tv.conclusion.winner, { binding: 'left', flip: 'short' });
  // left/long 在第二条背面观察上仅朝向不符
  const leftLong = tv.candidates.find((c) => c.binding === 'left' && c.flip === 'long');
  assert.equal(leftLong.wrongObservations, 1);
  assert.equal(leftLong.wrongFields, 1);
  assert.deepEqual(leftLong.observations[1].mismatches, ['orientation']);
});

test('非法索引 / 非法枚举 / 重复观察 / 越界页码返回明确错误', () => {
  const base = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
  const obs = (...arr) => computeImposition({ ...base, observations: arr });

  assert.throws(
    () => obs({ signature: 2, sheet: 1, side: 'front', position: 'left', blank: true, orientation: 'up' }),
    /帖号 2 超出范围/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 3, side: 'front', position: 'left', blank: true, orientation: 'up' }),
    /张号 3 超出第 1 帖范围/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'top', position: 'left', blank: true, orientation: 'up' }),
    /正 \/ 背面/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'front', position: 'middle', blank: true, orientation: 'up' }),
    /左 \/ 右页位/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'front', position: 'left', blank: true, orientation: 'sideways' }),
    /内容朝向/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'front', position: 'left', blank: false, page: 9, orientation: 'up' }),
    /页码 9 超出成品页数范围/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'front', position: 'left', blank: 'yes', orientation: 'up' }),
    /blank 必须为布尔值/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'front', position: 'left', blank: true, page: 3, orientation: 'up' }),
    /已标记为空白，不应再填写页码/,
  );
  assert.throws(
    () => obs({ signature: 1, sheet: 1, side: 'front', position: 'left', blank: false, orientation: 'up' }),
    /看到的页码必须为整数/,
  );

  const same = { signature: 1, sheet: 1, side: 'front', position: 'left', blank: false, page: 8, orientation: 'up' };
  assert.throws(() => obs(same, { ...same }), /重复观察/);

  assert.throws(() => computeImposition({ ...base, observations: {} }), /observations 必须为数组/);
  assert.throws(() => computeImposition({ ...base, observations: 'notarray' }), /observations 必须为数组/);

  const many = Array.from({ length: 13 }, () => ({
    signature: 1, sheet: 1, side: 'front', position: 'left', blank: true, orientation: 'up',
  }));
  assert.throws(() => computeImposition({ ...base, observations: many }), /最多 12 条/);
});

test('观察规范化：数字字符串可解析，规范化输出回填字段', () => {
  const r = computeImposition({
    totalPages: 8,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: '1', sheet: '1', side: 'front', position: 'right', blank: false, page: '1', orientation: 'up' },
    ],
  });
  assert.deepEqual(
    r.trialVerification.observations[0],
    { signature: 1, sheet: 1, side: 'front', position: 'right', blank: false, page: 1, orientation: 'up' },
  );
});

test('候选明细包含期望 / 实际值与差异字段，rank 连续且 order 覆盖固定顺序 0~3', () => {
  const r = computeImposition({
    totalPages: 8,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'right', blank: false, page: 8, orientation: 'up' },
    ],
  });
  const tv = r.trialVerification;
  const ls = tv.candidates.find((c) => c.binding === 'left' && c.flip === 'short');
  assert.deepEqual(ls.observations[0].observed, { blank: false, page: 8, orientation: 'up' });
  assert.deepEqual(ls.observations[0].expected, { blank: false, page: 1, orientation: 'up' });
  assert.deepEqual(ls.observations[0].mismatches, ['page']);
  assert.equal(ls.observations[0].match, false);
  assert.deepEqual(tv.candidates.map((c) => c.rank), [1, 2, 3, 4]);
  assert.deepEqual(tv.candidates.map((c) => c.order).sort((a, b) => a - b), [0, 1, 2, 3]);
});

test('核验在均衡 / 章节分帖下照常工作，候选结构与分帖模式无关', () => {
  const r = computeImposition({
    totalPages: 17,
    sheetsPerSignature: 2,
    balancedSplit: true,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'right', blank: false, page: 1, orientation: 'up' },
      // 追加背面朝向观察以区分长 / 短边翻转（均衡分帖第 1 帖为 8 页，布局同 8 页书）
      { signature: 1, sheet: 1, side: 'back', position: 'left', blank: false, page: 2, orientation: 'up' },
    ],
  });
  assert.equal(r.trialVerification.conclusion.status, 'verified');
  assert.equal(r.trialVerification.candidates.length, 4);
});
