/* tests/run.js — headless checks of the scheduler. Run: node tests/run.js
 *
 * app.js touches no DOM, so it loads as-is. Storage falls back to memory. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');

function loadApp() {
  var ctx = { console: console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), ctx);
  ctx.App.setRandom(function () { return 0.5; });   // no jitter
  return ctx.App;
}

function withPiece(fields, settings) {
  var A = loadApp();
  A.setState({
    settings: Object.assign({ demandDriven: true, balancedPlanning: true, performancePlanning: true }, settings || {}),
    composers: [{ id: 'c', canonicalName: 'Composer' }],
    pieces: [Object.assign({ id: 'p001', composerId: 'c', title: 'Piece', durationMin: 2, fragility: 1,
      practiceDifficulty: 1, state: 'established', intervalDays: 10, lastPlayed: '2026-03-01', nextDue: '2026-03-11' }, fields || {})]
  });
  return { A: A, p: A.pieceById('p001') };
}

var tests = [], failed = 0;
function test(name, fn) { tests.push([name, fn]); }

test('clean on the due date grows by the multiplier', function () {
  var t = withPiece();
  t.A.applyGrade(t.p, 'clean', '2026-03-11');
  assert.strictEqual(t.p.intervalDays, 14);
  assert.strictEqual(t.p.nextDue, '2026-03-25');
});

test('clean one day early keeps most of the step', function () {
  var t = withPiece();
  t.A.applyGrade(t.p, 'clean', '2026-03-10');           // 9 of 10 days
  assert.strictEqual(t.p.intervalDays, 13);
});

test('clean replay soon after the last review earns nothing', function () {
  var t = withPiece();
  t.A.applyGrade(t.p, 'clean', '2026-03-03');           // 2 of 10 days
  assert.strictEqual(t.p.intervalDays, 10);
  assert.strictEqual(t.p.nextDue, '2026-03-13');
});

test('clean after a longer gap is credited half the overrun', function () {
  var t = withPiece({ intervalDays: 6, nextDue: '2026-03-07' });
  t.A.applyGrade(t.p, 'clean', '2026-03-11');           // 10 days against 6
  assert.strictEqual(t.p.intervalDays, 11);             // (6 + 2) x 1.4
});

test('late credit never exceeds the cap', function () {
  var t = withPiece({ fragility: 5 });                  // cap 8
  t.p.intervalDays = 8;
  t.A.applyGrade(t.p, 'clean', '2026-04-20');
  assert.strictEqual(t.p.intervalDays, 8);
});

test('an interval of one still climbs', function () {
  var t = withPiece({ intervalDays: 1, nextDue: '2026-03-02' });
  t.A.applyGrade(t.p, 'clean', '2026-03-02');
  assert.strictEqual(t.p.intervalDays, 2);
});

test('one memory wobble holds; a second running shortens', function () {
  var t = withPiece({ intervalDays: 16, nextDue: '2026-03-17' });
  t.A.applyGrade(t.p, 'wobbled', '2026-03-17');
  assert.strictEqual(t.p.intervalDays, 16);
  t.A.applyGrade(t.p, 'wobbled', '2026-04-02');
  assert.strictEqual(t.p.intervalDays, 12);
  assert.strictEqual(t.p.state, 'established');
  assert.strictEqual(t.p.nextDue, '2026-04-14');
});

test('a second wobble long after the due date holds the interval', function () {
  var t = withPiece({ intervalDays: 12, nextDue: '2026-03-13' });
  t.A.applyGrade(t.p, 'wobbled', '2026-03-13');
  t.A.applyGrade(t.p, 'wobbled', '2026-04-14');         // 32 days against 12
  assert.strictEqual(t.p.intervalDays, 12);
});

test('a technical slip between two wobbles does not hide them', function () {
  var t = withPiece({ intervalDays: 8, nextDue: '2026-03-09' });
  t.A.applyGrade(t.p, 'wobbled', '2026-03-09');
  t.A.applyGrade(t.p, 'wobbled', '2026-03-17', 'technical-slip');
  assert.strictEqual(t.p.intervalDays, 8);
  t.A.applyGrade(t.p, 'wobbled', '2026-03-25');
  assert.strictEqual(t.p.intervalDays, 6);
});

test('a clean between two wobbles resets the count', function () {
  var t = withPiece({ fragility: 3, intervalDays: 14, nextDue: '2026-03-15' });   // at its cap
  t.A.applyGrade(t.p, 'wobbled', '2026-03-15');
  t.A.applyGrade(t.p, 'clean', '2026-03-29');
  t.A.applyGrade(t.p, 'wobbled', '2026-04-12');
  assert.strictEqual(t.p.intervalDays, 14);
});

test('breaking down still goes to repair', function () {
  var t = withPiece();
  var ch = t.A.applyGrade(t.p, 'broke', '2026-03-11');
  assert.strictEqual(ch.enteredRepair, true);
  assert.strictEqual(t.p.intervalDays, 1);
});

test('two slips running are flagged, one is not', function () {
  var t = withPiece();
  t.A.applyGrade(t.p, 'wobbled', '2026-03-11', 'technical-slip');
  assert.strictEqual(t.A.repeatedSlip(t.p), false);
  t.A.applyGrade(t.p, 'wobbled', '2026-03-21', 'technical-slip');
  assert.strictEqual(t.A.repeatedSlip(t.p), true);
});

test('a longer maximum is offered despite jitter and early balancing', function () {
  var t = withPiece({ fragility: 3, intervalDays: 13, lastPlayed: '2026-01-01', nextDue: '2026-01-14' });   // cap 14
  var day = '2026-01-01';
  [13, 12, 14, 13, 12, 14].forEach(function (gap, i) {
    day = t.A.addDays(day, gap);
    t.p.intervalDays = [13, 14, 13, 14, 13, 14][i];
    t.p.nextDue = day;
    t.A.applyGrade(t.p, 'clean', day);
  });
  var s = t.A.intervalSuggestion(t.p, day);
  assert.ok(s, 'six secure checks near the cap earn a suggestion');
  assert.strictEqual(s.from, 14);
  assert.strictEqual(s.to, 17);
});

test('a short check does not count towards a longer maximum', function () {
  var t = withPiece({ fragility: 3, intervalDays: 14, lastPlayed: '2026-01-01', nextDue: '2026-01-15' });
  var day = '2026-01-01';
  [14, 14, 14, 14, 14, 6].forEach(function (gap) {
    day = t.A.addDays(day, gap); t.p.intervalDays = 14; t.p.nextDue = t.A.addDays(day, gap < 14 ? 8 : 0);
    t.A.applyGrade(t.p, 'clean', day);
  });
  assert.strictEqual(t.A.intervalSuggestion(t.p, day), null);
});

test('a harder consolidating piece is offered a longer gap after three clean checks', function () {
  var t = withPiece({ state: 'consolidating', practiceDifficulty: 4, fragility: 4, consolidatingIntervalDays: 1,
    intervalDays: 1, stateSince: '2026-03-01', nextDue: '2026-03-02' });
  ['2026-03-02', '2026-03-03'].forEach(function (d) { t.A.applyGrade(t.p, 'clean', d); });
  assert.strictEqual(t.A.cadenceSuggestion(t.p, '2026-03-03'), null);
  t.A.applyGrade(t.p, 'wobbled', '2026-03-04', 'technical-slip');     // neutral
  t.A.applyGrade(t.p, 'clean', '2026-03-05');
  var s = t.A.cadenceSuggestion(t.p, '2026-03-05');
  assert.ok(s); assert.strictEqual(s.to, 2);
  var list = t.A.practiceSuggestions('2026-03-05').filter(function (x) { return x.type === 'cadence'; });
  assert.strictEqual(list.length, 1);
  t.A.respondToSuggestion('p001', null, list[0].key, true, '2026-03-05');
  assert.strictEqual(t.p.consolidatingIntervalDays, 2);
  assert.strictEqual(t.p.nextDue, '2026-03-07');
  assert.strictEqual(t.A.cadenceSuggestion(t.p, '2026-03-05'), null);  // evidence starts again
});

test('a memory wobble restarts the cadence evidence', function () {
  var t = withPiece({ state: 'consolidating', practiceDifficulty: 4, fragility: 4, consolidatingIntervalDays: 1,
    intervalDays: 1, stateSince: '2026-03-01', nextDue: '2026-03-02' });
  t.A.applyGrade(t.p, 'clean', '2026-03-02'); t.A.applyGrade(t.p, 'clean', '2026-03-03');
  t.A.applyGrade(t.p, 'wobbled', '2026-03-04'); t.A.applyGrade(t.p, 'clean', '2026-03-05');
  assert.strictEqual(t.A.cadenceSuggestion(t.p, '2026-03-05'), null);
});

test('promotion keeps the gap consolidation reached', function () {
  var t = withPiece({ state: 'consolidating', consolidatingIntervalDays: 5, intervalDays: 5,
    lastPlayed: '2026-03-10', nextDue: '2026-03-15', stateSince: '2026-02-20' });
  t.A.promote('p001', '2026-03-12');
  assert.strictEqual(t.p.state, 'established');
  assert.strictEqual(t.p.intervalDays, 5);
  assert.strictEqual(t.p.nextDue, '2026-03-15');
});

test('promotion from a short cadence starts at three days, never in the past', function () {
  var t = withPiece({ state: 'consolidating', consolidatingIntervalDays: 1, intervalDays: 1,
    lastPlayed: '2026-03-01', nextDue: '2026-03-02', stateSince: '2026-02-20' });
  t.A.promote('p001', '2026-03-12');
  assert.strictEqual(t.p.intervalDays, 3);
  assert.strictEqual(t.p.nextDue, '2026-03-12');
});

test('retention removes detail, never grades, notes or minutes', function () {
  var t = withPiece(), A = t.A, s = A.state();
  for (var i = 0; i < 40; i++) {
    var d = A.addDays('2026-01-01', i * 10);
    t.p.history.push({ date: d, type: 'maintenance', grade: i % 7 ? 'clean' : 'wobbled', issue: 'memory', note: 'n' + i,
      elapsedDays: 10, intervalBefore: 10, logBefore: { state: 'established' }, logAfter: '{}', logConfig: '[]', timingId: 't' + i });
    s.practiceTimes.push({ id: 't' + i, date: d, pieceId: 'p001', sectionId: null, purpose: 'maintenance', minutes: 3,
      manualStart: true, finished: true });
    s.sessionArchive.push({ id: 's' + i, date: d, plan: [{ pieceId: 'p001', kind: 'maintenance', estMin: 3 }], results: [{ grade: 'clean' }],
      warmup: { scale: 'C major', status: 'done', date: d, minutes: 2 }, finished: true });
  }
  A.setState(JSON.parse(JSON.stringify(s)));
  s = A.state(); var p = A.pieceById('p001'), today = '2027-03-01';
  var before = p.history.map(function (h) { return [h.date, h.grade, h.note].join(); }).join(';');
  assert.strictEqual(A.compactStorage(today), true);
  assert.strictEqual(p.history.map(function (h) { return [h.date, h.grade, h.note].join(); }).join(';'), before);
  assert.ok(p.history.every(function (h) { return h.date >= A.addDays(today, -30) || !h.logBefore; }));
  assert.ok(s.sessionArchive.every(function (x) { return x.date >= A.addDays(today, -14) || x.plan.length === 0; }));
  assert.ok(s.sessionArchive.every(function (x) { return x.date >= A.addDays(today, -400); }));
  var total = s.practiceTimes.reduce(function (n, x) { return n + x.minutes; }, 0) +
    Object.keys(s.practiceTotals).reduce(function (n, k) { return n + s.practiceTotals[k]; }, 0);
  assert.strictEqual(total, 120);
  assert.strictEqual(A.timingSummary('p001', null, 'maintenance').sessions, 8);
  assert.strictEqual(A.minutesOn('2026-01-01'), 3);
  assert.strictEqual(A.compactStorage(today), false);
  var again = A.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(JSON.stringify(again.practiceTotals), JSON.stringify(s.practiceTotals));
});

test('the week plan is reused until state changes, then rebuilt', function () {
  var t = withPiece({ nextDue: '2026-03-11' }), A = t.A;
  var first = A.weekPlan('2026-03-09', 7, false);
  assert.strictEqual(first.filter(function (d) { return d.items.length; }).length, 1);
  first[0].items.push({ junk: true });                          // callers cannot poison the cache
  assert.strictEqual(JSON.stringify(A.weekPlan('2026-03-09', 7, false)[0].items), '[]');
  A.updatePiece('p001', { nextDue: '2026-03-09' }, '2026-03-09');
  assert.strictEqual(A.weekPlan('2026-03-09', 7, false)[0].items.length, 1);
});

test('learn-next follows tiers, then uncovered composers, then what is closest to ready', function () {
  var A = loadApp();
  A.setState({ settings: { maxLearning: 2, learningEnabled: true },
    composers: [{ id: 'a', canonicalName: 'A' }, { id: 'b', canonicalName: 'B' }],
    pieces: [
      { id: 'p001', composerId: 'a', title: 'Known composer', tier: 0, state: 'backlog', priorKnowledge: 'near' },
      { id: 'p002', composerId: 'b', title: 'New composer, new piece', tier: 0, state: 'backlog', priorKnowledge: 'new' },
      { id: 'p003', composerId: 'b', title: 'Lower tier', tier: 1, state: 'backlog', priorKnowledge: 'near' },
      { id: 'p004', composerId: 'a', title: 'Established', tier: 0, state: 'established', intervalDays: 5 },
      { id: 'p005', composerId: 'a', title: 'Learning', tier: 0, state: 'learning' }] });
  var n = A.learnNext();
  assert.strictEqual(n.free, 1);
  assert.strictEqual(n.piece.id, 'p002');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(A.coverage())), { ready: 1, composers: 1, totalComposers: 2 });
  A.updateSettings({ learnPromptDismissed: n.key });
  assert.strictEqual(A.learnNext().dismissed, true);
  A.startLearning('p002');                                   // slots full
  assert.strictEqual(A.learnNext(), null);
  A.updateSettings({ maxLearning: 3 });                      // a different number learning: ask again
  assert.strictEqual(A.learnNext().dismissed, false);
  A.updateSettings({ learningEnabled: false });
  assert.strictEqual(A.learnNext(), null);
});

test('the UI only calls functions the app exports', function () {
  var A = loadApp(), ui = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8'), missing = {};
  ui.replace(/\bA\.([A-Za-z_]+)/g, function (_, name) { if (!(name in A)) missing[name] = true; });
  assert.deepStrictEqual(Object.keys(missing), []);
});

tests.forEach(function (t) {
  try { t[1](); console.log('ok   ' + t[0]); }
  catch (e) { failed++; console.log('FAIL ' + t[0] + '\n     ' + String(e.message).split('\n').join('\n     ')); }
});
console.log('\n' + (tests.length - failed) + ' of ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
