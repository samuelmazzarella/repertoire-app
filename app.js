/* app.js — state, scheduler, session builder.
 *
 * No DOM access anywhere in this file. Everything here is drivable from sim.js
 * under jsc or node, and from ui.js in the browser.
 *
 * Every write to persistent state goes through save(). The state key is
 * written in exactly one place, inside save(); the only other setItem is a
 * one-byte availability probe that is removed immediately.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Tuning
   *
   * Every magic number the scheduler depends on lives here so it can be
   * changed in one place. cleanMultiplier and firstEstablishedInterval are
   * the two the brief flags as most likely to need it.
   * ------------------------------------------------------------------ */

  var TUNING = {
    // Interval arithmetic
    cleanMultiplier: 1.4,          // established + Clean -> interval x this
    firstEstablishedInterval: 3,   // interval on first entering established
    consolidatingIntervalDays: 3,  // fixed cadence while consolidating
    learningIntervalDays: 1,       // fixed cadence while learning

    // Repair
    repairSessionsToExit: 3,       // consecutive Clean/Wobbled to leave repair
    repairIntervalFactor: 0.5,     // resume at this share of pre-failure interval

    // Session costing
    maintenanceCostFactor: 1.3,    // one run plus spot repair
    learningSlotMin: 10,           // fixed slot per learning piece, any length

    // Desynchronisation
    intervalJitter: 0.10,          // +/- this share on each new interval

    // Packing
    overshootAllowance: 0.20,      // may exceed budget by this to rescue an item
    overdueRescueThreshold: 0.50,  // ...only if it is this far past due
    lookaheadDays: 7,              // how far ahead to pull work forward FROM —
                                   // only from days projected over budget
    forecastDays: 7,               // launch-card week-ahead projection

    // Recommendation
    recommendationCapFactor: 1.5,  // cap the *suggestion* at budget x this;
                                   // the uncapped ideal is always shown too
    recommendationRounding: 5,

    // Reporting
    gapThresholdDays: 2,           // budgeted days missed before the gap line shows
    promotionSuggestDays: 14,      // consolidating this long -> suggest promotion
    exportReminderDays: 14,
    capacityWindowDays: 30,        // rolling window for the observed figure
    capacityNudgeDays: 14,         // sustained overrun before the one nudge
    capacityObservedMinDays: 30,   // log must span this before observed supply
                                   // replaces configured budget
    capacityLogDays: 90            // how much daily log to retain
  };

  /* Interval caps by fragility. Validated against 18 months of real data —
   * do not change. Fractional fragility interpolates linearly between rows. */
  var CAPS = { 1: 20, 2: 16, 3: 14, 4: 11, 5: 8 };

  var STORAGE_KEY = 'repertoire.v1';
  var STATE_VERSION = 2;

  var STATES = ['backlog', 'learning', 'consolidating', 'established', 'repair'];
  var SCHEDULED_STATES = ['learning', 'consolidating', 'established', 'repair'];
  var MAINTENANCE_STATES = ['repair', 'consolidating', 'established'];
  var GRADES = ['clean', 'wobbled', 'broke'];

  /* Chopin Op. 28 playing times, minutes. Used for both durationMin and
   * contentMin — none of the preludes are repeat-heavy. */
  var CHOPIN_DURATIONS = {
    1: 0.6, 2: 2.0, 3: 1.0, 4: 2.0, 5: 0.6, 6: 2.0, 7: 0.8, 8: 1.8,
    9: 1.5, 10: 0.6, 11: 0.7, 12: 1.3, 13: 3.0, 14: 0.6, 15: 5.5, 16: 1.2,
    17: 3.2, 18: 1.0, 19: 1.4, 20: 1.5, 21: 1.8, 22: 0.8, 23: 0.9, 24: 2.6
  };

  /* ------------------------------------------------------------------ *
   * Dates
   *
   * Every date in state is a local-calendar ISO string, "YYYY-MM-DD".
   * Never pass one to new Date() directly — that parses as UTC and shifts
   * the day for anyone west of Greenwich. Arithmetic goes through UTC noon
   * so DST transitions cannot round a day away.
   * ------------------------------------------------------------------ */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toISO(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayISO() { return toISO(new Date()); }

  function parts(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function utcMs(iso) {
    var p = parts(iso);
    return p ? Date.UTC(p[0], p[1] - 1, p[2], 12) : NaN;
  }

  /* b - a, in whole days. 0 if either is missing. */
  function daysBetween(a, b) {
    if (!a || !b) return 0;
    var ms = utcMs(b) - utcMs(a);
    return isNaN(ms) ? 0 : Math.round(ms / 86400000);
  }

  function addDays(iso, n) {
    var p = parts(iso);
    if (!p) return null;
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    d.setUTCDate(d.getUTCDate() + n);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /* 0 = Sunday, matching settings.dailyOverrides. */
  function weekdayOf(iso) {
    var p = parts(iso);
    return p ? new Date(p[0], p[1] - 1, p[2]).getDay() : 0;
  }

  function isValidISO(iso) {
    var p = parts(iso);
    if (!p) return false;
    var d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }

  /* ------------------------------------------------------------------ *
   * Storage
   *
   * Falls back to memory when localStorage is absent (jsc, node) or blocked
   * (Safari private browsing), so save() stays the single write path and the
   * scheduler stays drivable headlessly.
   * ------------------------------------------------------------------ */

  var storage = (function () {
    try {
      if (typeof global.localStorage !== 'undefined' && global.localStorage) {
        global.localStorage.setItem('__probe', '1');
        global.localStorage.removeItem('__probe');
        return global.localStorage;
      }
    } catch (e) { /* fall through to memory */ }
    var mem = {};
    return {
      persistent: false,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  })();

  var store = null;          // the live state object
  var listeners = [];
  var lastSaveError = null;

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](store); } catch (e) { /* a bad listener must not break save */ }
    }
  }

  /* The only write to persistent storage in the codebase. */
  function save() {
    lastSaveError = null;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      lastSaveError = e;   // quota, private browsing, eviction mid-write
    }
    notify();
    return lastSaveError === null;
  }

  function load() {
    var raw = null;
    try { raw = storage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    store = normalizeState(parsed);
    return store;
  }

  /* ------------------------------------------------------------------ *
   * Normalisation
   *
   * seed.json ships pieces with about half the model's fields. Imports may
   * be older or hand-edited. Nothing downstream should ever have to test for
   * a missing field, so everything entering state passes through here.
   * ------------------------------------------------------------------ */

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function str(v, fallback) {
    return typeof v === 'string' ? v : (fallback === undefined ? '' : fallback);
  }

  function isoOrNull(v) { return isValidISO(v) ? v : null; }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function oneOf(v, allowed, fallback) {
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function normalizeSection(raw, index) {
    raw = raw || {};
    return {
      id: str(raw.id) || 's' + ((index || 0) + 1), label: str(raw.label),
      startBar: raw.startBar == null || raw.startBar === '' ? null : Math.max(1, num(raw.startBar, 1)),
      endBar: raw.endBar == null || raw.endBar === '' ? null : Math.max(1, num(raw.endBar, 1)),
      fragilityOverride: raw.fragilityOverride == null || raw.fragilityOverride === '' ? null : clamp(num(raw.fragilityOverride, 3), 1, 5),
      durationMin: Math.max(0.25, num(raw.durationMin, 1)),
      prompt: oneOf(raw.prompt, ['start', 'transition', 'recover'], 'start'),
      notes: str(raw.notes), enabled: raw.enabled !== false,
      state: oneOf(raw.state, ['consolidating', 'established', 'repair'], 'consolidating'),
      stateSince: isoOrNull(raw.stateSince),
      intervalDays: Math.max(1, Math.round(num(raw.intervalDays, 3))),
      nextDue: isoOrNull(raw.nextDue), lastPlayed: isoOrNull(raw.lastPlayed),
      lastColdCall: isoOrNull(raw.lastColdCall),
      lapses: Math.max(0, num(raw.lapses, 0)), failCount: Math.max(0, num(raw.failCount, 0)),
      repairSessions: Math.max(0, num(raw.repairSessions, 0)),
      preRepairInterval: raw.preRepairInterval == null ? null : Math.max(1, num(raw.preRepairInterval, 3)),
      history: Array.isArray(raw.history) ? raw.history.map(normalizeHistoryEntry) : []
    };
  }

  function normalizeHistoryEntry(raw) {
    raw = raw || {};
    var e = {
      date: isoOrNull(raw.date),
      type: oneOf(raw.type, ['maintenance', 'learning', 'coldcall'], 'maintenance'),
      grade: oneOf(raw.grade, GRADES, null)
    };
    /* Learning sessions record percent complete rather than a grade — the
     * three grades describe a finished piece and say nothing useful about
     * one that is a third written into the hands. */
    if (raw.pct != null) e.pct = clamp(Math.round(num(raw.pct, 0)), 0, 100);
    if (raw.sectionId) e.sectionId = str(raw.sectionId);
    ['focus', 'achievement', 'nextFocus', 'stateBefore'].forEach(function (k) { if (raw[k] != null) e[k] = str(raw[k]); });
    ['elapsedDays', 'intervalBefore'].forEach(function (k) { if (raw[k] != null) e[k] = num(raw[k], null); });
    if (raw.early != null) e.early = raw.early === true;
    return e;
  }

  function normalizePiece(raw) {
    raw = raw || {};
    var duration = Math.max(0.1, num(raw.durationMin, 3));
    var state = oneOf(raw.state, STATES, 'backlog');
    var p = {
      id: str(raw.id),
      composerId: str(raw.composerId),
      title: str(raw.title),
      catalogue: str(raw.catalogue),
      tier: clamp(Math.round(num(raw.tier, 0)), 0, 3),
      durationMin: duration,
      contentMin: Math.max(0.1, num(raw.contentMin, duration)),
      fragility: clamp(num(raw.fragility, 3), 1, 5),
      priorKnowledge: oneOf(raw.priorKnowledge, ['new', 'played', 'near'], 'new'),
      tags: Array.isArray(raw.tags) ? raw.tags.map(function (t) { return str(t); }).filter(Boolean) : [],
      notes: str(raw.notes),
      learningFocus: str(raw.learningFocus),
      learningAchievement: str(raw.learningAchievement),
      state: state,
      intervalDays: raw.intervalDays == null ? null : Math.max(1, Math.round(num(raw.intervalDays, 1))),
      lastPlayed: isoOrNull(raw.lastPlayed),
      nextDue: isoOrNull(raw.nextDue),
      lapses: Math.max(0, Math.round(num(raw.lapses, 0))),
      repairSessions: Math.max(0, Math.round(num(raw.repairSessions, 0))),
      preRepairInterval: raw.preRepairInterval == null ? null : Math.max(1, Math.round(num(raw.preRepairInterval, 1))),
      dateFirstLearned: isoOrNull(raw.dateFirstLearned),
      stateSince: isoOrNull(raw.stateSince),
      learnedPct: clamp(Math.round(num(raw.learnedPct, 0)), 0, 100),
      sections: Array.isArray(raw.sections) ? raw.sections.map(normalizeSection) : [],
      history: Array.isArray(raw.history) ? raw.history.map(normalizeHistoryEntry) : []
    };

    /* backlog is not scheduled: it must not carry an interval or a due date,
     * or it will surface in the due pool. lastPlayed/dateFirstLearned are
     * kept — they are history, not schedule. */
    if (p.state === 'backlog') {
      p.intervalDays = null;
      p.nextDue = null;
    } else if (p.intervalDays == null) {
      p.intervalDays = defaultIntervalFor(p.state);
    }

    prepareSections(p, todayISO());
    return p;
  }

  function normalizeComposer(raw) {
    raw = raw || {};
    return {
      id: str(raw.id),
      canonicalName: str(raw.canonicalName),
      era: str(raw.era),
      nationality: str(raw.nationality),
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(function (a) { return str(a); }).filter(Boolean) : []
    };
  }

  function defaultSettings() {
    return {
      targetDailyMinutes: 30,
      /* Sparse: only weekdays that differ from the target. 0 = Sunday.
       * A 0 means "no session expected", not "closed" — the app still
       * offers to practise, and gap detection skips these days. */
      dailyOverrides: { 0: 0, 6: 0 },
      maxLearning: 2,
      lastSessionDate: null,
      lastExportDate: null,
      onBreak: false,                                  // stored, unused until Phase 5
      capacityWatch: { overSince: null, nudgedFor: null }
    };
  }

  function normalizeState(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var d = defaultSettings();
    var s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};

    var overrides = {};
    var src = s.dailyOverrides && typeof s.dailyOverrides === 'object' ? s.dailyOverrides : d.dailyOverrides;
    for (var dow = 0; dow <= 6; dow++) {
      if (src[dow] != null) overrides[dow] = Math.max(0, Math.round(num(src[dow], 0)));
    }

    var watch = s.capacityWatch && typeof s.capacityWatch === 'object' ? s.capacityWatch : {};

    var next = {
      version: STATE_VERSION,
      settings: {
        targetDailyMinutes: Math.max(0, Math.round(num(s.targetDailyMinutes, d.targetDailyMinutes))),
        dailyOverrides: overrides,
        maxLearning: Math.max(0, Math.round(num(s.maxLearning, d.maxLearning))),
        lastSessionDate: isoOrNull(s.lastSessionDate),
        /* null means "never exported". Stamped on first save so the 14-day
         * reminder starts from first use rather than firing on day one. */
        lastExportDate: isoOrNull(s.lastExportDate),
        onBreak: s.onBreak === true,
        capacityWatch: {
          overSince: isoOrNull(watch.overSince),
          nudgedFor: isoOrNull(watch.nudgedFor)
        }
      },
      composers: Array.isArray(raw.composers) ? raw.composers.map(normalizeComposer).filter(function (c) { return c.id; }) : [],
      pieces: Array.isArray(raw.pieces) ? raw.pieces.map(normalizePiece).filter(function (p) { return p.id; }) : [],
      session: raw.session && typeof raw.session === 'object' ? normalizeSession(raw.session) : null,
      capacityLog: Array.isArray(raw.capacityLog) ? raw.capacityLog.slice(-TUNING.capacityLogDays) : []
    };

    if (!next.settings.lastExportDate) next.settings.lastExportDate = todayISO();
    return next;
  }

  function normalizeSession(raw) {
    if (!raw || !Array.isArray(raw.plan)) return null;
    var plan = raw.plan.map(function (it) {
      return {
        pieceId: str(it.pieceId),
        sectionId: it.sectionId ? str(it.sectionId) : null,
        kind: oneOf(it.kind, ['learning', 'maintenance', 'lookahead'], 'maintenance'),
        estMin: num(it.estMin, 0)
      };
    }).filter(function (it) { return it.pieceId; });

    /* results is index-aligned with plan — results[i] is null until item i
     * has been recorded. That is what lets the session be navigated in any
     * order and any item re-recorded in place. */
    var results = new Array(plan.length);
    var src = Array.isArray(raw.results) ? raw.results : [];
    for (var i = 0; i < plan.length; i++) results[i] = src[i] || null;

    return {
      date: isoOrNull(raw.date),
      budgetMin: Math.max(0, num(raw.budgetMin, 0)),
      plan: plan,
      index: clamp(Math.round(num(raw.index, 0)), 0, plan.length),
      results: results,
      deferredCount: Math.max(0, Math.round(num(raw.deferredCount, 0))),
      deferredMin: Math.max(0, num(raw.deferredMin, 0)),
      startedAt: isoOrNull(raw.startedAt),
      finished: raw.finished === true
    };
  }

  function defaultIntervalFor(state) {
    if (state === 'learning') return TUNING.learningIntervalDays;
    if (state === 'consolidating') return TUNING.consolidatingIntervalDays;
    if (state === 'repair') return 1;
    if (state === 'established') return TUNING.firstEstablishedInterval;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Budget
   * ------------------------------------------------------------------ */

  function budgetForWeekday(dow) {
    var o = store.settings.dailyOverrides;
    return o[dow] != null ? o[dow] : store.settings.targetDailyMinutes;
  }

  function budgetForDate(iso) { return budgetForWeekday(weekdayOf(iso)); }

  function weeklyBudget() {
    var t = 0;
    for (var d = 0; d <= 6; d++) t += budgetForWeekday(d);
    return t;
  }

  function sessionDaysPerWeek() {
    var n = 0;
    for (var d = 0; d <= 6; d++) if (budgetForWeekday(d) > 0) n++;
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Scheduler
   * ------------------------------------------------------------------ */

  /* Linear interpolation between cap rows. fragility 4.5 -> 9.5. */
  function capFor(fragility) {
    var f = clamp(num(fragility, 3), 1, 5);
    var lo = Math.floor(f), hi = Math.ceil(f);
    if (lo === hi) return CAPS[lo];
    return CAPS[lo] + (CAPS[hi] - CAPS[lo]) * (f - lo);
  }

  /* The cap as actually applied to an interval: 9.5 -> 10. */
  function appliedCap(fragility) {
    return Math.max(1, Math.round(capFor(fragility)));
  }

  function clampInterval(days, fragility) {
    return Math.max(1, Math.min(Math.round(days), appliedCap(fragility)));
  }

  /* Injectable so sim.js can run reproducibly. */
  var rng = Math.random;

  /* Jitter is applied to the already-capped interval, not to the raw product.
   * Applied before the cap it would be erased for every piece sitting at its
   * cap — which is precisely the cohort most likely to be in lockstep. After
   * the cap it can only shorten those pieces, which is what breaks them up.
   * The cost is a slight downward bias at the cap, a percent or two of extra
   * load, paid to stop 14 preludes coming due on the same morning forever. */
  function jitterInterval(days, fragility) {
    var j = TUNING.intervalJitter;
    if (!j) return clampInterval(days, fragility);
    var capped = clampInterval(days, fragility);
    var varied = capped * (1 + (rng() * 2 - 1) * j);
    return clampInterval(varied, fragility);
  }

  function prepareSections(p, today) {
    p.sections.forEach(function (sec, i) {
      sec.fragility = sec.fragilityOverride == null ? p.fragility : sec.fragilityOverride;
      var capped = clampInterval(sec.intervalDays, sec.fragility);
      if (capped !== sec.intervalDays && sec.lastPlayed) sec.nextDue = addDays(sec.lastPlayed, capped);
      sec.intervalDays = capped;
      if (!sec.stateSince) sec.stateSince = today;
      if (!sec.nextDue) sec.nextDue = addDays(today, 1 + (i % 3));
    });
  }

  function sectionById(p, id) {
    return p && p.sections.filter(function (sec) { return sec.id === id; })[0] || null;
  }

  function reviewUnits() {
    var units = [];
    store.pieces.forEach(function (p) {
      units.push(p);
      if (MAINTENANCE_STATES.indexOf(p.state) < 0) return;
      p.sections.forEach(function (sec) {
        if (!sec.enabled) return;
        var unit = Object.assign({}, sec);
        unit.id = p.id + '::' + sec.id;
        unit.parentPieceId = p.id; unit.sectionId = sec.id;
        unit.fragility = sec.fragilityOverride == null ? p.fragility : sec.fragilityOverride;
        units.push(unit);
      });
    });
    return units;
  }

  function reviewItem(unit, kind) {
    return { pieceId: unit.parentPieceId || unit.id, sectionId: unit.sectionId || null,
      piece: unit.parentPieceId ? pieceById(unit.parentPieceId) : unit,
      kind: kind, estMin: pieceCost(unit) };
  }

  function cleanDatesSinceFailure(p) {
    var dates = [];
    p.history.forEach(function (h) {
      if (!h.date || (p.stateSince && h.date < p.stateSince)) return;
      if (h.grade === 'broke') dates = [];
      else if (h.grade === 'clean' && !h.early && dates.indexOf(h.date) < 0) dates.push(h.date);
    });
    return dates;
  }

  function pieceCost(p) { return p.durationMin * TUNING.maintenanceCostFactor; }

  function isScheduled(p) { return SCHEDULED_STATES.indexOf(p.state) >= 0; }

  function isDue(p, today) {
    return isScheduled(p) && p.nextDue != null && daysBetween(p.nextDue, today) >= 0;
  }

  /* Positive when past due, negative when still ahead. */
  function daysOverdue(p, today) {
    return p.nextDue ? daysBetween(p.nextDue, today) : 0;
  }

  function overdueRatio(p, today) {
    return Math.max(0, daysOverdue(p, today)) / Math.max(1, p.intervalDays || 1);
  }

  /* The single ranking function. Used by the session builder and by the gap
   * report, so overdue-ness means the same thing in both places. */
  function priority(p, today) {
    return (1 + overdueRatio(p, today)) * p.fragility;
  }

  function historyType(state) { return state === 'learning' ? 'learning' : 'maintenance'; }

  function setPieceState(p, next, today) {
    if (p.state !== next) {
      p.state = next;
      p.stateSince = today;
    }
  }

  /* Applies one grade to one piece. Pure with respect to the store — it
   * mutates only the piece it is given, so sim.js can drive it directly.
   * Returns a record of what changed, for the session summary. */
  function applyGrade(p, grade, today) {
    grade = oneOf(grade, GRADES, 'wobbled');
    today = today || todayISO();

    var before = { state: p.state, intervalDays: p.intervalDays };

    var early = !!(p.nextDue && today < p.nextDue);
    var elapsed = p.lastPlayed ? daysBetween(p.lastPlayed, today) : null;
    p.history.push({ date: today, type: historyType(p.state), grade: grade,
      elapsedDays: elapsed, intervalBefore: p.intervalDays, early: early, stateBefore: p.state });
    p.lastPlayed = today;

    switch (p.state) {
      case 'learning':
        /* Daily, fixed slot. Grades are recorded but do not move the
         * schedule — promotion out of learning is manual only. */
        p.intervalDays = TUNING.learningIntervalDays;
        p.nextDue = addDays(today, p.intervalDays);
        break;

      case 'consolidating':
        /* Fixed 3-day cadence. Does not enter repair: a piece that is not
         * yet established has nothing to fall back to. */
        p.intervalDays = TUNING.consolidatingIntervalDays;
        p.nextDue = addDays(today, p.intervalDays);
        break;

      case 'repair':
        if (grade === 'broke') {
          p.repairSessions = 0;          // three consecutive, not three cumulative
          p.intervalDays = 1;
          p.nextDue = addDays(today, 1);
        } else {
          p.repairSessions = cleanDatesSinceFailure(p).length;
          if (grade === 'clean' && p.repairSessions >= TUNING.repairSessionsToExit) {
            var base = p.preRepairInterval || TUNING.firstEstablishedInterval;
            setPieceState(p, 'established', today);
            p.intervalDays = jitterInterval(base * TUNING.repairIntervalFactor, p.fragility);
            p.preRepairInterval = null;
            p.repairSessions = 0;
            p.nextDue = addDays(today, p.intervalDays);
          } else {
            p.intervalDays = 1;
            p.nextDue = addDays(today, 1);
          }
        }
        break;

      case 'established':
        if (grade === 'broke') {
          p.preRepairInterval = p.intervalDays || TUNING.firstEstablishedInterval;
          p.lapses += 1;
          p.repairSessions = 0;
          setPieceState(p, 'repair', today);
          p.intervalDays = 1;
          p.nextDue = addDays(today, 1);
        } else {
          var current = p.intervalDays || TUNING.firstEstablishedInterval;
          var capped = appliedCap(p.fragility);
          if (early && grade === 'clean') {
            p.intervalDays = clampInterval(current, p.fragility);
          } else if (grade === 'clean') {
            /* Math.round(1 * 1.4) === 1, so without a floor of one extra day
             * an interval of 1 is an absorbing state: a piece that has
             * ratcheted down through repeated lapses can never climb out of
             * it, and is played daily forever. Clean must always buy at
             * least a day while there is headroom under the cap. */
            var target = Math.max(current + 1, Math.round(current * TUNING.cleanMultiplier));
            p.intervalDays = jitterInterval(target, p.fragility);
            if (p.intervalDays <= current && current < capped) {
              p.intervalDays = Math.min(current + 1, capped);
            }
          } else {
            // An uncertain recall never earns a longer interval.
            p.intervalDays = clampInterval(current, p.fragility);
          }
          p.nextDue = addDays(today, p.intervalDays);
        }
        break;

      default:
        /* backlog — not schedulable. Grade is recorded, schedule untouched. */
        break;
    }

    return {
      pieceId: p.id,
      grade: grade,
      from: before,
      to: { state: p.state, intervalDays: p.intervalDays },
      nextDue: p.nextDue,
      enteredRepair: before.state === 'established' && p.state === 'repair',
      leftRepair: before.state === 'repair' && p.state === 'established',
      intervalChanged: before.intervalDays !== p.intervalDays
    };
  }

  /* A piece being learned is not gradeable — Clean, Wobbled and Broke down
   * all describe a finished piece. What matters instead is how far through
   * it you are, which also gives Phase 4 the throughput data to estimate how
   * long new material takes. Recorded per session, appended to history. */
  function recordLearningProgress(p, pct, today) {
    today = today || todayISO();
    var before = { state: p.state, learnedPct: p.learnedPct };

    p.learnedPct = clamp(Math.round(num(pct, p.learnedPct)), 0, 100);
    p.history.push({ date: today, type: 'learning', grade: null, pct: p.learnedPct });
    p.lastPlayed = today;
    p.intervalDays = TUNING.learningIntervalDays;
    p.nextDue = addDays(today, p.intervalDays);

    return {
      pieceId: p.id,
      pct: p.learnedPct,
      grade: null,
      from: before,
      to: { state: p.state, learnedPct: p.learnedPct },
      nextDue: p.nextDue,
      enteredRepair: false,
      leftRepair: false,
      intervalChanged: false,
      pctChanged: before.learnedPct !== p.learnedPct
    };
  }

  function recordLearningNote(p, payload, today) {
    today = today || todayISO();
    var focus = str(payload.focus).trim(), achievement = str(payload.achievement).trim();
    var nextFocus = str(payload.nextFocus).trim();
    p.history.push({ date: today, type: 'learning', grade: null, focus: focus,
      achievement: achievement, nextFocus: nextFocus });
    p.learningFocus = nextFocus || focus;
    p.learningAchievement = achievement;
    p.lastPlayed = today; p.intervalDays = 1; p.nextDue = addDays(today, 1);
    return { pieceId: p.id, grade: null, focus: focus, achievement: achievement,
      nextFocus: p.learningFocus, enteredRepair: false, leftRepair: false, intervalChanged: false };
  }

  function gradeSection(parent, sec, grade, today) {
    sec.fragility = sec.fragilityOverride == null ? parent.fragility : sec.fragilityOverride;
    var ch = applyGrade(sec, grade, today);
    var h = sec.history[sec.history.length - 1];
    h.type = 'coldcall'; h.sectionId = sec.id;
    sec.lastColdCall = today;
    if (grade === 'broke') {
      sec.failCount++;
      if (ch.from.state === 'consolidating') {
        sec.preRepairInterval = ch.from.intervalDays;
        sec.lapses++; sec.repairSessions = 0;
        setPieceState(sec, 'repair', today); sec.intervalDays = 1; sec.nextDue = addDays(today, 1);
        ch.enteredRepair = true;
      }
    } else if (sec.state === 'consolidating' && grade === 'clean' && cleanDatesSinceFailure(sec).length >= 2) {
      setPieceState(sec, 'established', today);
    }
    ch.pieceId = parent.id; ch.sectionId = sec.id;
    ch.to = { state: sec.state, intervalDays: sec.intervalDays }; ch.nextDue = sec.nextDue;
    return ch;
  }

  /* Days spent in learning so far — the raw material for "how long does a
   * new piece take me". */
  function daysLearning(p, today) {
    var from = p.stateSince || p.dateFirstLearned;
    return from ? Math.max(0, daysBetween(from, today || todayISO())) : null;
  }

  /* Manual transitions. Promotion out of learning and consolidating is never
   * automatic — the app may suggest, the user decides. */

  function startLearning(p, today) {
    today = today || todayISO();
    if (!p.dateFirstLearned) p.dateFirstLearned = today;
    setPieceState(p, 'learning', today);
    p.intervalDays = TUNING.learningIntervalDays;
    p.nextDue = today;                        // available immediately
    return p;
  }

  function promote(p, today) {
    today = today || todayISO();
    if (p.state === 'learning') {
      setPieceState(p, 'consolidating', today);
      p.intervalDays = TUNING.consolidatingIntervalDays;
      p.nextDue = addDays(today, p.intervalDays);
    } else if (p.state === 'consolidating') {
      setPieceState(p, 'established', today);
      p.intervalDays = TUNING.firstEstablishedInterval;
      p.nextDue = addDays(today, p.intervalDays);
    }
    return p;
  }

  /* Backfills schedule fields when the user changes state by hand in the
   * editor, so a piece can never sit in a scheduled state with no due date. */
  function setStateManually(p, next, today) {
    today = today || todayISO();
    next = oneOf(next, STATES, p.state);
    if (next === p.state) return p;

    setPieceState(p, next, today);
    switch (next) {
      case 'backlog':
        p.intervalDays = null;
        p.nextDue = null;
        p.repairSessions = 0;
        p.preRepairInterval = null;
        break;
      case 'learning':
        if (!p.dateFirstLearned) p.dateFirstLearned = today;
        p.intervalDays = TUNING.learningIntervalDays;
        p.nextDue = today;
        break;
      case 'consolidating':
        if (!p.dateFirstLearned) p.dateFirstLearned = today;
        p.intervalDays = TUNING.consolidatingIntervalDays;
        p.nextDue = today;
        break;
      case 'established':
        if (!p.dateFirstLearned) p.dateFirstLearned = today;
        p.intervalDays = clampInterval(p.intervalDays || TUNING.firstEstablishedInterval, p.fragility);
        p.nextDue = today;
        break;
      case 'repair':
        p.preRepairInterval = p.intervalDays || TUNING.firstEstablishedInterval;
        p.repairSessions = 0;
        p.intervalDays = 1;
        p.nextDue = today;
        break;
    }
    return p;
  }

  /* The app may suggest promotion; it never performs it. */
  function suggestsPromotion(p, today) {
    if (p.state !== 'consolidating' || !p.stateSince) return false;
    return daysBetween(p.stateSince, today) >= TUNING.promotionSuggestDays && cleanDatesSinceFailure(p).length >= 2;
  }

  /* Re-clamp after a fragility edit, so lowering fragility cannot leave a
   * piece sitting above its new cap. */
  function reclampInterval(p, today) {
    if (!isScheduled(p) || p.intervalDays == null) return;
    var capped = clampInterval(p.intervalDays, p.fragility);
    if (capped !== p.intervalDays) {
      p.intervalDays = capped;
      if (p.lastPlayed) p.nextDue = addDays(p.lastPlayed, capped);
      else p.nextDue = addDays(today || todayISO(), capped);
    }
  }

  /* ------------------------------------------------------------------ *
   * Session builder
   * ------------------------------------------------------------------ */

  function learningCandidates(today) {
    return store.pieces
      .filter(function (p) { return p.state === 'learning'; })
      .sort(function (a, b) { return priority(b, today) - priority(a, today) || cmpId(a, b); });
  }

  function cmpId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  function duePool(today) {
    return reviewUnits()
      .filter(function (p) { return MAINTENANCE_STATES.indexOf(p.state) >= 0 && isDue(p, today); })
      .sort(function (a, b) {
        /* repair outranks everything, then priority, then longer pieces
         * first so ties never systematically favour the short ones. */
        var ar = a.state === 'repair' ? 1 : 0, br = b.state === 'repair' ? 1 : 0;
        if (ar !== br) return br - ar;
        var d = priority(b, today) - priority(a, today);
        if (Math.abs(d) > 1e-9) return d;
        if (b.durationMin !== a.durationMin) return b.durationMin - a.durationMin;
        return cmpId(a, b);
      });
  }

  /* Projected minutes per day for the week ahead. Naive by design: it assumes
   * every piece is played on its due date and keeps its current interval. Over
   * seven days that is close enough to see a heavy Monday coming, which is all
   * it is for. Overdue pieces are projected onto today. */
  function loadForecast(today, days) {
    today = today || todayISO();
    days = days || TUNING.forecastDays;

    var buckets = {}, order = [];
    for (var i = 0; i < days; i++) {
      var d = addDays(today, i);
      buckets[d] = 0;
      order.push(d);
    }
    var horizon = order[order.length - 1];
    var slots = Math.min(learningCandidates(today).length, store.settings.maxLearning);

    reviewUnits().forEach(function (p) {
      if (MAINTENANCE_STATES.indexOf(p.state) < 0 || !p.nextDue) return;
      var iv = Math.max(1, p.intervalDays || 1);
      var cost = pieceCost(p);
      var d = daysBetween(p.nextDue, today) >= 0 ? today : p.nextDue;
      var guard = 0;
      while (daysBetween(d, horizon) >= 0 && guard++ < 400) {
        if (buckets[d] != null) buckets[d] += cost;
        d = addDays(d, iv);
      }
    });

    return order.map(function (d) {
      var budget = budgetForDate(d);
      var maintenance = buckets[d];
      var learning = budget > 0 ? slots * TUNING.learningSlotMin : 0;
      var projected = maintenance + learning;
      /* A zero-budget day carrying work is the worst kind of pressure, not
         the absence of it: none of it will be done, so all of it lands on
         the next session. Treating it as "not over" is what let the weekend
         pile onto Monday. */
      return {
        date: d,
        weekday: weekdayOf(d),
        budget: budget,
        maintenanceMin: maintenance,
        learningMin: learning,
        projectedMin: projected,
        over: projected > budget,
        overBy: Math.max(0, projected - budget)
      };
    });
  }

  /* date -> minutes that day is projected to run over its budget. */
  function forecastPressure(today) {
    var out = {};
    loadForecast(today, TUNING.forecastDays).forEach(function (d) {
      if (d.overBy > 0) out[d.date] = d.overBy;
    });
    return out;
  }

  /* Lookahead is load-balancing, not gap-filling.
   *
   * Pulling something forward buys nothing on its own — it spends today's
   * budget to play a piece earlier than its interval calls for, which is a
   * small loss of spacing every time. It is only worth doing when the day
   * that item falls on cannot absorb it. So the sole criterion is pressure:
   * the item's due date is projected over its budget (and a zero-budget day
   * always is, if it carries work).
   *
   * Filling spare capacity indiscriminately instead cost roughly a quarter
   * of the repertoire's scheduled spacing — every piece played at ~74% of
   * its interval, for no benefit. */
  function lookaheadPool(today, pressure) {
    var horizon = addDays(today, TUNING.lookaheadDays);
    pressure = pressure || {};

    return reviewUnits()
      .filter(function (p) {
        if (p.sectionId) return false; // section probes are never rehearsed early
        var lastReview = p.history[p.history.length - 1];
        if (lastReview && lastReview.early) return false; // allow a full interval after pulling forward
        if (p.state !== 'consolidating' && p.state !== 'established') return false;
        if (!p.nextDue) return false;
        if (daysBetween(p.nextDue, today) >= 0) return false;          // already due today
        if (daysBetween(p.nextDue, horizon) < 0) return false;         // beyond the horizon
        return (pressure[p.nextDue] || 0) > 0;
      })
      .sort(function (a, b) {
        /* Relieving an overloaded day comes first; within each group,
         * cheapest first. This is leftover budget, not contested budget —
         * nothing due today is being displaced, so more items is better. */
        var ap = (pressure[a.nextDue] || 0) > 0 ? 0 : 1;
        var bp = (pressure[b.nextDue] || 0) > 0 ? 0 : 1;
        if (ap !== bp) return ap - bp;
        var c = pieceCost(a) - pieceCost(b);
        if (Math.abs(c) > 1e-9) return c;
        var n = daysBetween(b.nextDue, a.nextDue);
        if (n !== 0) return -n;
        return cmpId(a, b);
      });
  }

  /* Fits a session to `minutes`. Does not mutate state. */
  function buildSession(minutes, today) {
    today = today || todayISO();
    minutes = Math.max(0, num(minutes, 0));

    var maxL = store.settings.maxLearning;
    var learners = learningCandidates(today);
    var pool = duePool(today);
    var dueCost = pool.reduce(function (t, p) { return t + pieceCost(p); }, 0);

    /* Keeping learned pieces functional outranks learning new ones. At or
     * above the day's target both learning slots are protected. Below it —
     * a deliberate "less time" — learning yields a slot at a time before any
     * maintenance is deferred. On a zero-budget day the target stands in for
     * the budget, so an opportunistic Sunday session is judged against 30
     * minutes rather than against nothing. */
    var reference = budgetForDate(today) || store.settings.targetDailyMinutes;
    var belowTarget = minutes < reference;
    var slots = Math.min(learners.length, maxL);
    var yielded = 0;
    /* Only yield when there is maintenance to yield *to*. On a quiet day with
     * nothing due, dropping a slot frees ten minutes for nothing — so the
     * learning block stands and simply overruns a small budget, as before. */
    if (belowTarget && dueCost > 0) {
      while (slots > 0 && slots * TUNING.learningSlotMin + dueCost > minutes) {
        slots--;
        yielded++;
      }
    }

    var learningItems = learners.slice(0, slots).map(function (p) {
      return { pieceId: p.id, piece: p, kind: 'learning', estMin: TUNING.learningSlotMin };
    });

    var spent = learningItems.length * TUNING.learningSlotMin;
    var maintenanceItems = [];
    var lookaheadItems = [];
    var scheduledIds = {};
    var overshot = false;
    var stoppedOnBudget = false;

    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      var cost = pieceCost(p);

      if (spent + cost <= minutes) {
        maintenanceItems.push(reviewItem(p, 'maintenance'));
        scheduledIds[p.id] = true;
        spent += cost;
        continue;
      }

      /* Does not fit. Rescue it only if it is well past due and the overshoot
       * stays inside the allowance — then stop regardless. We never skip past
       * an item to pack a smaller one behind it; that is exactly what starves
       * the long pieces. */
      if (overdueRatio(p, today) > TUNING.overdueRescueThreshold &&
          spent + cost <= minutes * (1 + TUNING.overshootAllowance)) {
        maintenanceItems.push(reviewItem(p, 'maintenance'));
        scheduledIds[p.id] = true;
        spent += cost;
        overshot = true;
      }
      stoppedOnBudget = true;
      break;
    }

    var deferred = pool.filter(function (p) { return !scheduledIds[p.id]; });

    /* Lookahead only runs when everything due today is already in. Pulling
     * future work forward while today's is deferred would be incoherent —
     * and by construction there is no budget left to do it with. Within that
     * constraint it now reaches past the 2-day window to relieve any day in
     * the next week already projected over its budget. */
    if (!stoppedOnBudget && spent < minutes) {
      var pressure = forecastPressure(today);
      var ahead = lookaheadPool(today, pressure);
      for (var j = 0; j < ahead.length; j++) {
        var q = ahead[j];
        var qc = pieceCost(q);
        if (spent + qc > minutes) break;     // cheapest-first: nothing later fits either
        /* Shed only the day's excess, never the whole day. Draining every
         * over-budget day as far as spare capacity allows pulls most of the
         * repertoire forward permanently and costs about a third of its
         * scheduled spacing for no gain. A zero-budget day's entire load is
         * excess, so weekends still clear completely. */
        var remain = pressure[q.nextDue] || 0;
        if (remain <= 0) continue;           // that day no longer needs relief
        pressure[q.nextDue] = remain - qc;
        lookaheadItems.push(reviewItem(q, 'lookahead'));
        spent += qc;
      }
    }

    var deferredMin = deferred.reduce(function (t, p) { return t + pieceCost(p); }, 0);
    /* Demand is what today asked for at full strength — the learning block
     * at its unyielded size, plus everything due. Yielding a slot reduces the
     * plan, never the demand. */
    var fullLearning = Math.min(learners.length, maxL) * TUNING.learningSlotMin;

    return {
      date: today,
      budgetMin: minutes,
      referenceMin: reference,
      belowTarget: belowTarget,
      learning: learningItems,
      maintenance: maintenanceItems,
      lookahead: lookaheadItems,
      /* Play order: maintenance, then anything pulled forward, then learning
       * last. The learning block still gets its budget reserved up front —
       * only the order changed — but putting it at the end means a session
       * that has to be cut short drops learning rather than maintenance. */
      items: maintenanceItems.filter(function (it) { return it.sectionId; }).concat(maintenanceItems.filter(function (it) { return !it.sectionId; }), lookaheadItems, learningItems),
      plannedMin: spent,
      demandMin: fullLearning + dueCost,
      maintenanceDemandMin: dueCost,
      learningDemandMin: fullLearning,
      deferred: deferred,
      deferredCount: deferred.length,
      deferredMin: deferredMin,
      learningYielded: yielded,
      overshot: overshot,
      /* true when the learning block alone is the whole session */
      learningOnly: maintenanceItems.length === 0 && lookaheadItems.length === 0 && learningItems.length > 0,
      learningExceedsBudget: learningItems.length * TUNING.learningSlotMin > minutes,
      excessLearners: Math.max(0, learners.length - maxL)
    };
  }

  /* Everything due today, uncapped — the honest cost of clearing the day. */
  function idealMinutes(today) {
    today = today || todayISO();
    var learners = Math.min(learningCandidates(today).length, store.settings.maxLearning);
    return learners * TUNING.learningSlotMin +
      duePool(today).reduce(function (t, p) { return t + pieceCost(p); }, 0);
  }

  /* The figure offered as the default tap. Still capped so a heavy day never
   * proposes something absurd — but idealMinutes is shown beside it whenever
   * the two differ, so the cap hides nothing. */
  function recommendedMinutes(today) {
    today = today || todayISO();
    var demand = idealMinutes(today);
    if (demand <= 0) return 0;

    var base = budgetForDate(today) || store.settings.targetDailyMinutes;
    var capped = Math.min(demand, base * TUNING.recommendationCapFactor);
    var r = TUNING.recommendationRounding;
    return Math.max(r, Math.ceil(capped / r) * r);
  }

  function roundTo5(m) {
    var r = TUNING.recommendationRounding;
    return Math.max(0, Math.round(m / r) * r);
  }

  /* ------------------------------------------------------------------ *
   * Session lifecycle
   *
   * Every grade is committed to state immediately. iOS kills backgrounded
   * PWAs routinely and mid-session is the likeliest moment to lose work, so
   * the plan lives in state and a reopened app resumes where it left off.
   * ------------------------------------------------------------------ */

  function startSession(minutes, today) {
    today = today || todayISO();
    var built = buildSession(minutes, today);
    var plan = built.items.map(function (it) {
      return { pieceId: it.pieceId, sectionId: it.sectionId || null, kind: it.kind, estMin: it.estMin };
    });
    store.session = {
      date: today,
      budgetMin: built.budgetMin,
      plan: plan,
      index: 0,
      results: new Array(plan.length),
      deferredCount: built.deferredCount,
      deferredMin: built.deferredMin,
      startedAt: today,
      finished: false
    };
    store.settings.lastSessionDate = today;
    logCapacity(built);
    save();
    return built;
  }

  function itemAt(i) {
    var s = store.session;
    if (!s || i < 0 || i >= s.plan.length) return null;
    var entry = s.plan[i];
    var p = pieceById(entry.pieceId);
    if (!p) return null;
    var sec = entry.sectionId ? sectionById(p, entry.sectionId) : null;
    if (entry.sectionId && !sec) return null;
    return {
      section: sec, subject: sec || p,
      piece: p, kind: entry.kind, estMin: entry.estMin,
      index: i, total: s.plan.length, result: s.results[i] || null
    };
  }

  function currentItem() {
    var s = store.session;
    return s ? itemAt(s.index) : null;
  }

  /* Everything needed to put a piece back exactly as it was before an item
   * was recorded. This is what makes a recorded item re-recordable in place:
   * re-grading restores the snapshot first, so effects never stack. */
  function snapshotPiece(p) {
    return {
      state: p.state,
      intervalDays: p.intervalDays,
      lastPlayed: p.lastPlayed,
      nextDue: p.nextDue,
      lapses: p.lapses,
      repairSessions: p.repairSessions,
      preRepairInterval: p.preRepairInterval,
      stateSince: p.stateSince,
      learnedPct: p.learnedPct,
      learningFocus: p.learningFocus, learningAchievement: p.learningAchievement,
      lastColdCall: p.lastColdCall, failCount: p.failCount,
      historyLen: p.history.length
    };
  }

  function restorePiece(p, snap) {
    if (!snap) return;
    p.state = snap.state;
    p.intervalDays = snap.intervalDays;
    p.lastPlayed = snap.lastPlayed;
    p.nextDue = snap.nextDue;
    p.lapses = snap.lapses;
    p.repairSessions = snap.repairSessions;
    p.preRepairInterval = snap.preRepairInterval;
    p.stateSince = snap.stateSince;
    p.learnedPct = snap.learnedPct;
    p.learningFocus = snap.learningFocus; p.learningAchievement = snap.learningAchievement;
    p.lastColdCall = snap.lastColdCall; p.failCount = snap.failCount;
    if (p.history.length > snap.historyLen) p.history.length = snap.historyLen;
  }

  /* Undo whatever was recorded at index i, leaving the slot empty. */
  function clearResultAt(i) {
    var s = store.session;
    if (!s) return false;
    var r = s.results[i];
    if (!r) return false;
    var p = pieceById(r.pieceId);
    if (p) { var target = r.sectionId ? sectionById(p, r.sectionId) : p; if (target) restorePiece(target, r.snapshot); }
    if (!r.skipped) addActualMinutes(s.date, -num(r.countedMin, 0));
    s.results[i] = null;
    return true;
  }

  /* Record (or re-record) item i. `payload` is {grade} or {pct} or {skip}. */
  function recordAt(i, payload) {
    var s = store.session;
    if (!s) return null;
    var it = itemAt(i);
    if (!it) return null;

    clearResultAt(i);                       // re-recording never stacks
    var p = it.piece;
    var snap = snapshotPiece(it.subject);
    var result = { pieceId: p.id, sectionId: it.section ? it.section.id : null, snapshot: snap, countedMin: 0 };

    if (payload.skip) {
      /* Skipping is never a failure: no history entry, no lapse, no state
       * change. A maintenance item stays due, as the brief specifies. A
       * learning item moves to tomorrow — leaving it due today would just
       * have it reappear in the same session. */
      result.skipped = true;
      result.grade = null;
      result.pct = null;
      result.change = null;
      if (p.state === 'learning') {
        p.nextDue = addDays(s.date, 1);
        result.pushed = true;
      }
    } else if (it.kind === 'learning' || p.state === 'learning') {
      var pr = payload.pct != null ? recordLearningProgress(p, payload.pct, s.date) : recordLearningNote(p, payload, s.date);
      result.skipped = false;
      result.grade = null;
      result.pct = pr.pct;
      result.learning = true; result.achievement = pr.achievement; result.nextFocus = pr.nextFocus;
      result.change = pr;
      result.countedMin = it.estMin;
    } else {
      var ch = it.section ? gradeSection(p, it.section, payload.grade, s.date) : applyGrade(p, payload.grade, s.date);
      result.skipped = false;
      result.grade = ch.grade;
      result.pct = null;
      result.change = ch;
      result.countedMin = it.estMin;
    }

    if (result.countedMin) addActualMinutes(s.date, result.countedMin);
    s.results[i] = result;
    save();
    return result;
  }

  /* After recording, land on the next item still needing attention — which
   * returns you to where you were if you had jumped back to fix something. */
  function advanceFrom(i) {
    var s = store.session;
    if (!s) return;
    var n = s.plan.length, k;
    for (k = i + 1; k < n; k++) if (!s.results[k]) { s.index = k; return; }
    for (k = 0; k < n; k++) if (!s.results[k]) { s.index = k; return; }
    s.index = n;                            // everything recorded
  }

  function recordCurrent(payload) {
    var s = store.session;
    if (!s) return null;
    var i = s.index;
    var r = recordAt(i, payload);
    if (r) { advanceFrom(i); save(); }
    return r;
  }

  function gradeCurrent(grade) { return recordCurrent({ grade: grade }); }
  function setLearningCurrent(payload) { return recordCurrent(payload || {}); }
  function setProgressCurrent(pct) { return recordCurrent({ pct: pct }); }
  function skipCurrent() {
    var r = recordCurrent({ skip: true });
    return r ? pieceById(r.pieceId) : null;
  }

  function goToIndex(i) {
    var s = store.session;
    if (!s) return false;
    s.index = clamp(Math.round(i), 0, s.plan.length);
    s.finished = false;
    save();
    return true;
  }

  function stepIndex(delta) {
    var s = store.session;
    if (!s) return false;
    return goToIndex(s.index + delta);
  }

  /* Undo the recording on the item currently shown, so it can be redone. */
  function undoCurrent() {
    var s = store.session;
    if (!s) return false;
    var done = clearResultAt(s.index);
    if (done) save();
    return done;
  }

  function sessionProgress() {
    var s = store.session;
    if (!s) return null;
    var recorded = 0;
    for (var i = 0; i < s.results.length; i++) if (s.results[i]) recorded++;
    return {
      recorded: recorded,
      total: s.plan.length,
      remaining: s.plan.length - recorded,
      allRecorded: recorded === s.plan.length
    };
  }

  /* The user may end a session early — with learning last, that is the
   * intended way to drop it when time runs out. */
  function finishSession() {
    var s = store.session;
    if (!s) return;
    s.finished = true;
    s.index = s.plan.length;
    save();
  }

  /* Keeps a running session honest after the piece is edited mid-play. */
  function refreshPlanEstimate(pieceId) {
    var s = store.session;
    if (!s) return;
    var p = pieceById(pieceId);
    if (!p) return;
    for (var i = 0; i < s.plan.length; i++) {
      if (s.plan[i].pieceId !== pieceId || s.results[i]) continue;
      var subject = s.plan[i].sectionId ? sectionById(p, s.plan[i].sectionId) : p;
      if (subject) s.plan[i].estMin = s.plan[i].kind === 'learning' ? TUNING.learningSlotMin : pieceCost(subject);
    }
    save();
  }

  function sessionSummary(today) {
    var s = store.session;
    if (!s) return null;
    today = today || todayISO();

    var rows = [];
    for (var i = 0; i < s.plan.length; i++) {
      var p = pieceById(s.plan[i].pieceId);
      if (!p) continue;
      rows.push({ index: i, piece: p, section: s.plan[i].sectionId ? sectionById(p, s.plan[i].sectionId) : null, kind: s.plan[i].kind, result: s.results[i] || null });
    }
    var played = rows.filter(function (r) { return r.result && !r.result.skipped; });

    var tomorrow = addDays(today, 1);
    var dueTomorrow = reviewUnits().filter(function (p) {
      return isScheduled(p) && p.nextDue && daysBetween(p.nextDue, tomorrow) >= 0;
    });

    return {
      date: s.date,
      rows: rows,
      played: played,
      skipped: rows.filter(function (r) { return r.result && r.result.skipped; }),
      untouched: rows.filter(function (r) { return !r.result; }),
      changes: played.map(function (r) { return r.result.change; }).filter(function (c) {
        return c && (c.enteredRepair || c.leftRepair || c.intervalChanged);
      }),
      deferredCount: s.deferredCount,
      deferredMin: s.deferredMin,
      dueTomorrow: dueTomorrow,
      dueTomorrowMin: dueTomorrow.reduce(function (t, p) { return t + (p.state === 'learning' ? TUNING.learningSlotMin : pieceCost(p)); }, 0)
    };
  }

  function endSession() {
    store.session = null;
    save();
  }

  /* Not a penalty. Records that today was addressed and closes. */
  function skipToday(today) {
    store.settings.lastSessionDate = today || todayISO();
    store.session = null;
    save();
  }

  /* ------------------------------------------------------------------ *
   * Gap detection
   *
   * Counts only days that had a budget, so a normal weekend is never a gap.
   * Intervals are left alone; nothing accumulates; this is a re-ranking, not
   * a debt.
   * ------------------------------------------------------------------ */

  function gapReport(today) {
    today = today || todayISO();
    var last = store.settings.lastSessionDate;
    if (!last) return { show: false, missedDays: 0, calendarDays: 0, pieces: [] };

    var calendar = daysBetween(last, today);
    if (calendar <= 0) return { show: false, missedDays: 0, calendarDays: calendar, pieces: [] };

    var missed = 0;
    for (var i = 1; i <= calendar; i++) {
      if (budgetForDate(addDays(last, i)) > 0) missed++;
    }
    if (missed < TUNING.gapThresholdDays) {
      return { show: false, missedDays: missed, calendarDays: calendar, pieces: [] };
    }

    var overdue = reviewUnits()
      .filter(function (p) { return isDue(p, today) && daysOverdue(p, today) > 0; })
      .sort(function (a, b) { return priority(b, today) - priority(a, today) || cmpId(a, b); });

    return {
      show: true,
      since: last,
      missedDays: missed,       // budgeted days only — the number to display
      calendarDays: calendar,
      pieces: overdue,
      count: overdue.length
    };
  }

  /* ------------------------------------------------------------------ *
   * Capacity
   *
   * Two figures, deliberately.
   *
   *   structural — the standing rate. Every scheduled piece contributes
   *   cost/interval per day, plus the learning block prorated over the days
   *   that actually have a budget. Exact, always available, no history
   *   needed. This is the trend line, and it drives the nudge.
   *
   *   observed — what the last 30 days actually looked like, from the daily
   *   log. This is the evidence, including deferrals.
   * ------------------------------------------------------------------ */

  /* Three separately named quantities. maintenanceLoad is the repertoire's
   * standing cost; learningLoad is the block; totalDemand is their sum and is
   * the only one ever compared against supply. */
  function structuralDemand(today, sessionDaysOverride) {
    today = today || todayISO();
    var maintenance = 0;
    var learners = 0;
    var units = reviewUnits();
    for (var i = 0; i < units.length; i++) {
      var p = units[i];
      if (p.state === 'learning') { learners++; continue; }
      if (MAINTENANCE_STATES.indexOf(p.state) < 0) continue;
      maintenance += pieceCost(p) / Math.max(1, p.intervalDays || 1);
    }
    var perWeek = sessionDaysOverride != null ? sessionDaysOverride : sessionDaysPerWeek();
    var slots = Math.min(learners, store.settings.maxLearning);
    var learning = slots * TUNING.learningSlotMin * (perWeek / 7);
    return {
      maintenanceLoad: maintenance,
      learningLoad: learning,
      totalDemand: maintenance + learning,
      learners: learners
    };
  }

  function logEntryFor(dateISO) {
    var log = store.capacityLog;
    for (var i = log.length - 1; i >= 0; i--) {
      if (log[i].date === dateISO) return log[i];
      if (daysBetween(log[i].date, dateISO) > 0) break;
    }
    return null;
  }

  function logCapacity(built) {
    var existing = logEntryFor(built.date);
    var entry = {
      date: built.date,
      budget: built.budgetMin,
      demand: built.demandMin,
      planned: built.plannedMin,
      actualMin: existing ? num(existing.actualMin, 0) : 0,   // survives a rebuild
      deferredCount: built.deferredCount,
      deferredMin: built.deferredMin
    };
    if (existing) {
      store.capacityLog[store.capacityLog.indexOf(existing)] = entry;
      return;
    }
    store.capacityLog.push(entry);
    if (store.capacityLog.length > TUNING.capacityLogDays) {
      store.capacityLog = store.capacityLog.slice(-TUNING.capacityLogDays);
    }
  }

  /* Minutes actually practised, accumulated as each item is graded. This is
   * what observed supply is measured from — a skipped item contributes
   * nothing, an unopened day contributes nothing. */
  function addActualMinutes(dateISO, minutes) {
    if (!minutes) return;
    var e = logEntryFor(dateISO);
    if (e) { e.actualMin = Math.max(0, num(e.actualMin, 0) + minutes); return; }
    if (minutes < 0) return;               // nothing to subtract from
    store.capacityLog.push({
      date: dateISO, budget: budgetForDate(dateISO), demand: 0, planned: 0,
      actualMin: minutes, deferredCount: 0, deferredMin: 0
    });
  }

  /* Configured budget is a plan, not a measurement. Once the log spans a full
   * window, supply becomes what was actually practised — which counts the
   * weekends that were configured at zero and practised anyway, and equally
   * discounts the weekdays that were configured at 30 and skipped. Until then
   * there is nothing to measure and the configured budget stands in. */
  function observedSupply(today) {
    var log = store.capacityLog;
    if (!log.length) return null;
    var span = daysBetween(log[0].date, today) + 1;
    if (span < TUNING.capacityObservedMinDays) return null;

    var w = TUNING.capacityWindowDays;
    var since = addDays(today, -(w - 1));
    var rows = log.filter(function (e) { return e.date && daysBetween(since, e.date) >= 0; });
    var actual = 0, sessionDays = 0;
    rows.forEach(function (e) {
      var m = num(e.actualMin, 0);
      actual += m;
      if (m > 0) sessionDays++;
    });
    return {
      supplyPerDay: actual / w,
      sessionDaysPerWeek: sessionDays / w * 7,
      totalMin: actual,
      sessionDays: sessionDays,
      spanDays: span
    };
  }

  function capacityReport(today) {
    today = today || todayISO();

    var obs = observedSupply(today);
    var basis = obs ? 'observed' : 'configured';
    var supplyPerDay = obs ? obs.supplyPerDay : weeklyBudget() / 7;
    var sessDays = obs ? obs.sessionDaysPerWeek : sessionDaysPerWeek();
    var demand = structuralDemand(today, sessDays);

    var w = TUNING.capacityWindowDays;
    var since = addDays(today, -(w - 1));
    var win = store.capacityLog.filter(function (e) {
      return e.date && daysBetween(since, e.date) >= 0;
    });
    var sum = function (k) {
      return win.reduce(function (t, e) { return t + num(e[k], 0); }, 0);
    };

    return {
      date: today,
      /* The comparison that matters, and the only one the nudge reads. */
      supplyBasis: basis,
      maintenanceLoadPerDay: demand.maintenanceLoad,
      learningLoadPerDay: demand.learningLoad,
      totalDemandPerDay: demand.totalDemand,
      supplyPerDay: supplyPerDay,
      configuredSupplyPerDay: weeklyBudget() / 7,
      observedSupplyPerDay: obs ? obs.supplyPerDay : null,
      ratio: supplyPerDay > 0 ? demand.totalDemand / supplyPerDay : Infinity,
      headroomPerDay: supplyPerDay - demand.totalDemand,
      over: demand.totalDemand > supplyPerDay,
      observed: {
        daysLogged: win.length,
        windowDays: w,
        spanDays: obs ? obs.spanDays : (store.capacityLog.length ? daysBetween(store.capacityLog[0].date, today) + 1 : 0),
        needsDays: TUNING.capacityObservedMinDays,
        sessionDaysPerWeek: obs ? obs.sessionDaysPerWeek : null,
        meanPractisedPerDay: sum('actualMin') / w,
        meanDeferredPerDay: sum('deferredMin') / w,
        deferredItems: sum('deferredCount')
      },
      weeklyBudget: weeklyBudget(),
      configuredSessionDaysPerWeek: sessionDaysPerWeek()
    };
  }

  /* One nudge, not a nag. Fires once after the structural figure has been
   * over supply continuously for two weeks. Going back under resets the
   * episode, so a genuinely new overrun can speak up again — but the same
   * one never repeats. Mutates settings; callers save(). */
  function capacityNudge(today) {
    today = today || todayISO();
    var w = store.settings.capacityWatch;
    var rep = capacityReport(today);

    if (!rep.over) {
      w.overSince = null;
      w.nudgedFor = null;
      return null;
    }
    if (!w.overSince) { w.overSince = today; return null; }
    if (daysBetween(w.overSince, today) < TUNING.capacityNudgeDays) return null;
    if (w.nudgedFor === w.overSince) return null;

    w.nudgedFor = w.overSince;
    return {
      since: w.overSince,
      totalDemandPerDay: rep.totalDemandPerDay,
      supplyPerDay: rep.supplyPerDay,
      supplyBasis: rep.supplyBasis,
      /* The two levers, named. There is no third. */
      levers: ['pause learning', 'raise the daily budget']
    };
  }

  /* ------------------------------------------------------------------ *
   * Migration and import
   * ------------------------------------------------------------------ */

  function detectFormat(json) {
    if (!json || typeof json !== 'object') return 'unknown';
    if (Array.isArray(json.preludes)) return 'chopin';
    if (Array.isArray(json.pieces)) return 'repertoire';
    return 'unknown';
  }

  function chopinState(rec) {
    if (rec.perf === 'Not yet learned') return 'backlog';
    if (rec.perf === 'New / not solid') return 'learning';
    if (!rec.due || !rec.dlp) return 'backlog';
    return daysBetween(rec.dlp, rec.due) < 7 ? 'consolidating' : 'established';
  }

  /* Builds pieces from the old export. The `int` field is discarded entirely
   * — it disagrees with due - dlp on every record that has both, and appears
   * to lag one grading behind. The interval is derived, which also keeps the
   * nextDue = lastPlayed + intervalDays invariant true on import. The fixed
   * cadences for learning and consolidating take over at the first grading. */
  function migrateChopin(json, today) {
    today = today || todayISO();

    var sectionsByPid = {};
    (json.hotspots || []).forEach(function (h) {
      if (h.ph === true) return;                      // placeholders, not real sections
      var pid = String(h.pid);
      if (!sectionsByPid[pid]) sectionsByPid[pid] = [];
      sectionsByPid[pid].push({
        id: 's' + (sectionsByPid[pid].length + 1),
        label: str(h.desc),
        startBar: null,
        endBar: null,
        fragilityOverride: null,
        lastColdCall: isoOrNull(h.dlp),               // hotspot int/due are untrusted
        failCount: 0
      });
    });

    var pieces = (json.preludes || []).map(function (rec) {
      var state = chopinState(rec);
      var scheduled = state !== 'backlog';
      var duration = CHOPIN_DURATIONS[rec.id] || 1.0;
      var interval = scheduled && rec.dlp && rec.due ? Math.max(1, daysBetween(rec.dlp, rec.due)) : null;

      return normalizePiece({
        id: null,                                     // assigned at commit
        composerId: 'chopin',
        title: 'Prelude in ' + str(rec.key),
        catalogue: 'Op. 28 No. ' + rec.id,
        tier: 0,
        durationMin: duration,
        contentMin: duration,
        fragility: clamp(num(rec.diff, 3), 1, 5),
        priorKnowledge: scheduled ? 'near' : 'new',
        tags: [],
        notes: str(rec.notes),
        state: state,
        intervalDays: interval,
        lastPlayed: isoOrNull(rec.dlp),
        nextDue: scheduled ? isoOrNull(rec.due) : null,
        lapses: 0,
        repairSessions: 0,
        preRepairInterval: null,
        dateFirstLearned: isoOrNull(rec.dfl),
        stateSince: isoOrNull(rec.dlp) || today,
        sections: sectionsByPid[String(rec.id)] || [],
        history: []
        /* rec.dg is dropped. rec.int is discarded. No legacy block. */
      });
    });

    var composers = [{
      id: 'chopin',
      canonicalName: 'Frédéric Chopin',
      era: 'Romantic',
      nationality: 'Polish',
      aliases: []
    }];

    var settings = {};
    if (json.settings && typeof json.settings.onBreak === 'boolean') {
      settings.onBreak = json.settings.onBreak;
    }

    return { pieces: pieces, composers: composers, settings: settings };
  }

  function pieceKey(p) { return p.composerId + '\u0000' + p.catalogue; }

  /* Summary before committing anything. */
  function previewImport(json, today) {
    var format = detectFormat(json);
    if (format === 'unknown') return { format: 'unknown', ok: false };

    if (format === 'repertoire') {
      /* A full export is a restore, not a merge — it replaces state. */
      var s = normalizeState(json);
      return {
        format: 'repertoire',
        ok: true,
        mode: 'replace',
        pieces: s.pieces.length,
        composers: s.composers.length,
        sections: s.pieces.reduce(function (t, p) { return t + p.sections.length; }, 0),
        payload: s
      };
    }

    var mig = migrateChopin(json, today);
    var existing = {};
    store.pieces.forEach(function (p) { existing[pieceKey(p)] = p; });

    var isNew = 0, updated = 0;
    mig.pieces.forEach(function (p) {
      if (existing[pieceKey(p)]) updated++; else isNew++;
    });
    var knownComposers = {};
    store.composers.forEach(function (c) { knownComposers[c.id] = true; });

    return {
      format: 'chopin',
      ok: true,
      mode: 'merge',
      pieces: mig.pieces.length,
      sections: mig.pieces.reduce(function (t, p) { return t + p.sections.length; }, 0),
      composers: mig.composers.length,
      composersAdded: mig.composers.filter(function (c) { return !knownComposers[c.id]; }).length,
      new: isNew,
      updated: updated,
      payload: mig
    };
  }

  function nextPieceId() {
    var max = 0;
    store.pieces.forEach(function (p) {
      var m = /^p(\d+)$/.exec(p.id);
      if (m) max = Math.max(max, +m[1]);
    });
    return 'p' + pad3(max + 1);
  }

  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n); }

  function commitImport(preview, today) {
    if (!preview || !preview.ok) return null;
    today = today || todayISO();

    if (preview.mode === 'replace') {
      store = preview.payload;
      save();
      return { replaced: true, pieces: store.pieces.length };
    }

    var mig = preview.payload;
    var known = {};
    store.composers.forEach(function (c) { known[c.id] = true; });
    mig.composers.forEach(function (c) {
      if (!known[c.id]) { store.composers.push(normalizeComposer(c)); known[c.id] = true; }
    });

    var byKey = {};
    store.pieces.forEach(function (p) { byKey[pieceKey(p)] = p; });

    var added = 0, updated = 0;
    mig.pieces.forEach(function (incoming) {
      var found = byKey[pieceKey(incoming)];
      if (found) {
        /* Update in place, keeping the existing id and accumulated history. */
        var keepId = found.id, keepHistory = found.history;
        var merged = normalizePiece(incoming);
        merged.id = keepId;
        merged.history = keepHistory.concat(merged.history);
        var idx = store.pieces.indexOf(found);
        store.pieces[idx] = merged;
        byKey[pieceKey(merged)] = merged;
        updated++;
      } else {
        var p = normalizePiece(incoming);
        p.id = nextPieceId();
        store.pieces.push(p);
        byKey[pieceKey(p)] = p;
        added++;
      }
    });

    if (mig.settings && typeof mig.settings.onBreak === 'boolean') {
      store.settings.onBreak = mig.settings.onBreak;
    }

    save();
    return { replaced: false, added: added, updated: updated };
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  function exportPayload(today) {
    var out = JSON.parse(JSON.stringify(store));
    out.exportedAt = new Date().toISOString();
    return out;
  }

  /* Stamps lastExportDate optimistically. On iOS a download opens a share
   * sheet and we never learn whether it landed; nagging after a successful
   * export is worse than missing one. */
  function markExported(today) {
    store.settings.lastExportDate = today || todayISO();
    save();
  }

  function exportJSON(today) {
    var text = JSON.stringify(exportPayload(today), null, 2);
    markExported(today);
    return text;
  }

  function exportFilename(today) {
    return 'repertoire-backup-' + (today || todayISO()) + '.json';
  }

  function needsExportReminder(today) {
    today = today || todayISO();
    var last = store.settings.lastExportDate;
    if (!last) return true;
    return daysBetween(last, today) >= TUNING.exportReminderDays;
  }

  function daysSinceExport(today) {
    var last = store.settings.lastExportDate;
    return last ? daysBetween(last, today || todayISO()) : null;
  }

  /* ------------------------------------------------------------------ *
   * Pieces and composers
   * ------------------------------------------------------------------ */

  function pieceById(id) {
    for (var i = 0; i < store.pieces.length; i++) if (store.pieces[i].id === id) return store.pieces[i];
    return null;
  }

  function composerById(id) {
    for (var i = 0; i < store.composers.length; i++) if (store.composers[i].id === id) return store.composers[i];
    return null;
  }

  function composerName(id) {
    var c = composerById(id);
    return c ? c.canonicalName : '';
  }

  /* Matches canonicalName and aliases both — a piece is never stored with a
   * bare composer string, so the Phase 4 join has to survive "Rachmaninov". */
  function searchComposers(query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return store.composers.slice();
    return store.composers.filter(function (c) {
      if (c.canonicalName.toLowerCase().indexOf(q) >= 0) return true;
      for (var i = 0; i < c.aliases.length; i++) {
        if (c.aliases[i].toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    });
  }

  function slugify(name) {
    var base = String(name || '');
    /* Strip diacritics so "Fauré" and "Dvořák" produce usable ids. */
    if (base.normalize) base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return base || 'composer';
  }

  function addComposer(fields) {
    var id = slugify(fields.id || fields.canonicalName);
    var n = 1, candidate = id;
    while (composerById(candidate)) { n++; candidate = id + n; }
    var c = normalizeComposer({
      id: candidate,
      canonicalName: fields.canonicalName,
      era: fields.era,
      nationality: fields.nationality,
      aliases: fields.aliases
    });
    store.composers.push(c);
    save();
    return c;
  }

  function updateComposer(id, fields) {
    var c = composerById(id);
    if (!c) return null;
    ['canonicalName', 'era', 'nationality'].forEach(function (k) {
      if (fields[k] != null) c[k] = str(fields[k]);
    });
    if (Array.isArray(fields.aliases)) c.aliases = fields.aliases.map(function (a) { return str(a); }).filter(Boolean);
    save();
    return c;
  }

  function addPiece(fields, today) {
    today = today || todayISO();
    var p = normalizePiece(fields);
    p.id = nextPieceId();
    if (!p.stateSince) p.stateSince = today;
    if (p.state !== 'backlog' && !p.nextDue) p.nextDue = today;
    store.pieces.push(p);
    save();
    return p;
  }

  /* Field-level edit from the repertoire editor. State changes route through
   * setStateManually so the schedule is always backfilled; fragility changes
   * re-clamp the interval so a lowered cap takes effect immediately. */
  function updatePiece(id, fields, today) {
    var p = pieceById(id);
    if (!p) return null;
    today = today || todayISO();

    if (fields.state != null && fields.state !== p.state) {
      setStateManually(p, fields.state, today);
    }

    var fragilityChanged = fields.fragility != null && num(fields.fragility, p.fragility) !== p.fragility;

    ['composerId', 'title', 'catalogue', 'notes', 'priorKnowledge', 'learningFocus', 'learningAchievement'].forEach(function (k) {
      if (fields[k] != null) p[k] = str(fields[k]);
    });
    if (fields.tier != null) p.tier = clamp(Math.round(num(fields.tier, p.tier)), 0, 3);
    if (fields.durationMin != null) p.durationMin = Math.max(0.1, num(fields.durationMin, p.durationMin));
    if (fields.contentMin != null) p.contentMin = Math.max(0.1, num(fields.contentMin, p.contentMin));
    if (fields.fragility != null) p.fragility = clamp(num(fields.fragility, p.fragility), 1, 5);
    if (Array.isArray(fields.tags)) p.tags = fields.tags.map(function (t) { return str(t); }).filter(Boolean);
    if (fields.learnedPct != null) p.learnedPct = clamp(Math.round(num(fields.learnedPct, p.learnedPct)), 0, 100);
    if (fields.dateFirstLearned !== undefined) p.dateFirstLearned = isoOrNull(fields.dateFirstLearned);
    if (fields.lastPlayed !== undefined) p.lastPlayed = isoOrNull(fields.lastPlayed);

    if (fields.intervalDays !== undefined && p.state !== 'backlog') {
      p.intervalDays = clampInterval(num(fields.intervalDays, p.intervalDays || 1), p.fragility);
      p.nextDue = addDays(p.lastPlayed || today, p.intervalDays);
    }
    if (fields.nextDue !== undefined && p.state !== 'backlog') {
      var nd = isoOrNull(fields.nextDue);
      if (nd) {
        p.nextDue = nd;
        if (p.lastPlayed) p.intervalDays = Math.max(1, daysBetween(p.lastPlayed, nd));
      }
    }

    if (fragilityChanged) { reclampInterval(p, today); prepareSections(p, today); }
    save();
    return p;
  }

  function deletePiece(id) {
    var i = store.pieces.findIndex ? store.pieces.findIndex(function (p) { return p.id === id; }) : -1;
    if (i < 0) { for (var j = 0; j < store.pieces.length; j++) if (store.pieces[j].id === id) { i = j; break; } }
    if (i < 0) return false;
    store.pieces.splice(i, 1);
    /* Drop it from a running session, keeping plan and results aligned. */
    var s = store.session;
    if (s) {
      var plan = [], results = [];
      for (var k = 0; k < s.plan.length; k++) {
        if (s.plan[k].pieceId === id) continue;
        plan.push(s.plan[k]);
        results.push(s.results[k] || null);
      }
      s.plan = plan;
      s.results = results;
      s.index = Math.min(s.index, plan.length);
    }
    save();
    return true;
  }

  function replaceSections(pieceId, sections, today) {
    var p = pieceById(pieceId);
    if (!p) return null;
    var used = {};
    p.sections = sections.filter(function (sec) { return str(sec.label).trim(); }).map(function (raw, i) {
      var sec = normalizeSection(raw, i), n = i + 1;
      while (used[sec.id]) sec.id = 's' + (++n);
      used[sec.id] = true; return sec;
    });
    prepareSections(p, today || todayISO());
    var session = store.session;
    if (session) {
      var plan = [], results = [];
      session.plan.forEach(function (it, i) {
        if (it.pieceId === pieceId && it.sectionId && !sectionById(p, it.sectionId)) return;
        plan.push(it); results.push(session.results[i] || null);
      });
      session.plan = plan; session.results = results;
      session.index = session.finished ? plan.length : results.findIndex(function (r) { return !r; });
      if (session.index < 0) session.index = plan.length;
    }
    save(); return p.sections;
  }

  function addSection(pieceId, label) {
    var p = pieceById(pieceId);
    if (!p) return null;
    var n = 1;
    var used = {};
    p.sections.forEach(function (s) { used[s.id] = true; });
    while (used['s' + n]) n++;
    var s = normalizeSection({ id: 's' + n, label: label }, p.sections.length);
    p.sections.push(s);
    prepareSections(p, todayISO());
    save();
    return s;
  }

  function updateSection(pieceId, sectionId, fields) {
    var p = pieceById(pieceId);
    if (!p) return null;
    for (var i = 0; i < p.sections.length; i++) {
      if (p.sections[i].id === sectionId) {
        var merged = {};
        for (var k in p.sections[i]) merged[k] = p.sections[i][k];
        for (var k2 in fields) merged[k2] = fields[k2];
        p.sections[i] = normalizeSection(merged, i);
        prepareSections(p, todayISO());
        save();
        return p.sections[i];
      }
    }
    return null;
  }

  function deleteSection(pieceId, sectionId) {
    var p = pieceById(pieceId);
    if (!p) return false;
    var before = p.sections.length;
    p.sections = p.sections.filter(function (s) { return s.id !== sectionId; });
    if (p.sections.length === before) return false;
    save();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Repertoire queries
   * ------------------------------------------------------------------ */

  function filterPieces(opts, today) {
    opts = opts || {};
    today = today || todayISO();
    var q = String(opts.search || '').trim().toLowerCase();

    return store.pieces.filter(function (p) {
      if (opts.tier != null && p.tier !== opts.tier) return false;
      if (opts.state && p.state !== opts.state) return false;
      if (opts.composerId && p.composerId !== opts.composerId) return false;
      if (!q) return true;
      var hay = (p.title + ' ' + p.catalogue + ' ' + composerName(p.composerId) + ' ' +
        p.tags.join(' ') + ' ' + p.notes).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function groupByTier(pieces) {
    var groups = [[], [], [], []];
    pieces.forEach(function (p) { groups[p.tier].push(p); });
    return groups.map(function (list, tier) {
      list.sort(function (a, b) {
        var an = composerName(a.composerId), bn = composerName(b.composerId);
        return an < bn ? -1 : an > bn ? 1 : cmpId(a, b);
      });
      return { tier: tier, pieces: list };
    });
  }

  function counts(today) {
    today = today || todayISO();
    var c = { backlog: 0, learning: 0, consolidating: 0, established: 0, repair: 0, due: 0, total: store.pieces.length };
    store.pieces.forEach(function (p) {
      c[p.state] = (c[p.state] || 0) + 1;
      p.sections.forEach(function (sec) { if (sec.enabled && sec.state === 'repair' && MAINTENANCE_STATES.indexOf(p.state) >= 0) c.repair++; });
    });
    c.due = duePool(today).length;
    return c;
  }

  /* ------------------------------------------------------------------ *
   * Seed
   * ------------------------------------------------------------------ */

  function needsSeed() { return store.pieces.length === 0 && store.composers.length === 0; }

  function bootstrapFromSeed(json, today) {
    if (!json) return false;
    today = today || todayISO();
    if (json.version && json.settings) { store = normalizeState(json); save(); return true; }
    (json.composers || []).forEach(function (c) { store.composers.push(normalizeComposer(c)); });
    (json.pieces || []).forEach(function (p) {
      var piece = normalizePiece(p);
      if (!piece.stateSince) piece.stateSince = today;
      store.pieces.push(piece);
    });
    save();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Launch
   *
   * One call that ui.js makes on open. Evaluates the gap line, the capacity
   * nudge and the export reminder, and saves once if anything changed.
   * ------------------------------------------------------------------ */

  function launch(today) {
    today = today || todayISO();

    /* A session left over from another day is stale — its plan was fitted to
     * that day's due list. Grades were committed as they happened, so
     * nothing is lost by dropping it. */
    var dropped = false;
    if (store.session && store.session.date !== today) {
      store.session = null;
      dropped = true;
    }

    var nudge = capacityNudge(today);     // mutates capacityWatch
    if (nudge || dropped) save();

    return {
      today: today,
      weekday: weekdayOf(today),
      budget: budgetForDate(today),
      zeroBudgetDay: budgetForDate(today) === 0,
      recommended: recommendedMinutes(today),
      ideal: idealMinutes(today),
      forecast: loadForecast(today, TUNING.forecastDays),
      counts: counts(today),
      gap: gapReport(today),
      capacity: capacityReport(today),
      nudge: nudge,
      exportReminder: needsExportReminder(today) ? { days: daysSinceExport(today) } : null,
      resumable: store.session,
      storagePersistent: storage.persistent !== false,
      saveError: lastSaveError
    };
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  global.App = {
    TUNING: TUNING,
    CAPS: CAPS,
    STORAGE_KEY: STORAGE_KEY,
    CHOPIN_DURATIONS: CHOPIN_DURATIONS,
    STATES: STATES,
    GRADES: GRADES,

    // state
    load: load,
    save: save,
    state: function () { return store; },
    setState: function (s) { store = normalizeState(s); return store; },
    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (l) { return l !== fn; }); }; },
    normalizeState: normalizeState,
    normalizePiece: normalizePiece,
    saveError: function () { return lastSaveError; },
    storageAvailable: function () { return storage.persistent !== false; },

    // dates
    todayISO: todayISO,
    addDays: addDays,
    daysBetween: daysBetween,
    weekdayOf: weekdayOf,

    // settings
    budgetForDate: budgetForDate,
    budgetForWeekday: budgetForWeekday,
    weeklyBudget: weeklyBudget,
    sessionDaysPerWeek: sessionDaysPerWeek,
    updateSettings: function (fields) {
      var s = store.settings;
      if (fields.targetDailyMinutes != null) s.targetDailyMinutes = Math.max(0, Math.round(num(fields.targetDailyMinutes, s.targetDailyMinutes)));
      if (fields.dailyOverrides) {
        for (var d = 0; d <= 6; d++) {
          if (fields.dailyOverrides[d] === null) delete s.dailyOverrides[d];
          else if (fields.dailyOverrides[d] != null) s.dailyOverrides[d] = Math.max(0, Math.round(num(fields.dailyOverrides[d], 0)));
        }
      }
      if (fields.maxLearning != null) s.maxLearning = Math.max(0, Math.round(num(fields.maxLearning, s.maxLearning)));
      if (fields.onBreak != null) s.onBreak = fields.onBreak === true;
      save();
      return s;
    },

    // scheduler
    capFor: capFor,
    appliedCap: appliedCap,
    clampInterval: clampInterval,
    pieceCost: pieceCost,
    isDue: isDue,
    isScheduled: isScheduled,
    daysOverdue: daysOverdue,
    overdueRatio: overdueRatio,
    priority: priority,
    applyGrade: applyGrade,
    startLearning: function (id, today) { var p = pieceById(id); if (!p) return null; startLearning(p, today); save(); return p; },
    promote: function (id, today) { var p = pieceById(id); if (!p) return null; promote(p, today); save(); return p; },
    suggestsPromotion: suggestsPromotion,

    // session
    buildSession: buildSession,
    recommendedMinutes: recommendedMinutes,
    idealMinutes: idealMinutes,
    loadForecast: loadForecast,
    roundTo5: roundTo5,
    setRandom: function (fn) { rng = typeof fn === 'function' ? fn : Math.random; },
    startSession: startSession,
    currentItem: currentItem,
    itemAt: itemAt,
    gradeCurrent: gradeCurrent,
    setProgressCurrent: setProgressCurrent,
    setLearningCurrent: setLearningCurrent,
    reviewUnits: reviewUnits,
    replaceSections: replaceSections,
    normalizeSection: normalizeSection,
    skipCurrent: skipCurrent,
    recordAt: recordAt,
    undoCurrent: undoCurrent,
    goToIndex: goToIndex,
    stepIndex: stepIndex,
    sessionProgress: sessionProgress,
    finishSession: finishSession,
    refreshPlanEstimate: refreshPlanEstimate,
    recordLearningProgress: recordLearningProgress,
    daysLearning: daysLearning,
    sessionSummary: sessionSummary,
    endSession: endSession,
    skipToday: skipToday,

    // reporting
    gapReport: gapReport,
    capacityReport: capacityReport,
    capacityNudge: capacityNudge,
    structuralDemand: structuralDemand,
    counts: counts,

    // migration / io
    detectFormat: detectFormat,
    migrateChopin: migrateChopin,
    previewImport: previewImport,
    commitImport: commitImport,
    exportJSON: exportJSON,
    exportPayload: exportPayload,
    exportFilename: exportFilename,
    markExported: markExported,
    needsExportReminder: needsExportReminder,
    daysSinceExport: daysSinceExport,

    // pieces / composers
    pieceById: pieceById,
    composerById: composerById,
    composerName: composerName,
    searchComposers: searchComposers,
    addComposer: addComposer,
    updateComposer: updateComposer,
    addPiece: addPiece,
    updatePiece: updatePiece,
    deletePiece: deletePiece,
    addSection: addSection,
    updateSection: updateSection,
    deleteSection: deleteSection,
    filterPieces: filterPieces,
    groupByTier: groupByTier,

    // seed / launch
    needsSeed: needsSeed,
    bootstrapFromSeed: bootstrapFromSeed,
    launch: launch
  };

  load();

})(typeof globalThis !== 'undefined' ? globalThis : this);
