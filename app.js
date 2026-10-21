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
    repairSessionsToExit: 3,       // clean checks on distinct days to leave repair
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
    capacityObservedMinDays: 30,   // history window for supporting statistics
    capacityLogDays: 90            // how much daily log to retain
  };

  /* Interval caps by fragility. Validated against 18 months of real data —
   * do not change. Fractional fragility interpolates linearly between rows. */
  var CAPS = { 1: 20, 2: 16, 3: 14, 4: 11, 5: 8 };

  var STORAGE_KEY = 'repertoire.v1';
  var STATE_VERSION = 3;

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

  function normalizeTechnique(raw) {
    if(!raw||!isValidISO(raw.nextDue))return null;
    return {nextDue:raw.nextDue,lastChecked:isoOrNull(raw.lastChecked),cleanDates:Array.isArray(raw.cleanDates)?raw.cleanDates.filter(isValidISO):[],minutes:Math.max(.25,num(raw.minutes,3))};
  }
  function normalizeSpacing(raw) {
    if(!raw)return null;
    return {interval:Math.max(1,num(raw.interval,3)),cleanDates:Array.isArray(raw.cleanDates)?raw.cleanDates.filter(isValidISO):[],proven:Array.isArray(raw.proven)?raw.proven.filter(function(n){return Number.isFinite(n)&&n>=1&&n<=60;}):[],resume:raw.resume==null?null:Math.max(1,num(raw.resume,1))};
  }
  function normalizeSection(raw, index) {
    raw = raw || {};
    return {
      id: str(raw.id) || 's' + ((index || 0) + 1), label: str(raw.label),
      startBar: raw.startBar == null || raw.startBar === '' ? null : Math.max(1, num(raw.startBar, 1)),
      endBar: raw.endBar == null || raw.endBar === '' ? null : Math.max(1, num(raw.endBar, 1)),
      fragilityOverride: raw.fragilityOverride == null || raw.fragilityOverride === '' ? null : clamp(num(raw.fragilityOverride, 3), 1, 5),
      durationMin: Math.max(0.25, num(raw.durationMin, 1)),
      practiceMinutes: raw.practiceMinutes == null || raw.practiceMinutes === '' ? null : Math.max(0.25, num(raw.practiceMinutes, 1)),
      practiceDifficulty: raw.practiceDifficulty == null || raw.practiceDifficulty === '' ? null : clamp(num(raw.practiceDifficulty, 3), 1, 5),
      intervalCapDays: raw.intervalCapDays == null || raw.intervalCapDays === '' ? null : clamp(Math.round(num(raw.intervalCapDays, 14)), 1, 60),
      prompt: oneOf(raw.prompt, ['start', 'transition', 'recover'], 'start'),
      notes: str(raw.notes), enabled: raw.enabled !== false,
      technique:normalizeTechnique(raw.technique),
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
      type: oneOf(raw.type, ['maintenance', 'learning', 'coldcall', 'technical'], 'maintenance'),
      grade: oneOf(raw.grade, GRADES, null)
    };
    /* Learning sessions record percent complete rather than a grade — the
     * three grades describe a finished piece and say nothing useful about
     * one that is a third written into the hands. */
    if (raw.pct != null) e.pct = clamp(Math.round(num(raw.pct, 0)), 0, 100);
    if (raw.sectionId) e.sectionId = str(raw.sectionId);
    ['focus', 'achievement', 'nextFocus', 'stateBefore', 'note', 'updateId', 'issue'].forEach(function (k) { if (raw[k] != null) e[k] = str(raw[k]); });
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
      practiceDifficulty: clamp(num(raw.practiceDifficulty, num(raw.fragility, 3)), 1, 5),
      practiceMinutes: raw.practiceMinutes == null || raw.practiceMinutes === '' ? null : Math.max(.25,num(raw.practiceMinutes,1)),
      priorKnowledge: oneOf(raw.priorKnowledge, ['new', 'played', 'near'], 'new'),
      tags: Array.isArray(raw.tags) ? raw.tags.map(function (t) { return str(t); }).filter(Boolean) : [],
      notes: str(raw.notes),
      learningFocus: str(raw.learningFocus),
      learningAchievement: str(raw.learningAchievement),
      sectionFirst: raw.sectionFirst === true,
      sectionsStarted: isoOrNull(raw.sectionsStarted),
      maxSectionsPerDay: clamp(Math.round(num(raw.maxSectionsPerDay, 2)), 1, 6),
      intervalCapDays: raw.intervalCapDays == null || raw.intervalCapDays === '' ? null : clamp(Math.round(num(raw.intervalCapDays, 14)), 1, 60),
      consolidatingIntervalDays: clamp(Math.round(num(raw.consolidatingIntervalDays, 3)), 1, 20),
      consolidationCadenceSince: isoOrNull(raw.consolidationCadenceSince),
      spacing:normalizeSpacing(raw.spacing),technique:normalizeTechnique(raw.technique),
      focusedMinutes: raw.focusedMinutes == null || raw.focusedMinutes === '' ? null : Math.max(0.5, num(raw.focusedMinutes, 5)),
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
      targetDailyMinutes: 45,
      /* Sparse: only weekdays that differ from the target. 0 = Sunday.
       * A 0 means "no session expected", not "closed" — the app still
       * offers to practise, and gap detection skips these days. */
      dailyOverrides: { 0: 0, 6: 0 },
      maxLearning: 2,
      lastSessionDate: null,
      lastExportDate: null,
      onBreak: false,
      warmupMinutes: 2,
      scaleStep: null,
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
        demandDriven: s.demandDriven === true,
        balancedPlanning: s.balancedPlanning === true,
        performancePlanning: s.performancePlanning === true,
        learningEnabled: s.learningEnabled !== false,
        learningMinutes: Math.max(1,num(s.learningMinutes,10)),
        targetDailyMinutes: Math.max(0, Math.round(num(s.targetDailyMinutes, d.targetDailyMinutes))),
        dailyOverrides: overrides,
        maxLearning: Math.max(0, Math.round(num(s.maxLearning, d.maxLearning))),
        lastSessionDate: isoOrNull(s.lastSessionDate),
        /* null means "never exported". Stamped on first save so the 14-day
         * reminder starts from first use rather than firing on day one. */
        lastExportDate: isoOrNull(s.lastExportDate),
        onBreak: s.onBreak === true,
        breakSince: isoOrNull(s.breakSince),
        breaks: Array.isArray(s.breaks) ? s.breaks.filter(function (b) { return isoOrNull(b.start); }) : [],
        skippedDate: isoOrNull(s.skippedDate),
        warmupMinutes: clamp(num(s.warmupMinutes, 2), 0, 5),
        scaleStep: s.scaleStep == null ? null : Math.max(0, Math.floor(num(s.scaleStep,0))),
        capacityWatch: {
          overSince: isoOrNull(watch.overSince),
          nudgedFor: isoOrNull(watch.nudgedFor)
        }
      },
      reviewAssignments: raw.reviewAssignments && typeof raw.reviewAssignments === 'object' ? Object.fromEntries(Object.entries(raw.reviewAssignments).filter(function(pair){return isValidISO(pair[1]);})) : {},
      practiceTimes: Array.isArray(raw.practiceTimes) ? raw.practiceTimes.filter(function(x){return x && typeof x.id==='string' && isValidISO(x.date) && Number.isFinite(x.minutes) && x.minutes>=0;}) : [],
      appliedUpdates: Array.isArray(raw.appliedUpdates) ? raw.appliedUpdates.filter(function (id) { return typeof id === 'string'; }) : [],
      composers: Array.isArray(raw.composers) ? raw.composers.map(normalizeComposer).filter(function (c) { return c.id; }) : [],
      pieces: Array.isArray(raw.pieces) ? raw.pieces.map(normalizePiece).filter(function (p) { return p.id; }) : [],
      session: raw.session && typeof raw.session === 'object' ? normalizeSession(raw.session) : null,
      sessionArchive: Array.isArray(raw.sessionArchive) ? raw.sessionArchive.map(normalizeSession).filter(Boolean) : [],
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
        kind: oneOf(it.kind, ['learning', 'maintenance', 'lookahead', 'continuity', 'technical'], 'maintenance'),
        title: str(it.title), composer: str(it.composer), sectionLabel: str(it.sectionLabel),
        estMin: num(it.estMin, 0)
      };
    }).filter(function (it) { return it.pieceId; });

    /* results is index-aligned with plan — results[i] is null until item i
     * has been recorded. That is what lets the session be navigated in any
     * order and any item re-recorded in place. */
    var results = new Array(plan.length);
    var src = Array.isArray(raw.results) ? raw.results : [];
    for (var i = 0; i < plan.length; i++) {
      results[i] = src[i] || null;
      if (results[i] && !results[i].date) results[i].date = isoOrNull(raw.date);
    }

    return {
      id: str(raw.id) || 'session-' + str(raw.date) + '-' + str(raw.startedAt),
      mode: oneOf(raw.mode, ['normal', 'extra', 'manual'], 'normal'),
      continued: raw.continued === true,
      warmup: raw.warmup && typeof raw.warmup === 'object' ? raw.warmup : null,
      date: isoOrNull(raw.date),
      budgetMin: Math.max(0, num(raw.budgetMin, 0)),
      plan: plan,
      index: clamp(Math.round(num(raw.index, 0)), 0, plan.length),
      results: results,
      deferredCount: Math.max(0, Math.round(num(raw.deferredCount, 0))),
      deferredMin: Math.max(0, num(raw.deferredMin, 0)),
      startedAt: isoOrNull(raw.startedAt),
      finished: raw.finished === true,
      paused: raw.paused === true,
      timers: raw.timers && typeof raw.timers === 'object' ? Object.fromEntries(Object.entries(raw.timers).filter(function(pair){return /^(\d+|warmup)$/.test(pair[0])&&pair[1];}).map(function(pair){var t=pair[1];return [pair[0],{elapsedMs:Math.max(0,num(t.elapsedMs,0)),runningSince:null,checkpoint:null,started:t.started===true,finished:t.finished===true}];})) : {},
      learningDraft: raw.learningDraft && typeof raw.learningDraft === 'object' ? raw.learningDraft : null
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
  function appliedCap(fragility, override) {
    return override == null ? Math.max(1, Math.round(capFor(fragility))) : clamp(Math.round(override), 1, 60);
  }

  function clampInterval(days, fragility, override) {
    return Math.max(1, Math.min(Math.round(days), appliedCap(fragility, override)));
  }

  /* Injectable so sim.js can run reproducibly. */
  var rng = Math.random;

  /* Jitter is applied to the already-capped interval, not to the raw product.
   * Applied before the cap it would be erased for every piece sitting at its
   * cap — which is precisely the cohort most likely to be in lockstep. After
   * the cap it can only shorten those pieces, which is what breaks them up.
   * The cost is a slight downward bias at the cap, a percent or two of extra
   * load, paid to stop 14 preludes coming due on the same morning forever. */
  function jitterInterval(days, fragility, override) {
    var j = TUNING.intervalJitter;
    if (!j) return clampInterval(days, fragility, override);
    var capped = clampInterval(days, fragility, override);
    var varied = capped * (1 + (rng() * 2 - 1) * j);
    return clampInterval(varied, fragility, override);
  }

  function prepareSections(p, today) {
    p.sections.forEach(function (sec, i) {
      sec.inheritedDifficulty = p.practiceDifficulty;
      sec.fragility = sec.fragilityOverride == null ? p.fragility : sec.fragilityOverride;
      var capped = clampInterval(sec.intervalDays, sec.fragility, sec.intervalCapDays);
      if (capped !== sec.intervalDays && sec.lastPlayed) sec.nextDue = addDays(sec.lastPlayed, capped);
      sec.intervalDays = capped;
      if (!sec.stateSince) sec.stateSince = today;
      if (!sec.nextDue) sec.nextDue = addDays(today, 1 + (i % 3));
    });
  }

  function sectionById(p, id) {
    return p && p.sections.filter(function (sec) { return sec.id === id; })[0] || null;
  }

  function practiceDay(date, offset) {
    // With no configured practice days, use calendar days so manual practice
    // remains possible. A break never fabricates a successful review.
    if (!sessionDaysPerWeek()) return addDays(date, offset);
    while (budgetForDate(date) <= 0) date = addDays(date, 1);
    while (offset-- > 0) {
      do { date = addDays(date, 1); } while (budgetForDate(date) <= 0);
    }
    return date;
  }

  function sectionPassed(p, sec) {
    var grades = sec.history.filter(function (h) {
      return h.type!=='technical' && (!h.issue||h.issue==='memory') && h.grade && h.date && (!p.sectionsStarted || h.date >= p.sectionsStarted);
    });
    return !!grades.length && grades[grades.length - 1].grade === 'clean';
  }

  function sectionProgress(p) {
    var active = p.sections.filter(function (sec) { return sec.enabled; });
    var passed = active.filter(function (sec) { return sectionPassed(p, sec); }).length;
    return {passed:passed, total:active.length, ready:active.length > 0 && passed === active.length};
  }

  function beginSections(p, today) {
    if (!p.sectionFirst) return;
    p.sectionsStarted = today;
    p.sections.filter(function (sec) { return sec.enabled; }).forEach(function (sec, i) {
      sec.state = 'consolidating'; sec.stateSince = today;
      sec.intervalDays = 3; sec.repairSessions = 0; sec.preRepairInterval = null;
      // Two groups per week apart: first pair now, next pair two practice
      // days later, last pair four practice days later.
      sec.nextDue = practiceDay(today, Math.floor(i / p.maxSectionsPerDay) * 2);
    });
  }

  function firstWholeDue(p) {
    var last = p.sections.filter(function (sec) { return sec.enabled; }).reduce(function (date, sec) {
      return sec.lastPlayed && sec.lastPlayed > date ? sec.lastPlayed : date;
    }, p.sectionsStarted || todayISO());
    return practiceDay(addDays(last, 1), 0);
  }

  function sectionSlotsLeft(p, today) {
    var played = p.sections.filter(function (sec) { return reviewedOn(sec, today); }).length;
    return Math.max(0, p.maxSectionsPerDay - played);
  }

  function spreadSections(pool, today) {
    var used = {};
    return pool.filter(function (unit) {
      var parent = unit.parentPieceId && pieceById(unit.parentPieceId);
      if (!parent || !parent.sectionFirst) return true;
      var n = used[parent.id] || 0;
      if (n >= sectionSlotsLeft(parent, today)) return false;
      used[parent.id] = n + 1;
      return true;
    });
  }

  function reviewUnits() {
    var units = [];
    store.pieces.forEach(function (p) {
      if (p.sectionFirst && p.state === 'learning') {
        if (sectionProgress(p).ready) {
          units.push(Object.assign({}, p, {state:'consolidating', nextDue:firstWholeDue(p),
            intervalDays:p.consolidatingIntervalDays || 7}));
        }
      } else units.push(p);
      if (MAINTENANCE_STATES.indexOf(p.state) < 0 && !(p.sectionFirst && p.state === 'learning')) return;
      p.sections.forEach(function (sec) {
        if (!sec.enabled) return;
        var unit = Object.assign({}, sec);
        unit.id = p.id + '::' + sec.id;
        unit.parentPieceId = p.id; unit.sectionId = sec.id;
        unit.fragility = sec.fragilityOverride == null ? p.fragility : sec.fragilityOverride;
        units.push(unit);
      });
    });
    return units.map(function(u){
      if(u.technique&&u.state!=='repair'&&u.technique.nextDue<u.nextDue)return Object.assign({},u,{technicalCheck:true,nextDue:u.technique.nextDue,lastPlayed:u.technique.lastChecked,intervalDays:2,practiceMinutes:u.technique.minutes});
      return u;
    });
  }

  function reviewItem(unit, kind) {
    return { pieceId: unit.parentPieceId || unit.id, sectionId: unit.sectionId || null,
      piece: unit.parentPieceId ? pieceById(unit.parentPieceId) : unit,
      kind: unit.technicalCheck?'technical':kind, estMin: pieceCost(unit) };
  }

  function cleanDatesSinceFailure(p) {
    var dates = [];
    p.history.forEach(function (h) {
      if (!h.date || h.type==='technical' || h.issue==='technical-slip' || h.issue==='technical-problem' || h.issue==='effort' || (p.stateSince && h.date < p.stateSince)) return;
      if (h.grade === 'broke') dates = [];
      else if (h.grade === 'clean' && !h.early && dates.indexOf(h.date) < 0) dates.push(h.date);
    });
    return dates;
  }

  function pieceCost(p) {
    if (p.practiceMinutes) return p.practiceMinutes;
    if ((p.state === 'repair' || p.state === 'consolidating') && p.focusedMinutes) return p.focusedMinutes;
    var difficulty=p.practiceDifficulty==null?(p.inheritedDifficulty==null?p.fragility:p.inheritedDifficulty):p.practiceDifficulty;
    return p.durationMin * (store.settings.demandDriven && difficulty>=4 ? 3 : TUNING.maintenanceCostFactor);
  }

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
  function applyGrade(p, grade, today, issue) {
    grade = oneOf(grade, GRADES, 'wobbled');
    today = today || todayISO();

    issue=oneOf(issue,['memory','effort','technical-slip','technical-problem'],'memory');
    var before = { state: p.state, intervalDays: p.intervalDays };
    var hadTechnique=!!p.technique;
    var early = !!(p.nextDue && today < p.nextDue);
    var elapsed = p.lastPlayed ? daysBetween(p.lastPlayed, today) : null;
    p.history.push({ date: today, type: historyType(p.state), grade: grade,
      elapsedDays: elapsed, intervalBefore: p.intervalDays, early: early, stateBefore: p.state, issue:issue });
    p.lastPlayed = today;

    if(issue!=='memory') {
      // A finger slip or effortful success is not a memory lapse.
      if(issue==='technical-problem')p.technique={nextDue:addDays(today,2),lastChecked:today,cleanDates:[],minutes:Math.min(3,pieceCost(p))};
      if(issue==='effort'&&p.spacing)p.spacing.cleanDates=[];
      p.nextDue=addDays(today,p.intervalDays||1);
    } else switch (p.state) {
      case 'learning':
        /* Daily, fixed slot. Grades are recorded but do not move the
         * schedule — promotion out of learning is manual only. */
        p.intervalDays = TUNING.learningIntervalDays;
        p.nextDue = addDays(today, p.intervalDays);
        break;

      case 'consolidating':
        /* Fixed 3-day cadence. Does not enter repair: a piece that is not
         * yet established has nothing to fall back to. */
        if(store.settings.balancedPlanning&&!store.settings.performancePlanning&&p.practiceDifficulty<=2&&grade==='broke'){p.consolidatingIntervalDays=1;p.consolidationCadenceSince=today;}
        if(easySpacing(p))advanceSpacing(p,grade,today,elapsed,hadTechnique);
        p.intervalDays = p.consolidatingIntervalDays || TUNING.consolidatingIntervalDays;
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
            p.intervalDays = jitterInterval(base * TUNING.repairIntervalFactor, p.fragility, p.intervalCapDays);
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
          var capped = appliedCap(p.fragility, p.intervalCapDays);
          if (early && grade === 'clean') {
            p.intervalDays = clampInterval(current, p.fragility, p.intervalCapDays);
          } else if (grade === 'clean') {
            /* Math.round(1 * 1.4) === 1, so without a floor of one extra day
             * an interval of 1 is an absorbing state: a piece that has
             * ratcheted down through repeated lapses can never climb out of
             * it, and is played daily forever. Clean must always buy at
             * least a day while there is headroom under the cap. */
            var target = Math.max(current + 1, Math.round(current * TUNING.cleanMultiplier));
            p.intervalDays = jitterInterval(target, p.fragility, p.intervalCapDays);
            if (p.intervalDays <= current && current < capped) {
              p.intervalDays = Math.min(current + 1, capped);
            }
          } else {
            // An uncertain recall never earns a longer interval.
            p.intervalDays = clampInterval(current, p.fragility, p.intervalCapDays);
          }
          p.nextDue = addDays(today, p.intervalDays);
        }
        break;

      default:
        /* backlog — not schedulable. Grade is recorded, schedule untouched. */
        break;
    }

    if(issue==='memory'&&grade==='clean'&&hadTechnique)checkTechnique(p,'clean',today,false);
    if(issue==='memory'&&grade==='broke')p.technique=null;
    return {
      pieceId: p.id,
      grade: grade, issue:issue,
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

  function gradeSection(parent, sec, grade, today, issue) {
    sec.fragility = sec.fragilityOverride == null ? parent.fragility : sec.fragilityOverride;
    var ch = applyGrade(sec, grade, today, issue);
    var h = sec.history[sec.history.length - 1];
    h.type = 'coldcall'; h.sectionId = sec.id;
    sec.lastColdCall = today;
    if ((!issue||issue==='memory')&&grade === 'broke') {
      sec.failCount++;
      if (ch.from.state === 'consolidating') {
        sec.preRepairInterval = ch.from.intervalDays;
        sec.lapses++; sec.repairSessions = 0;
        setPieceState(sec, 'repair', today); sec.intervalDays = 1; sec.nextDue = addDays(today, 1);
        ch.enteredRepair = true;
      }
    } else if ((!issue||issue==='memory')&&sec.state === 'consolidating' && grade === 'clean' && cleanDatesSinceFailure(sec).length >= 2) {
      setPieceState(sec, 'established', today);
    }
    ch.pieceId = parent.id; ch.sectionId = sec.id;
    ch.to = { state: sec.state, intervalDays: sec.intervalDays }; ch.nextDue = sec.nextDue;
    return ch;
  }

  function easySpacing(p){return store.settings.performancePlanning&&p.state==='consolidating'&&p.practiceDifficulty!=null&&p.practiceDifficulty<=2&&!p.sectionFirst;}
  function advanceSpacing(p,grade,today,elapsed,hadTechnique){
    var current=p.consolidatingIntervalDays||3, ladder=[1,2,3,5,7,10,14];
    var t=p.spacing;if(!t||t.interval!==current)t=p.spacing={interval:current,cleanDates:[],proven:t?t.proven:[],resume:null};
    function change(n){t.interval=n;t.cleanDates=[];p.consolidatingIntervalDays=n;}
    function shorter(){var proven=t.proven.filter(function(n){return n<current;});return proven.length?Math.max.apply(null,proven):(ladder.filter(function(n){return n<current;}).slice(-1)[0]||1);}
    if(grade==='broke'){var resume=shorter();change(1);t.resume=resume;return;}
    if(grade==='wobbled'){change(shorter());t.resume=null;return;}
    if(hadTechnique||elapsed==null||elapsed<current)return;
    if(t.resume!=null){var resume=t.resume;t.resume=null;change(resume);return;}
    if(t.cleanDates.indexOf(today)<0)t.cleanDates.push(today);
    if(t.cleanDates.length<2)return;
    if(t.proven.indexOf(current)<0)t.proven.push(current);
    var cap=Math.min(14,appliedCap(p.fragility,p.intervalCapDays));
    var next=ladder.find(function(n){return n>current&&n<=cap;});
    if(next)change(next);
  }
  function checkTechnique(p,grade,today,record){
    var t=p.technique;if(!t)return;
    if(record)p.history.push({date:today,type:'technical',grade:grade,issue:'technical-problem'});
    if(grade==='clean'){if(t.cleanDates.indexOf(today)<0)t.cleanDates.push(today);}else t.cleanDates=[];
    t.lastChecked=today;
    if(t.cleanDates.length>=2)p.technique=null;else t.nextDue=addDays(today,2);
  }
  function enablePerformanceSpacing(today){
    today=today||todayISO();var id='performance-spacing-20261021';
    if(needsSeed()||store.appliedUpdates.indexOf(id)>=0)return false;
    store.settings.performancePlanning=true;store.reviewAssignments={};
    store.pieces.forEach(function(p){
      if(p.composerId!=='chopin'||['Op. 28 No. 4','Op. 28 No. 6','Op. 28 No. 7','Op. 28 No. 13'].indexOf(p.catalogue)<0||p.state!=='consolidating')return;
      var last=p.history.filter(function(h){return h.grade&&h.type!=='technical';}).slice(-1)[0];
      if(last&&last.grade!=='clean')return; // Keep a newer phone failure's schedule.
      p.consolidatingIntervalDays=3;p.intervalDays=3;p.nextDue=addDays(p.lastPlayed||today,3);
      p.spacing={interval:3,cleanDates:[],proven:[],resume:null};
    });
    store.appliedUpdates.push(id);save();return true;
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
    beginSections(p, today);
    return p;
  }

  function promote(p, today) {
    today = today || todayISO();
    if (p.state === 'learning') {
      if (p.sectionFirst) return p; // first complete run starts consolidation
      setPieceState(p, 'consolidating', today);
      p.intervalDays = p.consolidatingIntervalDays || TUNING.consolidatingIntervalDays;
      p.nextDue = addDays(today, p.intervalDays);
    } else if (p.state === 'consolidating') {
      setPieceState(p, 'established', today);
      p.intervalDays = p.sectionFirst ? clampInterval(p.intervalDays || 7, p.fragility, p.intervalCapDays) : TUNING.firstEstablishedInterval;
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
    if (p.sectionFirst && p.state === 'learning' && next !== 'backlog' && next !== 'learning') return p;

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
        beginSections(p, today);
        break;
      case 'consolidating':
        if (!p.dateFirstLearned) p.dateFirstLearned = today;
        p.intervalDays = p.consolidatingIntervalDays || TUNING.consolidatingIntervalDays;
        p.nextDue = today;
        break;
      case 'established':
        if (!p.dateFirstLearned) p.dateFirstLearned = today;
        p.intervalDays = clampInterval(p.intervalDays || TUNING.firstEstablishedInterval, p.fragility, p.intervalCapDays);
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
    var capped = clampInterval(p.intervalDays, p.fragility, p.intervalCapDays);
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
    if(store.settings.demandDriven && !store.settings.learningEnabled)return [];
    return store.pieces
      .filter(function (p) { return p.state === 'learning' && !p.sectionFirst && !reviewedOn(p, today); })
      .sort(function (a, b) { return priority(b, today) - priority(a, today) || cmpId(a, b); });
  }

  function cmpId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  function duePool(today) {
    return spreadSections(reviewUnits()
      .filter(function (p) { return MAINTENANCE_STATES.indexOf(p.state) >= 0 && isDue(p, today) && !reviewedOn(p, today); })
      .sort(function (a, b) {
        if (a.parentPieceId && a.parentPieceId === b.parentPieceId) {
          var parent = pieceById(a.parentPieceId);
          if (parent.sectionFirst && parent.state === 'learning') {
            var attempted = function (sec) { return sec.history.some(function (h) { return h.grade && h.date >= parent.sectionsStarted; }); };
            var unseen = Number(attempted(a)) - Number(attempted(b));
            if (unseen) return unseen;
            var difference = Number(sectionPassed(parent, a)) - Number(sectionPassed(parent, b));
            if (difference) return difference;
          }
        }
        /* repair outranks everything, then priority, then longer pieces
         * first so ties never systematically favour the short ones. */
        var ar = a.state === 'repair' ? 1 : 0, br = b.state === 'repair' ? 1 : 0;
        if (ar !== br) return br - ar;
        var d = priority(b, today) - priority(a, today);
        if (Math.abs(d) > 1e-9) return d;
        if (b.durationMin !== a.durationMin) return b.durationMin - a.durationMin;
        return cmpId(a, b);
      }), today);
  }

  /* Projected minutes per day for the week ahead. Naive by design: it assumes
   * every piece is played on its due date and keeps its current interval. Over
   * seven days that is close enough to see a heavy Monday coming, which is all
   * it is for. Overdue pieces are projected onto today. */
  function loadForecast(today, days) {
    if(store.settings.demandDriven)return weekPlan(today,days || 7,false);
    today = today || todayISO();
    days = days || TUNING.forecastDays;

    var buckets = {}, order = [], sectionBookings = {};
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
      var parent = p.parentPieceId ? pieceById(p.parentPieceId) : p;
      var guard = 0;
      while (daysBetween(d, horizon) >= 0 && guard++ < 400) {
        if (parent.sectionFirst) {
          d = practiceDay(d, 0);
          if (p.sectionId) {
            while ((sectionBookings[parent.id + ':' + d] || 0) >=
                (d === today ? sectionSlotsLeft(parent,today) : parent.maxSectionsPerDay)) {
              d = practiceDay(addDays(d,1),0);
            }
            var key = parent.id + ':' + d;
            sectionBookings[key] = (sectionBookings[key] || 0) + 1;
          }
        }
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
        if (p.sectionFirst || p.sectionId || reviewedOn(p, today)) return false; // no early section probes or repeated same-day reviews
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

  function reviewedOn(subject, today) {
    return (subject.history || []).some(function (h) { return h.date === today && h.type!=='technical'; });
  }

  function orderForWarmup(items) {
    if(store.settings.demandDriven)return orderForPractice(items);
    return items.sort(function (a,b) {
      var ap = a.piece || pieceById(a.pieceId), bp = b.piece || pieceById(b.pieceId);
      var as = a.sectionId && sectionById(ap, a.sectionId), bs = b.sectionId && sectionById(bp, b.sectionId);
      var d = (as && as.practiceDifficulty || (ap ? ap.practiceDifficulty : 3)) -
        (bs && bs.practiceDifficulty || (bp ? bp.practiceDifficulty : 3));
      if (d) return d;
      if (a.pieceId === b.pieceId && !!a.sectionId !== !!b.sectionId) return a.sectionId ? -1 : 1;
      return cmpId(ap || {id:a.pieceId}, bp || {id:b.pieceId});
    });
  }

  var SCALE_KEYS = ['C major','A minor','G major','E minor','D major','B minor',
    'A major','F-sharp minor','E major','C-sharp minor','B major','G-sharp minor',
    'F-sharp major','E-flat minor','D-flat major','B-flat minor','A-flat major','F minor',
    'E-flat major','C minor','B-flat major','G minor','F major','D minor'];

  function scaleAtStep(step) {
    step = Math.max(0,Math.floor(num(step,0)));
    var keyIndex = step % SCALE_KEYS.length, key = SCALE_KEYS[keyIndex];
    var form = ['natural','harmonic','melodic'][(Math.floor(keyIndex / 2) + Math.floor(step / 24)) % 3];
    return key.indexOf('minor') >= 0 ? key.replace('minor',form + ' minor') : key;
  }

  function nextScaleStep() {
    if (store.settings.scaleStep != null) return store.settings.scaleStep;
    // Continue after the last scale actually completed in the earlier app.
    var completed = store.sessionArchive.concat(store.session ? [store.session] : []).map(function (s) { return s.warmup; })
      .filter(function (w) { return w && w.status === 'done'; })
      .sort(function (a,b) { return String(a.date || '').localeCompare(String(b.date || '')); });
    if (!completed.length) return 0;
    var last = completed[completed.length - 1];
    if (last.step != null) return last.step + 1;
    var key = String(last.scale).replace(/ (natural|harmonic|melodic) minor$/, ' minor');
    var index = SCALE_KEYS.indexOf(key);
    return index < 0 ? 0 : index + 1;
  }

  function warmupForDate(today, minutes) {
    var step = nextScaleStep();
    return {scale:scaleAtStep(step), step:step, minutes:minutes, status:minutes > 0 ? 'pending' : 'skipped', date:today};
  }

  function syncPendingWarmup() {
    var w = store.session && store.session.warmup;
    if (w && w.status === 'pending') {
      w.step = nextScaleStep(); w.scale = scaleAtStep(w.step);
    }
  }

  function markWarmup(done, today) {
    var s = store.session;
    if (!s || !s.warmup || s.warmup.status !== 'pending') return;
    if(store.settings.demandDriven){checkpointTimer(true);var t=currentTimer(false);if(t){t.finished=done;storeTiming(t);}}
    var completedStep = s.warmup.step == null ? nextScaleStep() : s.warmup.step;
    s.warmup.status = done ? 'done' : 'skipped'; s.warmup.date = today || todayISO();
    if (done) {
      store.settings.scaleStep = completedStep + 1;
      if(!store.settings.demandDriven)addActualMinutes(s.warmup.date, s.warmup.minutes); store.settings.lastSessionDate = s.warmup.date;
    }
    save();
  }

  function archiveSession() {
    if(store.settings.demandDriven)checkpointTimer(true);
    var s = store.session;
    if (!s) return;
    var copy = JSON.parse(JSON.stringify(s));
    copy.finished = true; copy.paused = false;
    // Old snapshots cannot safely undo later sessions or manual corrections.
    copy.results.forEach(function (r) { if (r) { delete r.snapshot; r.locked = true; } });
    var at = store.sessionArchive.findIndex(function (x) { return x.id === copy.id; });
    if (at >= 0) store.sessionArchive[at] = copy; else store.sessionArchive.push(copy);
    store.session = null;
  }

  function planEntry(it) {
    var p = it.piece || pieceById(it.pieceId), sec = p && it.sectionId ? sectionById(p,it.sectionId) : null;
    return {pieceId:it.pieceId, sectionId:it.sectionId || null, kind:it.kind, estMin:it.estMin,
      title:p ? p.title : it.title, composer:p ? composerName(p.composerId) : it.composer,
      sectionLabel:sec ? sec.label : ''};
  }

  function createSession(built, today, mode) {
    archiveSession();
    store.session = {id:'session-' + Date.now() + '-' + Math.random().toString(36).slice(2,8),
      date:today, budgetMin:built.budgetMin, plan:built.items.map(planEntry), index:0,
      results:new Array(built.items.length), deferredCount:built.deferredCount || 0,
      deferredMin:built.deferredMin || 0, startedAt:today, finished:false, paused:false,
      learningDraft:null, mode:mode || 'normal', warmup:built.warmup || warmupForDate(today,0)};
    store.settings.skippedDate = null;
    logCapacity(built); save();
  }

  function unfinishedItems(old) {
    if (!old || old.continued) return [];
    return old.plan.filter(function (it,i) { return !old.results[i] || old.results[i].skipped; }).map(function (it) {
      var p = pieceById(it.pieceId), sec = p && it.sectionId ? sectionById(p,it.sectionId) : null;
      if (!p || !isScheduled(p) || (it.sectionId && (!sec || sec.enabled === false))) return null;
      var subject = sec || p;
      if ((subject.history || []).some(function (h) { return h.date && h.date >= old.date; })) return null;
      if (p.sectionFirst && !sec && p.state === 'learning' && !sectionProgress(p).ready) return null;
      return {pieceId:p.id,piece:p,sectionId:sec ? sec.id : null,kind:p.state === 'learning' && !p.sectionFirst ? 'learning' : 'maintenance',
        estMin:p.state === 'learning' && !p.sectionFirst ? TUNING.learningSlotMin : pieceCost(subject)};
    }).filter(Boolean);
  }

  function resumeClosed(id, today) {
    today = today || todayISO();
    var old = store.sessionArchive.find(function (s) { return s.id === id; });
    var items = unfinishedItems(old);
    var used = {};
    items = items.filter(function (it) {
      var p = it.piece;
      if (!p.sectionFirst || !it.sectionId) return true;
      var n = used[p.id] || 0;
      if (n >= sectionSlotsLeft(p,today)) return false;
      used[p.id] = n + 1; return true;
    });
    if (!items.length) return false;
    if (store.settings.onBreak) setBreak(false,today);
    var total = items.reduce(function (n,it) { return n + it.estMin; },0);
    createSession({items:orderForWarmup(items),budgetMin:total,plannedMin:total,demandMin:total},today,'normal');
    if (old.learningDraft && items.some(function (it) { return it.pieceId === old.learningDraft.pieceId; })) store.session.learningDraft = old.learningDraft;
    old.continued = true; save(); return true;
  }

  function startPieceSession(id, today) {
    today = today || todayISO();
    var p = pieceById(id);
    if (!p || !isScheduled(p)) return false;
    if (store.settings.onBreak) setBreak(false,today);
    if (p.sectionFirst && p.state === 'learning') {
      var items = duePool(today).filter(function (unit) { return unit.parentPieceId === p.id || unit.id === p.id; }).map(function (unit) { return reviewItem(unit,'maintenance'); });
      if (!items.length) return false;
      var total = items.reduce(function (n,it) { return n + it.estMin; },0);
      createSession({items:orderForWarmup(items),budgetMin:total,plannedMin:total,demandMin:total},today,'manual');
      return true;
    }
    var it = {pieceId:p.id,piece:p,kind:p.state === 'learning' ? 'learning' : 'continuity',
      estMin:p.state === 'learning' ? (store.settings.demandDriven?store.settings.learningMinutes:TUNING.learningSlotMin) : pieceCost(p)};
    createSession({items:[it],budgetMin:it.estMin,plannedMin:it.estMin,demandMin:it.estMin},today,'manual');
    return true;
  }

  function practiceLog(date) {
    date = date || todayISO();
    var rows = [];
    store.pieces.forEach(function (p) {
      function collect(subject, sec) {
        (subject.history || []).forEach(function (h) {
          if (h.date !== date) return;
          rows.push({pieceId:p.id,sectionId:sec?sec.id:null,title:p.title,composer:composerName(p.composerId),section:sec ? sec.label : '',
            grade:h.grade, type:h.type, issue:h.issue, detail:h.achievement || h.focus || h.note || '', date:h.date});
        });
      }
      collect(p,null); p.sections.forEach(function (sec) { collect(sec,sec); });
    });
    store.sessionArchive.concat(store.session ? [store.session] : []).forEach(function (s) {
      if (s.warmup && s.warmup.status === 'done' && s.warmup.date === date) {
        var timing=store.practiceTimes.find(function(t){return t.id===s.id+':warmup';});
        rows.unshift({timingId:timing&&timing.id,title:s.warmup.scale,composer:'Scale warmup',type:'warmup',detail:timing?Math.round(timing.minutes*10)/10+' min measured':s.warmup.minutes+' min (estimate)',date:date});
      }
    });
    var measured={};
    store.practiceTimes.filter(function(t){return t.date===date&&t.minutes>0;}).forEach(function(t){
      if(rows.some(function(r){return r.timingId===t.id;}))return;
      var key=t.pieceId+':'+(t.sectionId||'')+':'+(t.kind==='technical'?'technical':'review');
      if(!measured[key])measured[key]={minutes:0,finished:true,sample:t};
      measured[key].minutes+=t.minutes;measured[key].finished=measured[key].finished&&t.finished;
    });
    Object.keys(measured).forEach(function(key){
      var group=measured[key],t=group.sample;
      var detail=(group.minutes<.05?'<0.1':Math.round(group.minutes*10)/10)+' min measured'+(group.finished?'':' · stopped partway');
      var row=rows.find(function(r){return r.pieceId===t.pieceId&&(r.sectionId||null)===(t.sectionId||null)&&(r.type==='technical')===(t.kind==='technical');});
      if(row){row.detail+=(row.detail?' · ':'')+detail;return;}
      var p=pieceById(t.pieceId),sec=p&&t.sectionId?sectionById(p,t.sectionId):null;
      rows.push({pieceId:t.pieceId,title:p?p.title:t.state==='warmup'?'Scale warmup':'Removed piece',composer:p?composerName(p.composerId):'',section:sec?sec.label:'',type:'timed',detail:detail,date:t.date});
    });
    return rows;
  }

  function saveLearningDraft(draft) {
    if (!store.session) return;
    store.session.learningDraft = draft; save();
  }

  function inBreak(date) {
    var s = store.settings;
    return (s.onBreak && s.breakSince && date >= s.breakSince) || s.breaks.some(function (b) { return date >= b.start && date < b.end; });
  }

  function setBreak(on, today) {
    today = today || todayISO();
    if (on === store.settings.onBreak) return;
    if (on) { archiveSession(); store.settings.breakSince = today; }
    else {
      if (store.settings.breakSince) store.settings.breaks.push({start:store.settings.breakSince,end:today});
      store.settings.breakSince = null; store.settings.skippedDate = null;
      store.settings.capacityWatch = {overSince:null,nudgedFor:null};
    }
    store.settings.onBreak = on; save();
  }

  /* Fits a session to `minutes`. Does not mutate state. */
  function buildSession(minutes, today, options) {
    if(store.settings.demandDriven)return buildDemandSession(today,options);
    today = today || todayISO();
    options = options || {};
    var totalBudget = Math.max(0, num(minutes, 0));
    var alreadyWarmedUp = options.extra && practiceLog(today).some(function (r) { return r.type === 'warmup'; });
    var warmup = warmupForDate(today, alreadyWarmedUp ? 0 : Math.min(store.settings.warmupMinutes, totalBudget));
    minutes = Math.max(0, totalBudget - warmup.minutes);

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
    var belowTarget = totalBudget < reference;
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
    if (!options.extra && !stoppedOnBudget && spent < minutes) {
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

    var continuityItems = [];
    if (options.extra && !deferred.length && spent < minutes) {
      var chosen = maintenanceItems.concat(learningItems).filter(function (it) { return !it.sectionId; }).map(function (it) { return it.pieceId; });
      store.pieces.filter(function (p) {
        return (p.state === 'established' || p.state === 'consolidating') && !reviewedOn(p, today) && chosen.indexOf(p.id) < 0;
      }).sort(function (a,b) {
        return String(a.lastPlayed || '').localeCompare(String(b.lastPlayed || '')) || cmpId(a,b);
      }).forEach(function (p) {
        var cost = p.durationMin * TUNING.maintenanceCostFactor;
        if (spent + cost <= minutes) { var it = reviewItem(p, 'continuity'); it.estMin = cost; continuityItems.push(it); spent += cost; }
      });
    }
    var deferredMin = deferred.reduce(function (t, p) { return t + pieceCost(p); }, 0);
    /* Demand is what today asked for at full strength — the learning block
     * at its unyielded size, plus everything due. Yielding a slot reduces the
     * plan, never the demand. */
    var fullLearning = Math.min(learners.length, maxL) * TUNING.learningSlotMin;

    return {
      date: today,
      budgetMin: totalBudget,
      warmup: warmup,
      continuity: continuityItems,
      referenceMin: reference,
      belowTarget: belowTarget,
      learning: learningItems,
      maintenance: maintenanceItems,
      lookahead: lookaheadItems,
      /* Select by urgency, then play from easier to harder. Keep section
       * checks ahead of the same whole piece, before it primes recall. */
      items: orderForWarmup(maintenanceItems.concat(lookaheadItems, learningItems, continuityItems)),
      plannedMin: spent + warmup.minutes,
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
    if(store.settings.demandDriven)return buildDemandSession(today,{}).plannedMin;
    today = today || todayISO();
    var learners = Math.min(learningCandidates(today).length, store.settings.maxLearning);
    return learners * TUNING.learningSlotMin +
      duePool(today).reduce(function (t, p) { return t + pieceCost(p); }, 0);
  }

  /* The figure offered as the default tap. Still capped so a heavy day never
   * proposes something absurd — but idealMinutes is shown beside it whenever
   * the two differ, so the cap hides nothing. */
  function recommendedMinutes(today) {
    if(store.settings.demandDriven)return Math.ceil(idealMinutes(today));
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

  function startSession(minutes, today, options) {
    today = today || todayISO();
    if (store.settings.onBreak) return null;
    var built = buildSession(minutes, today, options);
    createSession(built,today,options && options.extra ? 'extra' : 'normal');
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
      consolidatingIntervalDays:p.consolidatingIntervalDays,consolidationCadenceSince:p.consolidationCadenceSince,
      technique:p.technique?JSON.parse(JSON.stringify(p.technique)):null,spacing:p.spacing?JSON.parse(JSON.stringify(p.spacing)):null,
      historyLen: p.history.length
    };
  }

  function restorePiece(p, snap) {
    if (!snap) return;
    if(snap.technique!==undefined)p.technique=snap.technique?JSON.parse(JSON.stringify(snap.technique)):null;
    if(snap.spacing!==undefined)p.spacing=snap.spacing?JSON.parse(JSON.stringify(snap.spacing)):null;
    if(snap.consolidatingIntervalDays!==undefined)p.consolidatingIntervalDays=snap.consolidatingIntervalDays;
    if(snap.consolidationCadenceSince!==undefined)p.consolidationCadenceSince=snap.consolidationCadenceSince;
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
    if (!r || r.locked) return false;
    var p = pieceById(r.pieceId);
    if (p) { var target = r.sectionId ? sectionById(p, r.sectionId) : p; if (target) restorePiece(target, r.snapshot); }
    if (!r.skipped) addActualMinutes(r.date || s.date, -num(r.countedMin, 0));
    s.results[i] = null;
    return true;
  }

  /* Record (or re-record) item i. `payload` is {grade} or {pct} or {skip}. */
  function recordAt(i, payload) {
    var s = store.session;
    if (!s) return null;
    var it = itemAt(i);
    if (!it) return null;

    if (s.results[i] && s.results[i].locked) return null;
    if (it.piece.sectionFirst && it.piece.state === 'learning' && !it.section && !sectionProgress(it.piece).ready) return null;
    clearResultAt(i);                       // re-recording never stacks
    var p = it.piece;
    var snap = snapshotPiece(it.subject);
    var result = { date: s.date, pieceId: p.id, sectionId: it.section ? it.section.id : null, snapshot: snap, countedMin: 0 };

    if (payload.skip) {
      /* Skipping is never a failure: no history entry, no lapse, no state
       * change. A maintenance item stays due, as the brief specifies. A
       * learning item moves to tomorrow — leaving it due today would just
       * have it reappear in the same session. */
      result.skipped = true;
      result.grade = null;
      result.pct = null;
      result.change = null;
      if (p.state === 'learning' && !p.sectionFirst) {
        p.nextDue = addDays(s.date, 1);
        result.pushed = true;
      }
    } else if(it.kind==='technical'){
      result.grade=oneOf(payload.grade,GRADES,'wobbled');result.issue='technical-problem';result.technical=true;
      checkTechnique(it.subject,result.grade,s.date,true);
      result.change={pieceId:p.id,grade:result.grade,enteredRepair:false,leftRepair:false,intervalChanged:false};
    } else if (!it.section && !p.sectionFirst && (it.kind === 'learning' || p.state === 'learning')) {
      var pr = payload.pct != null ? recordLearningProgress(p, payload.pct, s.date) : recordLearningNote(p, payload, s.date);
      result.skipped = false;
      result.grade = null;
      result.pct = pr.pct;
      result.learning = true; result.achievement = pr.achievement; result.nextFocus = pr.nextFocus;
      result.change = pr;
      result.countedMin = store.settings.demandDriven ? 0 : it.estMin;
    } else {
      if (!it.section && p.sectionFirst && p.state === 'learning') {
        setPieceState(p, 'consolidating', s.date);
        p.intervalDays = p.consolidatingIntervalDays; p.nextDue = s.date;
      }
      var ch = it.section ? gradeSection(p, it.section, payload.grade, s.date,payload.issue) : applyGrade(p, payload.grade, s.date,payload.issue);
      result.skipped = false;
      result.grade = ch.grade;result.issue=ch.issue;
      result.pct = null;
      result.change = ch;
      result.countedMin = store.settings.demandDriven ? 0 : it.estMin;
    }

    if (!payload.skip) store.settings.lastSessionDate = s.date;
    if (result.countedMin) addActualMinutes(s.date, result.countedMin);
    if(store.settings.demandDriven)result.finished=!!payload.skip;
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
    for (k = i + 1; k < n; k++) if (!s.results[k] || s.results[k].finished===false) { s.index = k; return; }
    for (k = 0; k < n; k++) if (!s.results[k] || s.results[k].finished===false) { s.index = k; return; }
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
  function setLearningCurrent(payload) {
    var r = recordCurrent(payload || {});
    if (store.session) { store.session.learningDraft = null; save(); }
    return r;
  }
  function setProgressCurrent(pct) { return recordCurrent({ pct: pct }); }
  function skipCurrent() {
    if(store.settings.demandDriven)checkpointTimer(true);
    var r = recordCurrent({ skip: true });
    return r ? pieceById(r.pieceId) : null;
  }

  function goToIndex(i) {
    if(store.settings.demandDriven)checkpointTimer(true);
    var s = store.session;
    if (!s) return false;
    s.index = clamp(Math.round(i), 0, s.plan.length);
    s.finished = false; s.paused = false;
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
    if(done&&store.settings.demandDriven){var t=currentTimer(false);if(t){t.finished=false;storeTiming(t);}}
    if (done) save();
    return done;
  }

  function sessionProgress() {
    var s = store.session;
    if (!s) return null;
    var recorded = 0;
    for (var i = 0; i < s.results.length; i++) if (s.results[i] && s.results[i].finished!==false) recorded++;
    return {
      recorded: recorded,
      total: s.plan.length,
      remaining: s.plan.length - recorded,
      allRecorded: recorded === s.plan.length
    };
  }

  function pauseSession(draft) {
    if(store.settings.demandDriven)checkpointTimer(true);
    var s = store.session;
    if (!s) return;
    if (draft) s.learningDraft = draft;
    s.paused = true; save();
  }

  function resumeSession(today, index) {
    var s = store.session;
    if (!s) return null;
    today = today || todayISO();
    if (s.date !== today) {
      checkpointTimer(true);
      s.results.forEach(function (r) { if (r && !r.date) r.date = s.date; });
      s.date = today;
    }
    s.paused = false; s.finished = false;
    if (index != null) s.index = clamp(Math.round(index), 0, s.plan.length);
    else {
      s.index = s.results.findIndex(function (r) { return !r || r.finished===false; });
      if (s.index < 0) s.index = s.plan.length;
    }
    if(store.settings.demandDriven)startTimer();
    save(); return s;
  }

  /* Closing a session preserves recorded work and unfinished items. */
  function finishSession() {
    if(store.settings.demandDriven)checkpointTimer(true);
    var s = store.session;
    if (!s) return;
    s.finished = true; s.paused = false;
    s.index = s.plan.length;
    archiveSession(); save();
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
      if (subject) s.plan[i].estMin = s.plan[i].kind === 'learning' ? (store.settings.demandDriven?store.settings.learningMinutes:TUNING.learningSlotMin) : pieceCost(subject);
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
    archiveSession();
    save();
  }

  /* Not a penalty. Records that today was addressed and closes. */
  function skipToday(today) {
    store.settings.skippedDate = today || todayISO();
    archiveSession();
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
      if (budgetForDate(addDays(last, i)) > 0 && !inBreak(addDays(last,i))) missed++;
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
      budget: built.budgetMin + (existing ? num(existing.budget,0) : 0),
      demand: Math.max(built.demandMin || 0, existing ? num(existing.demand,0) : 0),
      planned: built.plannedMin + (existing ? num(existing.planned,0) : 0),
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

  /* Supporting history statistics. The capacity comparison always uses
   * the configured budget; completed practice is not available capacity. */
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
    if(store.settings.demandDriven) {
      var week=weekPlan(today,7,false), days=week.filter(function(d){return d.practiceDay;}).length;
      var sum=function(k){return week.reduce(function(n,d){return n+d[k];},0);};
      var since=addDays(today||todayISO(),-6);
      return {totalWeekly:sum('projectedMin'),totalPerPracticeDay:days?sum('projectedMin')/days:null,
        maintenancePerPracticeDay:days?sum('maintenanceMin')/days:null,
        learningPerPracticeDay:days?sum('learningMin')/days:null,configuredSessionDaysPerWeek:days,
        warmupPerPracticeDay:days?sum('warmupMin')/days:null,
        allowanceWeekly:sum('allowanceMin'),
        measuredWeekly:store.practiceTimes.filter(function(t){return t.date>=since&&t.date<=(today||todayISO());}).reduce(function(n,t){return n+t.minutes;},0),
        ratio:null,over:false};
    }
    today = today || todayISO();

    var obs = observedSupply(today);
    var basis = 'configured';
    var supplyPerDay = weeklyBudget() / 7;
    var sessDays = sessionDaysPerWeek();
    var demand = structuralDemand(today, sessDays);
    var warmupWeekly = store.settings.warmupMinutes * sessDays;
    var totalWeekly = demand.totalDemand * 7 + warmupWeekly;

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
      totalDemandPerDay: totalWeekly / 7,
      warmupLoadPerDay: warmupWeekly / 7,
      maintenancePerPracticeDay: sessDays ? demand.maintenanceLoad * 7 / sessDays : null,
      learningPerPracticeDay: sessDays ? demand.learningLoad * 7 / sessDays : null,
      warmupPerPracticeDay: sessDays ? store.settings.warmupMinutes : null,
      totalPerPracticeDay: sessDays ? totalWeekly / sessDays : null,
      budgetPerPracticeDay: sessDays ? weeklyBudget() / sessDays : null,
      totalWeekly: totalWeekly,
      supplyPerDay: supplyPerDay,
      configuredSupplyPerDay: weeklyBudget() / 7,
      observedSupplyPerDay: obs ? obs.supplyPerDay : null,
      ratio: supplyPerDay > 0 ? totalWeekly / weeklyBudget() : null,
      headroomPerDay: supplyPerDay - totalWeekly / 7,
      over: totalWeekly > weeklyBudget(),
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
    if(store.settings.demandDriven)return null;
    today = today || todayISO();
    var w = store.settings.capacityWatch;
    var rep = capacityReport(today);

    if (!rep.configuredSessionDaysPerWeek || !rep.over) {
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
      totalPerPracticeDay: rep.totalPerPracticeDay,
      budgetPerPracticeDay: rep.budgetPerPracticeDay,
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
    if (json.format === 'repertoire-practice-update' && Array.isArray(json.plays)) return 'practice-update';
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

  function previewPracticeUpdate(json, today) {
    today = today || todayISO();
    if (!str(json.id) || !json.plays.length || json.plays.length > 200) return {ok:false};
    var plays = [], missing = [], invalid = false;
    json.plays.forEach(function (raw) {
      if (!raw || !isoOrNull(raw.date) || raw.date > today || !str(raw.catalogue)) { invalid = true; return; }
      var matches = store.pieces.filter(function (p) { return p.composerId === raw.composerId && p.catalogue === raw.catalogue; });
      if (matches.length !== 1) { missing.push(raw.catalogue); return; }
      var fields = raw.fields || {};
      if (fields.state != null && STATES.indexOf(fields.state) < 0) { invalid = true; return; }
      plays.push({pieceId: matches[0].id, date: raw.date, note: str(raw.note), fields: fields});
    });
    return {format:'practice-update', mode:'practice-update', ok: !invalid && !missing.length,
      missing: missing, id: json.id, alreadyApplied: store.appliedUpdates.indexOf(json.id) >= 0,
      pieces: Array.from(new Set(plays.map(function (e) { return e.pieceId; }))).length,
      plays: plays.length, payload: plays.sort(function (a,b) { return a.date.localeCompare(b.date); })};
  }

  function commitPracticeUpdate(preview) {
    if (store.appliedUpdates.indexOf(preview.id) >= 0) return {alreadyApplied:true};
    preview.payload.forEach(function (entry) {
      var p = pieceById(entry.pieceId), f = entry.fields;
      if (!p) return;
      var newer = p.lastPlayed && p.lastPlayed > entry.date;
      // Add evidence only if a whole-piece record for this date is absent.
      if (!p.history.some(function (h) { return h.date === entry.date && !h.sectionId; })) {
        p.history.push({date:entry.date, type:historyType(p.state), grade:null, note:entry.note, updateId:preview.id});
        p.history.sort(function (a,b) { return String(a.date).localeCompare(String(b.date)); });
      }
      if (newer && !Object.keys(f).length) return;
      if (f.state) setStateManually(p, f.state, entry.date);
      if (f.consolidatingIntervalDays != null) p.consolidatingIntervalDays = clamp(Math.round(num(f.consolidatingIntervalDays, 3)),1,20);
      if (f.focusedMinutes != null) p.focusedMinutes = Math.max(0.5,num(f.focusedMinutes,5));
      if (isoOrNull(f.dateFirstLearned)) p.dateFirstLearned = f.dateFirstLearned;
      if (str(f.removeExactNote) && p.notes.trim() === f.removeExactNote) p.notes = '';
      if (str(f.practiceNote) && p.notes.indexOf(f.practiceNote) < 0) p.notes += (p.notes ? '\n' : '') + f.practiceNote;
      if (!newer) p.lastPlayed = entry.date;
      if (p.state === 'consolidating') p.intervalDays = p.consolidatingIntervalDays;
      else if (p.state === 'learning' || p.state === 'repair') p.intervalDays = 1;
      if (isScheduled(p)) p.nextDue = addDays(p.lastPlayed, p.intervalDays || 3);
    });
    var latest = preview.payload[preview.payload.length - 1].date;
    if (!store.settings.lastSessionDate || store.settings.lastSessionDate < latest) store.settings.lastSessionDate = latest;
    store.appliedUpdates.push(preview.id);
    // Discard only the old plan: recorded grades remain in piece history.
    // Prevent an old session snapshot from undoing this correction later.
    store.session = null;
    save(); return {updated:preview.pieces, plays:preview.plays};
  }

  /* Summary before committing anything. */
  function previewImport(json, today) {
    var format = detectFormat(json);
    if (format === 'unknown') return { format: 'unknown', ok: false };
    if (format === 'practice-update') return previewPracticeUpdate(json, today);

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

    if (preview.mode === 'practice-update') return commitPracticeUpdate(preview);
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

    if (fields.sectionFirst != null) p.sectionFirst = fields.sectionFirst === true;
    if (fields.maxSectionsPerDay != null) p.maxSectionsPerDay = clamp(Math.round(num(fields.maxSectionsPerDay,2)),1,6);
    if (fields.intervalCapDays !== undefined) p.intervalCapDays = fields.intervalCapDays === '' || fields.intervalCapDays === null ? null : clamp(Math.round(num(fields.intervalCapDays,14)),1,60);
    if (fields.state != null && fields.state !== p.state) {
      setStateManually(p, fields.state, today);
    }

    var fragilityChanged = fields.fragility != null && num(fields.fragility, p.fragility) !== p.fragility;

    ['composerId', 'title', 'catalogue', 'notes', 'priorKnowledge', 'learningFocus', 'learningAchievement'].forEach(function (k) {
      if (fields[k] != null) p[k] = str(fields[k]);
    });
    if(fields.practiceMinutes !== undefined)p.practiceMinutes=fields.practiceMinutes===''||fields.practiceMinutes==null?null:Math.max(.25,num(fields.practiceMinutes,1));
    if (fields.practiceDifficulty != null) p.practiceDifficulty = clamp(num(fields.practiceDifficulty,3),1,5);
    if (fields.tier != null) p.tier = clamp(Math.round(num(fields.tier, p.tier)), 0, 3);
    if (fields.durationMin != null) p.durationMin = Math.max(0.1, num(fields.durationMin, p.durationMin));
    if (fields.contentMin != null) p.contentMin = Math.max(0.1, num(fields.contentMin, p.contentMin));
    if (fields.fragility != null) p.fragility = clamp(num(fields.fragility, p.fragility), 1, 5);
    if (Array.isArray(fields.tags)) p.tags = fields.tags.map(function (t) { return str(t); }).filter(Boolean);
    if (fields.consolidatingIntervalDays != null) p.consolidatingIntervalDays = clamp(Math.round(num(fields.consolidatingIntervalDays, 3)), 1, 20);
    if (fields.focusedMinutes !== undefined) p.focusedMinutes = fields.focusedMinutes === '' || fields.focusedMinutes === null ? null : Math.max(0.5, num(fields.focusedMinutes, 5));
    if (fields.learnedPct != null) p.learnedPct = clamp(Math.round(num(fields.learnedPct, p.learnedPct)), 0, 100);
    if (fields.dateFirstLearned !== undefined) p.dateFirstLearned = isoOrNull(fields.dateFirstLearned);
    if (fields.lastPlayed !== undefined) p.lastPlayed = isoOrNull(fields.lastPlayed);

    if (fields.intervalDays !== undefined && p.state !== 'backlog') {
      p.intervalDays = clampInterval(num(fields.intervalDays, p.intervalDays || 1), p.fragility, p.intervalCapDays);
      p.nextDue = addDays(p.lastPlayed || today, p.intervalDays);
    }
    if (fields.nextDue !== undefined && p.state !== 'backlog') {
      var nd = isoOrNull(fields.nextDue);
      if (nd) {
        p.nextDue = nd;
        if (p.lastPlayed) p.intervalDays = Math.max(1, daysBetween(p.lastPlayed, nd));
      }
    }

    if (p.state === 'consolidating' && fields.consolidatingIntervalDays != null) {
      p.intervalDays = p.consolidatingIntervalDays; p.nextDue = addDays(p.lastPlayed || today, p.intervalDays);
    }
    if (store.session && store.session.learningDraft && store.session.learningDraft.pieceId === id && fields.learningFocus != null) store.session.learningDraft.focus = p.learningFocus;
    if (store.session) store.session.results.forEach(function (r) { if (r && r.pieceId === id) r.locked = true; });
    if (store.session) store.session.plan.forEach(function (it,i) { if (it.pieceId === id && !store.session.results[i]) {
      it.kind = p.state === 'learning' && !p.sectionFirst && !it.sectionId ? 'learning' : it.kind === 'learning' ? 'maintenance' : it.kind;
    }});
    if (fragilityChanged || fields.intervalCapDays !== undefined) { reclampInterval(p, today); prepareSections(p, today); }
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
      var existing = sectionById(p, sec.id);
      if (p.sectionFirst && p.state === 'learning' && p.sectionsStarted === (today || todayISO()) &&
          existing && !existing.history.some(function (h) { return h.date >= p.sectionsStarted; }) &&
          sec.stateSince !== p.sectionsStarted) {
        sec.state = existing.state; sec.stateSince = existing.stateSince;
        sec.intervalDays = existing.intervalDays; sec.nextDue = existing.nextDue;
      }
      while (used[sec.id]) sec.id = 's' + (++n);
      used[sec.id] = true; return sec;
    });
    prepareSections(p, today || todayISO());
    if (p.sectionFirst && p.state === 'learning' && !p.sectionsStarted) beginSections(p, today || todayISO());
    var session = store.session;
    if (session) {
      var current = session.plan[session.index];
      var plan = [], results = [];
      session.plan.forEach(function (it, i) {
        if (it.pieceId === pieceId && it.sectionId && !sectionById(p, it.sectionId)) return;
        plan.push(it); results.push(session.results[i] || null);
      });
      session.plan = plan; session.results = results;
      session.index = session.finished ? plan.length : plan.indexOf(current);
      if (session.index < 0) session.index = results.findIndex(function (r) { return !r; });
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

  /* One-time correction of the supplied catalogue. Never replaces practice state. */
  function correctCatalogue() {
    var correction = {"id": "catalogue-completion-20261013", "composers": [{"id": "zhangzhao", "canonicalName": "Zhang Zhao", "aliases": []}, {"id": "hensel", "canonicalName": "Fanny Hensel", "aliases": ["Fanny Mendelssohn"]}], "pieces": [{"id": "p077", "composerId": "zhangzhao", "title": "Forest Meditation", "catalogue": "", "tier": 1, "durationMin": 2, "contentMin": 2, "fragility": 3, "priorKnowledge": "new", "tags": [], "state": "backlog", "sections": []}, {"id": "p078", "composerId": "hensel", "title": "September", "catalogue": "Das Jahr", "tier": 2, "durationMin": 3, "contentMin": 3, "fragility": 3, "priorKnowledge": "new", "tags": [], "state": "backlog", "sections": []}, {"id": "p079", "composerId": "chopin", "title": "Waltz in D-flat major", "catalogue": "Op. 64 No. 1", "tier": 3, "durationMin": 2, "contentMin": 2, "fragility": 3, "priorKnowledge": "new", "tags": [], "state": "backlog", "sections": []}, {"id": "p080", "composerId": "chopin", "title": "Waltz in A-flat major", "catalogue": "Op. 64 No. 3", "tier": 3, "durationMin": 3, "contentMin": 3, "fragility": 3, "priorKnowledge": "new", "tags": [], "state": "backlog", "sections": []}, {"id": "p081", "composerId": "chopin", "title": "Waltz in C-sharp minor", "catalogue": "Op. 64 No. 2", "tier": 3, "durationMin": 3.5, "contentMin": 3.5, "fragility": 3, "priorKnowledge": "new", "tags": [], "state": "backlog", "sections": []}], "durations": [{"composerId": "bach", "catalogue": "Goldberg Variations BWV 988", "title": "Aria", "durationMin": 3}, {"composerId": "scarlatti", "catalogue": "K. 466", "title": "Sonata in F minor", "durationMin": 3}, {"composerId": "joplin", "catalogue": "", "title": "Solace", "durationMin": 2.5}, {"composerId": "prokofiev", "catalogue": "Op. 22", "title": "Visions fugitives No. 15", "durationMin": 1}]};
    if (store.appliedUpdates.indexOf(correction.id) >= 0 || needsSeed()) return false;
    var composerIds = {};
    correction.composers.forEach(function (incoming) {
      var names = [incoming.canonicalName].concat(incoming.aliases).map(slugify);
      var existing = store.composers.find(function (c) {
        return c.id === incoming.id || [c.canonicalName].concat(c.aliases).some(function (name) { return names.indexOf(slugify(name)) >= 0; });
      });
      if (!existing) { existing = normalizeComposer(incoming); store.composers.push(existing); }
      composerIds[incoming.id] = existing.id;
    });
    function matchingPiece(incoming) {
      var cid = composerIds[incoming.composerId] || incoming.composerId;
      var candidates = store.pieces.filter(function (p) { return p.composerId === cid; });
      var catalogueMatches = incoming.catalogue ? candidates.filter(function (p) { return p.catalogue === incoming.catalogue; }) : [];
      if (catalogueMatches.length === 1) return catalogueMatches[0];
      return candidates.find(function (p) { return slugify(p.title) === slugify(incoming.title); });
    }
    correction.pieces.forEach(function (incoming) {
      if (matchingPiece(incoming)) return;
      var p = normalizePiece(incoming);
      p.id = nextPieceId();
      p.composerId = composerIds[p.composerId] || p.composerId;
      store.pieces.push(p);
    });
    correction.durations.forEach(function (incoming) {
      var p = matchingPiece(incoming);
      if (!p) return;
      p.durationMin = incoming.durationMin;
      p.contentMin = incoming.durationMin;
      refreshPlanEstimate(p.id);
    });
    store.appliedUpdates.push(correction.id);
    save();
    return true;
  }

  function correctPreludeStates() {
    var id = 'preludes-status-20261014';
    if (store.appliedUpdates.indexOf(id) >= 0) return false;
    var pieces = store.pieces.filter(function (p) { return p.composerId === 'chopin' && /^Op\. 28 No\. \d+$/.test(p.catalogue); });
    if (!pieces.some(function (p) { return p.lastPlayed || p.history.length; })) return false;
    archiveSession();
    pieces.forEach(function (p) {
      if (p.lastPlayed && p.lastPlayed > '2026-10-14') return; // preserve evidence recorded after this correction was requested
      var n = +p.catalogue.split('No. ')[1];
      if ([4,6,7].indexOf(n) >= 0) p.practiceDifficulty = 1;
      if (n === 13) p.practiceDifficulty = 2;
      if ([4,6,7,13].indexOf(n) >= 0) {
        setPieceState(p,'consolidating','2026-10-14'); p.consolidatingIntervalDays = 1; p.intervalDays = 1;
      } else if (n !== 16) {
        var was = p.state; setPieceState(p,'established','2026-10-14');
        p.intervalDays = clampInterval(was === 'established' ? p.intervalDays || 3 : Math.max(3,p.intervalDays || 3),p.fragility);
        p.repairSessions = 0; p.preRepairInterval = null;
      } else if (p.state !== 'repair') {
        p.preRepairInterval = p.intervalDays || 3; p.repairSessions = 0;
        setPieceState(p,'repair','2026-10-14'); p.intervalDays = 1;
      }
      if (n !== 16) p.focusedMinutes = null;
      p.nextDue = p.lastPlayed ? addDays(p.lastPlayed,p.intervalDays) : '2026-10-14';
      var obsolete = ['Not yet started','Currently learning (~1/3 complete)',
        'Focused practice after the break. Allow five minutes; return to normal maintenance when ready.'];
      p.notes = p.notes.split('\n').filter(function (line) { return obsolete.indexOf(line.trim()) < 0; }).join('\n');
      var examples = ['Bars 17–24, hands together','From memory at 80 bpm; transition still uncertain','Join bars 24–25 without stopping'];
      if (examples.indexOf(p.learningFocus) >= 0) p.learningFocus = '';
      if (examples.indexOf(p.learningAchievement) >= 0) p.learningAchievement = '';
    });
    store.appliedUpdates.push(id); save(); return true;
  }

  function updatePracticePreferences() {
    var id = 'practice-preferences-20261019';
    if (store.appliedUpdates.indexOf(id) >= 0 || needsSeed()) return false;
    store.settings.targetDailyMinutes = 45;
    // Preserve custom day budgets; replace the former 30-minute default.
    for (var d = 1; d <= 5; d++) {
      if (store.settings.dailyOverrides[d] === 30) store.settings.dailyOverrides[d] = 45;
    }
    store.settings.scaleStep = nextScaleStep();
    syncPendingWarmup();
    store.settings.capacityWatch = {overSince:null,nudgedFor:null};
    store.appliedUpdates.push(id); save(); return true;
  }


  function expandRepertoire() {
    var id = 'repertoire-expansion-20261020';
    if (needsSeed() || store.appliedUpdates.indexOf(id) >= 0) return false;
    var additions = [{"id": "p082", "composerId": "rachmaninoff", "title": "Prelude in D minor", "catalogue": "Op. 23 No. 3", "tier": 1, "durationMin": 2.5, "contentMin": 2.5, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "played", "state": "backlog", "sections": [], "tags": [], "notes": "Previously memorised; last in repertoire about a year before October 2026. Duration excludes the repeat."}, {"id": "p083", "composerId": "rachmaninoff", "title": "Prelude in G major", "catalogue": "Op. 32 No. 5", "tier": 1, "durationMin": 3, "contentMin": 3, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "new", "state": "backlog", "sections": [], "tags": []}, {"id": "p084", "composerId": "rachmaninoff", "title": "Prelude in B minor", "catalogue": "Op. 32 No. 10", "tier": 1, "durationMin": 6, "contentMin": 6, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "new", "state": "backlog", "sections": [], "tags": []}, {"id": "p085", "composerId": "rachmaninoff", "title": "Prelude in D major", "catalogue": "Op. 23 No. 4", "tier": 2, "durationMin": 5, "contentMin": 5, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "new", "state": "backlog", "sections": [], "tags": []}, {"id": "p086", "composerId": "chopin", "title": "Ballade No. 1 in G minor", "catalogue": "Op. 23", "tier": 1, "durationMin": 10, "contentMin": 10, "fragility": 3, "practiceDifficulty": 5, "priorKnowledge": "played", "state": "backlog", "sections": [{"id": "ballade-hotspot-1", "label": "RH flourish (turn on A)", "notes": "1 bar; about 30 seconds for a few repetitions.", "practiceDifficulty": 3, "durationMin": 0.5, "practiceMinutes": 0.5, "intervalCapDays": 14, "fragilityOverride": 3, "state": "consolidating", "intervalDays": 3, "enabled": true, "prompt": "start", "history": []}, {"id": "ballade-hotspot-2", "label": "Sempre più mosso (G minor) into arpeggios", "notes": "21 bars.", "practiceDifficulty": 4, "durationMin": 1, "practiceMinutes": 1, "intervalCapDays": 14, "fragilityOverride": 3, "state": "consolidating", "intervalDays": 3, "enabled": true, "prompt": "start", "history": []}, {"id": "ballade-hotspot-3", "label": "Theme 1 in A major into octaves", "notes": "20 bars.", "practiceDifficulty": 4, "durationMin": 1, "practiceMinutes": 1, "intervalCapDays": 14, "fragilityOverride": 3, "state": "consolidating", "intervalDays": 3, "enabled": true, "prompt": "start", "history": []}, {"id": "ballade-hotspot-4", "label": "Sempre più animato (B♭ bass)", "notes": "12 bars.", "practiceDifficulty": 4, "durationMin": 1, "practiceMinutes": 1, "intervalCapDays": 14, "fragilityOverride": 3, "state": "consolidating", "intervalDays": 3, "enabled": true, "prompt": "start", "history": []}, {"id": "ballade-hotspot-5", "label": "Scherzando in E♭ into scales", "notes": "28 bars.", "practiceDifficulty": 4, "durationMin": 1.5, "practiceMinutes": 1.5, "intervalCapDays": 14, "fragilityOverride": 3, "state": "consolidating", "intervalDays": 3, "enabled": true, "prompt": "start", "history": []}, {"id": "ballade-hotspot-6", "label": "Coda (presto con fuoco)", "notes": "2.5 pages; about 1.5 minutes to play, 5 minutes to practise.", "practiceDifficulty": 5, "durationMin": 1.5, "practiceMinutes": 5, "intervalCapDays": 14, "fragilityOverride": 3, "state": "consolidating", "intervalDays": 3, "enabled": true, "prompt": "start", "history": []}], "tags": [], "sectionFirst": true, "intervalCapDays": 28, "consolidatingIntervalDays": 7, "maxSectionsPerDay": 2, "notes": "Known on and off for almost 20 years. Restore the hot spots before the first full run."}, {"id": "p087", "composerId": "ravel", "title": "Prélude (Le Tombeau de Couperin)", "catalogue": "M. 68 No. 1", "tier": 1, "durationMin": 3, "contentMin": 3, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "played", "state": "backlog", "sections": [], "tags": [], "notes": "Previously played at university. Playing time is an editable estimate."}, {"id": "p088", "composerId": "ravel", "title": "Menuet (Le Tombeau de Couperin)", "catalogue": "M. 68 No. 5", "tier": 3, "durationMin": 5, "contentMin": 5, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "played", "state": "backlog", "sections": [], "tags": [], "notes": "Previously played at university. Playing time is an editable estimate."}, {"id": "p089", "composerId": "ravel", "title": "Rigaudon (Le Tombeau de Couperin)", "catalogue": "M. 68 No. 4", "tier": 3, "durationMin": 3, "contentMin": 3, "fragility": 3, "practiceDifficulty": 3, "priorKnowledge": "played", "state": "backlog", "sections": [], "tags": [], "notes": "Previously played at university. Playing time is an editable estimate."}];
    additions.forEach(function (raw) {
      var existing = store.pieces.find(function (p) { return p.composerId === raw.composerId && p.catalogue === raw.catalogue; });
      if (existing) return; // Never replace an existing piece or its practice.
      var piece = normalizePiece(raw);
      if (pieceById(piece.id)) piece.id = nextPieceId();
      store.pieces.push(piece);
    });
    var jeux = store.pieces.find(function (p) { return p.composerId === 'ravel' && p.title.toLowerCase().indexOf('jeux') >= 0; });
    if (jeux && jeux.priorKnowledge === 'new') jeux.priorKnowledge = 'played';
    store.appliedUpdates.push(id); save(); return true;
  }

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
      if (!store.session.finished) store.session.paused = true;
      else archiveSession();
      dropped = true;
    }

    var nudge = store.settings.onBreak ? null : capacityNudge(today);     // mutates capacityWatch
    if(store.settings.demandDriven)weekPlan(today,7,false);
    if (nudge || dropped || store.settings.demandDriven) save();

    return {
      today: today,
      weekday: weekdayOf(today),
      budget: budgetForDate(today),
      zeroBudgetDay: budgetForDate(today) === 0,
      recommended: recommendedMinutes(today),
      ideal: idealMinutes(today),
      forecast: loadForecast(today, TUNING.forecastDays),
      counts: counts(today),
      gap: store.settings.onBreak ? {show:false,missedDays:0,calendarDays:0,pieces:[]} : gapReport(today),
      capacity: capacityReport(today),
      nudge: nudge,
      exportReminder: needsExportReminder(today) ? { days: daysSinceExport(today) } : null,
      resumable: store.session,
      storagePersistent: storage.persistent !== false,
      saveError: lastSaveError
    };
  }

  // Build every recurrence before balancing. Future placements are suggestions,
  // not persistent commitments; overdue anchors and active sessions prevent drift.
  function balancedWeekPlan(today, requestedDays, includeToday) {
    today=today||todayISO();requestedDays=requestedDays||7;
    var horizon=Math.max(21,requestedDays+7), dates=[],active=[],jobs=[],chains={},buckets=[];
    var session=store.session,started=practiceLog(today).length>0||!!(session&&session.date===today),locked={};
    if(session&&session.date===today&&!session.finished)session.plan.forEach(function(it,i){
      if(!session.results[i])locked[it.pieceId+(it.sectionId?'::'+it.sectionId:'')]=true;
    });
    for(var i=0;i<horizon;i++){
      var date=addDays(today,i);dates.push(date);
      active.push(!inBreak(date)&&store.settings.skippedDate!==date&&(budgetForDate(date)>0||(i===0&&includeToday)));
      var learners=active[i]&&store.settings.learningEnabled?learningCandidates(date).slice(0,store.settings.maxLearning):[];
      buckets.push({date:date,weekday:weekdayOf(date),items:[],learning:learners,baseLearning:learners.length*store.settings.learningMinutes});
    }
    var units=reviewUnits().filter(function(u){return MAINTENANCE_STATES.indexOf(u.state)>=0&&u.nextDue&&(!learningUnit(u)||store.settings.learningEnabled);});
    units.sort(function(a,b){return Number(!(a.sectionId&&!a.lastPlayed))-Number(!(b.sectionId&&!b.lastPlayed))||a.nextDue.localeCompare(b.nextDue)||cmpId(a,b);});
    function dueFor(job,prevDate){return job.previous?addDays(prevDate||dates[job.previous.day],job.interval):job.unit.nextDue;}
    function choices(job,prevDate){
      var u=job.unit,due=dueFor(job,prevDate),interval=job.interval;
      if(job.locked)return [0];
      var stable=u.state==='established'&&interval>=3&&!u.technicalCheck&&!learningUnit(u), wiggle=stable?Math.max(1,Math.min(2,Math.floor(interval*.2))):0;
      var earlyWindow=store.settings.performancePlanning&&stable&&interval>=5&&weekdayOf(due)===1?Math.max(3,wiggle):wiggle;
      var lo=addDays(due,-earlyWindow),hi=addDays(due,wiggle),prior=job.previous?(prevDate||dates[job.previous.day]):u.lastPlayed;
      if(stable&&prior){var capDate=addDays(prior,appliedCap(u.fragility,u.intervalCapDays));if(hi>capDate)hi=capDate;}
      // A stable review falling on a day off may use the preceding practice
      // day, at most two calendar days early and never on consecutive days
      // for a three-day interval. This avoids a Sunday-to-Monday bottleneck.
      var dueIndex=daysBetween(today,due);
      // An easy consolidating piece due on Saturday can use Friday rather
      // than stretch a new three-day gap to five days. Early checks do not
      // earn longer spacing; the actual elapsed gap decides that.
      if(store.settings.performancePlanning&&easySpacing(u)&&interval>=2&&dueIndex>=0&&dueIndex<horizon&&!active[dueIndex]){
        lo=addDays(due,-2);
        if(prior&&lo<addDays(prior,interval-1))lo=addDays(prior,interval-1);
      }
      if(stable&&dueIndex>=0&&dueIndex<horizon&&!active[dueIndex])lo=addDays(due,-Math.max(2,wiggle));
      if(prior){var minDate=addDays(prior,stable?Math.max(2,interval-Math.max(2,earlyWindow)):1);if(lo<minDate)lo=minDate;}
      if(!job.previous&&due<today){lo=today;hi=today;}
      var out=[];
      for(var d=0;d<horizon;d++)if(active[d]&&dates[d]>=lo&&dates[d]<=hi&&!(d===0&&started&&due>today))out.push(d);
      if(!out.length){
        // Fixed short checks roll over days off once, not once per missed day.
        for(var d=0;d<horizon;d++)if(active[d]&&dates[d]>=due&&(!prior||dates[d]>prior)&&!(d===0&&started&&due>today)){out=[d];break;}
      }
      return out;
    }
    function sectionRoom(job,day){
      if(!job.unit.sectionId||!job.parent.sectionFirst)return true;
      var used=jobs.filter(function(x){return x!==job&&x.day===day&&x.unit.sectionId&&x.parent.id===job.parent.id;}).length;
      return used<(day===0?sectionSlotsLeft(job.parent,today):job.parent.maxSectionsPerDay);
    }
    // Establish a complete baseline, including daily checks and section drills.
    units.forEach(function(u){
      var previous=null,parent=unitParent(u),chain=[];
      for(var occurrence=0;occurrence<horizon;occurrence++){
        var job={unit:u,parent:parent,interval:Math.max(1,u.intervalDays||1),previous:previous,next:null,occurrence:occurrence,
          locked:occurrence===0&&!!locked[u.id],cost:pieceCost(u),hard:unitDifficulty(u)>=4};
        var opts=choices(job).filter(function(d){return sectionRoom(job,d);});
        if(!opts.length&&u.sectionId&&parent.sectionFirst){
          var due=dueFor(job);for(var d=0;d<horizon;d++)if(active[d]&&dates[d]>=due&&(!previous||d>previous.day)&&sectionRoom(job,d)){opts=[d];break;}
        }
        if(!opts.length)break;
        var due=dueFor(job);opts.sort(function(a,b){return Math.abs(daysBetween(due,dates[a]))-Math.abs(daysBetween(due,dates[b]))||a-b;});
        job.day=opts[0];if(previous)previous.next=job;previous=job;chain.push(job);jobs.push(job);
        if(u.sectionFirst&&learningUnit(u)&&!u.sectionId)break;
      }
      chains[u.id]=chain;
    });
    function totals(){
      var list=buckets.map(function(b){return {maintenance:0,learning:b.baseLearning,hard:0,hardMinutes:0,count:b.learning.length};});
      jobs.forEach(function(j){var b=list[j.day];b[learningUnit(j.unit)?'learning':'maintenance']+=j.cost;b.count++;if(j.hard){b.hardMinutes+=j.cost;if(!j.unit.sectionId)b.hard++;}});
      return list.map(function(b,d){var warmup=b.count&&active[d]&&!(d===0&&practiceLog(today).some(function(r){return r.type==='warmup';}))?store.settings.warmupMinutes:0;var sum=b.maintenance+b.learning+warmup;b.warmup=warmup;b.allowance=b.hardMinutes?sum/9:0;b.total=sum+b.allowance;return b;});
    }
    function objective(){
      var t=totals(),score=0;
      t.forEach(function(b){score+=b.total*b.total+35*Math.pow(Math.max(0,b.hard-2),2)+.15*b.hardMinutes*b.hardMinutes;});
      jobs.forEach(function(j){score+=2*Math.pow(daysBetween(dueFor(j),dates[j.day]),2);});
      return score;
    }
    // Coordinate descent over the complete workload. Check both adjacent
    // occurrences when moving a review, preserving its recurrence spacing.
    var score=objective();
    var movable=jobs.slice().sort(function(a,b){return b.cost-a.cost||Number(b.hard)-Number(a.hard)||a.day-b.day;});
    for(var pass=0;pass<10;pass++){
      var changed=false;
      movable.forEach(function(job){
        if(job.locked)return;
        var original=job.day,best=original,bestScore=score;
        choices(job).forEach(function(day){
          if(day===original||!sectionRoom(job,day))return;
          if(job.previous&&day<=job.previous.day)return;
          if(job.next&&(day>=job.next.day||choices(job.next,dates[day]).indexOf(job.next.day)<0))return;
          job.day=day;var trial=objective();if(trial<bestScore-.01){best=day;bestScore=trial;}job.day=original;
        });
        job.day=best;if(best!==original){score=bestScore;changed=true;}
      });
      if(!changed)break;
    }
    if(store.settings.performancePlanning){
      // Move a review and, where needed, its later occurrences together.
      // No occurrence is discarded and the same date/gap limits still apply.
      for(var pass=0;pass<2;pass++){
        var improved=false;
        movable.forEach(function(job){
          if(job.locked)return;
          var originalDays=jobs.map(function(j){return j.day;}),bestDays=null,bestScore=score;
          choices(job).forEach(function(day){
            if(day===job.day||!sectionRoom(job,day))return;
            job.day=day;var next=job.next,valid=true;
            while(next){
              var opts=choices(next).filter(function(d){return d>next.previous.day&&sectionRoom(next,d);});
              if(!opts.length){valid=false;break;}
              if(opts.indexOf(next.day)<0){opts.sort(function(a,b){return Math.abs(a-next.day)-Math.abs(b-next.day)||a-b;});next.day=opts[0];}
              next=next.next;
            }
            if(valid){var trial=objective();if(trial<bestScore-.01){bestScore=trial;bestDays=jobs.map(function(j){return j.day;});}}
            jobs.forEach(function(j,i){j.day=originalDays[i];});
          });
          if(bestDays){jobs.forEach(function(j,i){j.day=bestDays[i];});score=bestScore;improved=true;}
        });
        if(!improved)break;
      }
    }
    var sum=totals();
    jobs.forEach(function(j){var due=dueFor(j),it=reviewItem(j.unit,dates[j.day]<due?'lookahead':'maintenance');it.naturalDue=due;it.projected=j.occurrence>0;buckets[j.day].items.push(it);});
    return buckets.slice(0,requestedDays).map(function(b,d){
      b.learning.forEach(function(p){b.items.push({pieceId:p.id,piece:p,kind:'learning',estMin:store.settings.learningMinutes});});
      return {date:b.date,weekday:b.weekday,items:orderForPractice(b.items),maintenanceMin:sum[d].maintenance,learningMin:sum[d].learning,
        hardCount:sum[d].hard,hardMinutes:sum[d].hardMinutes,warmupMin:sum[d].warmup,allowanceMin:sum[d].allowance,projectedMin:sum[d].total,
        practiceDay:active[d],budget:0,over:false,overBy:0};
    });
  }

  function consolidationSuggestion(p,today){
    today=today||todayISO();
    if(store.settings.performancePlanning)return null;
    if(!p||p.state!=='consolidating'||p.practiceDifficulty>2||p.sectionFirst)return null;
    var interval=p.consolidatingIntervalDays||3;if(interval!==1&&interval!==2)return null;
    var since=p.consolidationCadenceSince||p.stateSince||'',clean=[];
    p.history.slice().sort(function(a,b){return String(a.date).localeCompare(String(b.date));}).forEach(function(h){
      if(!h.date||h.date<since||h.date>today||!h.grade)return;
      if(h.grade!=='clean'){clean=[];return;}
      if(!h.early&&h.intervalBefore===interval&&clean.indexOf(h.date)<0)clean.push(h.date);
    });
    var start=interval===2&&p.consolidationCadenceSince?p.consolidationCadenceSince:clean[0];
    if(clean.length<(interval===1?5:3)||!start||daysBetween(start,clean[clean.length-1])<7)return null;
    return {intervalDays:interval+1,cleanChecks:clean.length};
  }
  function spaceConsolidation(id,today){
    today=today||todayISO();var p=pieceById(id),suggestion=consolidationSuggestion(p,today);if(!suggestion)return false;
    updatePiece(id,{consolidatingIntervalDays:suggestion.intervalDays},today);p.consolidationCadenceSince=today;save();return true;
  }
  function refinePracticeRules(today){
    today=today||todayISO();var id='balanced-weeks-20261021';
    if(needsSeed()||store.appliedUpdates.indexOf(id)>=0)return false;
    store.settings.balancedPlanning=true;store.reviewAssignments={};
    var drillNames=['F major scale','C major scale','E major scale','B-dim arpeggio','Chromatic thirds'];
    store.pieces.forEach(function(p){
      if(p.composerId!=='chopin')return;
      if(p.catalogue==='Op. 28 No. 24')p.sections.forEach(function(s){if(drillNames.indexOf(s.label)>=0)s.practiceMinutes=1;});
      if(['Op. 28 No. 4','Op. 28 No. 6','Op. 28 No. 7'].indexOf(p.catalogue)>=0&&p.state==='consolidating'&&p.consolidatingIntervalDays===1){
        // Re-evaluate the phone's current history; a later wobble or breakdown
        // must not be overwritten by the older backup used during development.
        if(consolidationSuggestion(p,today)){p.consolidatingIntervalDays=2;p.intervalDays=2;p.nextDue=addDays(p.lastPlayed||today,2);p.consolidationCadenceSince=today;}
      }
    });
    if(store.session)store.session.plan.forEach(function(it,i){if(store.session.results[i])return;var p=pieceById(it.pieceId),s=p&&it.sectionId?sectionById(p,it.sectionId):null;if(s)it.estMin=pieceCost(s);});
    store.appliedUpdates.push(id);save();return true;
  }

  // Demand-led planning. Saved dates pin a review within its window so simply
  // reopening the app cannot keep pushing the same review into the future.
  function unitKey(unit, due) { return unit.id + '@' + due; }
  function unitParent(unit) { return pieceById(unit.parentPieceId || unit.id) || unit; }
  function unitDifficulty(unit) {
    var parent = unitParent(unit);
    return unit.practiceDifficulty == null ? parent.practiceDifficulty : unit.practiceDifficulty;
  }
  function learningUnit(unit) { return unitParent(unit).state === 'learning'; }
  function plannedCost(unit) {
    if (!unit.sectionId && unit.state === 'learning') return store.settings.learningMinutes;
    return pieceCost(unit);
  }
  function weekPlan(today, days, includeToday) {
    if(store.settings.balancedPlanning)return balancedWeekPlan(today,days,includeToday);
    today = today || todayISO(); days = days || 7;
    var end = addDays(today, days - 1), buckets = {}, jobs = [];
    for (var i=0;i<days;i++) {
      var date=addDays(today,i);
      buckets[date]={date:date,weekday:weekdayOf(date),items:[],maintenanceMin:0,learningMin:0,hardCount:0,hardMinutes:0};
    }
    var active = function (date) {
      return (date === today && includeToday) || (!inBreak(date) && budgetForDate(date)>0 && store.settings.skippedDate!==date);
    };
    var units=reviewUnits().filter(function (u) {
      return MAINTENANCE_STATES.indexOf(u.state)>=0 && u.nextDue &&
        (!learningUnit(u) || store.settings.learningEnabled);
    });
    units.forEach(function (u) {
      var due=u.nextDue, interval=Math.max(1,u.intervalDays || 1), occurrence=0;
      while (due <= addDays(end,2) && occurrence < 20) {
        // The first overdue occurrence is real; missed historical repetitions
        // are not a debt and are never generated as extra jobs.
        var effective=due<today?today:due;
        var stable=u.state==='established' && interval>=5 && !learningUnit(u);
        var wiggle=stable?Math.min(2,Math.floor(interval*.2)):0;
        var earliest=addDays(effective,-wiggle), latest=addDays(effective,wiggle);
        if(earliest<today)earliest=today;
        if(occurrence===0 && u.lastPlayed && stable && due>=today) {
          var capDate=addDays(u.lastPlayed,appliedCap(u.fragility,u.intervalCapDays));
          if(latest>capDate)latest=capDate;
        }
        // Initial hot-spot activation dates and short review intervals stay
        // fixed. Days off move the work to the next available practice day.
        var candidates=[];
        for(var d=earliest;d<=latest;d=addDays(d,1))if(active(d))candidates.push(d);
        if(!candidates.length) {
          var next=effective;
          for(var guard=0;guard<21 && !active(next);guard++)next=addDays(next,1);
          if(active(next))candidates.push(next);
        }
        candidates=candidates.filter(function(d){return d<=end;});
        if(candidates.length)jobs.push({unit:u,due:due,candidates:candidates,occurrence:occurrence,stable:stable});
        due=addDays(effective,interval); occurrence++;
        if(u.sectionFirst && learningUnit(u) && !u.sectionId)break;
      }
    });
    // Fixed work first; then place the least flexible and hardest work.
    jobs.sort(function(a,b){
      return a.occurrence-b.occurrence || Number(a.stable)-Number(b.stable) ||
        Number(!(a.unit.sectionId&&!a.unit.lastPlayed))-Number(!(b.unit.sectionId&&!b.unit.lastPlayed)) ||
        a.candidates.length-b.candidates.length ||
        Number(unitDifficulty(b.unit)>=4)-Number(unitDifficulty(a.unit)>=4) ||
        plannedCost(b.unit)-plannedCost(a.unit) || a.due.localeCompare(b.due) || cmpId(a.unit,b.unit);
    });
    var firstPlaced={}, unitDates={}, sectionCount={};
    jobs.forEach(function(job){
      var u=job.unit,parent=unitParent(u),isSection=!!u.sectionId, hard=unitDifficulty(u)>=4;
      if(job.occurrence>0&&unitDates[u.id]) {
        job.due=addDays(unitDates[u.id],Math.max(1,u.intervalDays||1));
        var wiggle=job.stable?Math.min(2,Math.floor((u.intervalDays||1)*.2)):0;
        job.candidates=[];
        for(var future=addDays(job.due,-wiggle);future<=addDays(job.due,wiggle)&&future<=end;future=addDays(future,1))if(active(future))job.candidates.push(future);
        if(!job.candidates.length)for(var future=job.due;future<=end;future=addDays(future,1))if(active(future)){job.candidates=[future];break;}
      }
      if(!job.candidates.length)return;
      var key=unitKey(u,job.due), pinned=store.reviewAssignments[key];
      var candidates=job.candidates.filter(function(d){
        if(unitDates[u.id] && unitDates[u.id]>=d)return false;
        return true;
      });
      if(isSection && parent.sectionFirst) {
        var room=function(d){return (sectionCount[parent.id+':'+d] || 0) <
          (d===today?sectionSlotsLeft(parent,today):parent.maxSectionsPerDay);};
        candidates=candidates.filter(room);
        if(!candidates.length) {
          for(var d=job.candidates[0];d<=end;d=addDays(d,1))if(active(d)&&room(d)&&(!unitDates[u.id]||d>unitDates[u.id])){candidates=[d];break;}
        }
      }
      if(!candidates.length)return;
      function score(d) {
        var b=buckets[d];
        // Two hard whole pieces is a balancing preference, never an omission
        // rule. Hard sections contribute minutes without counting as pieces.
        return b.maintenanceMin+b.learningMin + (hard?b.hardMinutes*.8:0) +
          (hard&&!isSection&&b.hardCount>=2?30:0) + Math.abs(daysBetween(job.due,d))*2;
      }
      candidates.sort(function(a,b){return score(a)-score(b)||a.localeCompare(b);});
      var assigned=candidates.indexOf(pinned)>=0?pinned:candidates[0], b=buckets[assigned];
      var item=reviewItem(u,assigned<job.due?'lookahead':'maintenance');
      item.naturalDue=job.due; item.projected=job.occurrence>0;
      b.items.push(item);
      if(learningUnit(u))b.learningMin+=item.estMin;else b.maintenanceMin+=item.estMin;
      if(hard){b.hardMinutes+=item.estMin;if(!isSection)b.hardCount++;}
      unitDates[u.id]=assigned;
      if(isSection)sectionCount[parent.id+':'+assigned]=(sectionCount[parent.id+':'+assigned]||0)+1;
      if(job.occurrence===0)firstPlaced[key]=assigned;
    });
    Object.keys(firstPlaced).forEach(function(key){store.reviewAssignments[key]=firstPlaced[key];});
    Object.keys(store.reviewAssignments).forEach(function(key){
      if(store.reviewAssignments[key]<today || store.reviewAssignments[key]>addDays(end,14))delete store.reviewAssignments[key];
    });
    return Object.keys(buckets).map(function(date){
      var b=buckets[date];
      if(active(date) && store.settings.learningEnabled) {
        learningCandidates(date).slice(0,store.settings.maxLearning).forEach(function(p){
          b.items.push({pieceId:p.id,piece:p,kind:'learning',estMin:store.settings.learningMinutes});
          b.learningMin+=store.settings.learningMinutes;
        });
      }
      b.items=orderForPractice(b.items);
      b.warmupMin=active(date)&&b.items.length?store.settings.warmupMinutes:0;
      var subtotal=b.maintenanceMin+b.learningMin+b.warmupMin;
      b.allowanceMin=b.hardMinutes?subtotal/9:0; // 10% of total, not 10% on top
      b.projectedMin=subtotal+b.allowanceMin;
      b.budget=0;b.over=false;b.overBy=0;
      b.practiceDay=active(date);
      return b;
    });
  }

  function orderForPractice(items) {
    function difficulty(it) {var p=it.piece||pieceById(it.pieceId),s=it.sectionId&&sectionById(p,it.sectionId);return s&&s.practiceDifficulty!=null?s.practiceDifficulty:p.practiceDifficulty;}
    function learning(it){return pieceById(it.pieceId).state==='learning'||it.kind==='learning';}
    var learners=items.filter(learning), rest=items.filter(function(it){return !learning(it);});
    var easy=rest.filter(function(it){return difficulty(it)<4;}).sort(function(a,b){return difficulty(a)-difficulty(b);});
    var hard=rest.filter(function(it){return difficulty(it)>=4;}).sort(function(a,b){return difficulty(a)-difficulty(b);});
    var ordered=[];
    if(easy.length)ordered.push(easy.shift());
    while(hard.length||easy.length){if(hard.length)ordered.push(hard.shift());if(easy.length)ordered.push(easy.shift());}
    // A section probe must precede a full run of the same piece.
    ordered.concat(learners).forEach(function(it){
      if(!it.sectionId)return;
      var full=ordered.findIndex(function(x){return x.pieceId===it.pieceId&&!x.sectionId;});
      var at=ordered.indexOf(it);
      if(full>=0&&at>full){ordered.splice(at,1);ordered.splice(full,0,it);}
    });
    return ordered.concat(learners);
  }

  function buildDemandSession(today,options) {
    today=today||todayISO();options=options||{};
    var day=weekPlan(today,7,budgetForDate(today)===0&&!inBreak(today)&&store.settings.skippedDate!==today)[0];
    var items=day.items.filter(function(it){
      var p=it.piece,subject=it.sectionId?sectionById(p,it.sectionId):p;
      return !it.projected && !reviewedOn(subject,today);
    });
    if(options.extra) {
      // Offer one optional full piece at a time, not the whole library.
      var next=store.pieces.filter(function(p){
        return MAINTENANCE_STATES.indexOf(p.state)>=0 && p.state!=='repair' && !reviewedOn(p,today) &&
          !items.some(function(it){return it.pieceId===p.id&&!it.sectionId;});
      }).sort(function(a,b){return String(a.lastPlayed||'').localeCompare(String(b.lastPlayed||''))||cmpId(a,b);})[0];
      if(next)items.push({pieceId:next.id,piece:next,kind:'continuity',estMin:pieceCost(next)});
    }
    items=orderForPractice(items);
    var warmup=warmupForDate(today,practiceLog(today).some(function(r){return r.type==='warmup';})?0:store.settings.warmupMinutes);
    var total=items.reduce(function(n,it){return n+it.estMin;},0)+warmup.minutes;
    var hard=items.filter(function(it){var p=it.piece,s=it.sectionId&&sectionById(p,it.sectionId);return (s&&s.practiceDifficulty!=null?s.practiceDifficulty:p.practiceDifficulty)>=4;});
    var allowance=hard.length?total/9:0;
    return {date:today,items:items,warmup:warmup,budgetMin:total+allowance,plannedMin:total+allowance,
      demandMin:total-warmup.minutes,allowanceMin:allowance,
      learning:items.filter(function(it){return pieceById(it.pieceId).state==='learning';}),
      technical:items.filter(function(it){return it.kind==='technical';}),
      maintenance:items.filter(function(it){return pieceById(it.pieceId).state!=='learning'&&it.kind==='maintenance';}),
      lookahead:items.filter(function(it){return it.kind==='lookahead';}),
      continuity:items.filter(function(it){return it.kind==='continuity';}),
      hardCount:hard.filter(function(it){return !it.sectionId;}).length,
      deferred:[],deferredCount:0,deferredMin:0,learningYielded:0,excessLearners:0};
  }

  // Timers use elapsed wall time, never the number of interval callbacks.
  // Checkpoints bound recovery after a process is killed. Reopening never
  // counts the period while the app was closed.
  var timerClock=function(){return Date.now();};
  function currentTimer(create) {
    var s=store.session;
    if(!s)return null;
    var warmup=s.warmup&&s.warmup.status==='pending';
    if(!warmup&&s.index>=s.plan.length)return null;
    if(!s.timers)s.timers={};
    var key=warmup?'warmup':String(s.index);
    if(!s.timers[key]&&create)s.timers[key]={elapsedMs:0,runningSince:null,checkpoint:null,started:false,finished:false};
    return s.timers[key]||null;
  }
  function elapsedTimer(t) {return t?Math.max(0,t.elapsedMs+(t.runningSince==null?0:Math.max(0,timerClock()-t.runningSince))):0;}
  function timerInfo() {
    var t=currentTimer(false);
    return {milliseconds:elapsedTimer(t),running:!!t&&t.runningSince!=null,started:!!t&&t.started,finished:!!t&&t.finished};
  }
  function storeTiming(t) {
    var s=store.session;if(!s||!t)return;
    var warmup=s.warmup&&s.warmup.status==='pending',it=warmup?{pieceId:null}:s.plan[s.index];
    if(!it)return;
    var id=s.id+':'+(warmup?'warmup':s.index);
    var previous=store.practiceTimes.find(function(x){return x.id===id;});
    var minutes=t.elapsedMs/60000, delta=minutes-(previous?previous.minutes:0);
    var row={id:id,date:(previous&&previous.date)||todayISO(),pieceId:it.pieceId,sectionId:it.sectionId||null,
      minutes:minutes,kind:it.kind,state:previous?previous.state:(warmup?'warmup':(pieceById(it.pieceId)||{}).state),finished:t.finished};
    if(previous)Object.assign(previous,row);else if(minutes>0)store.practiceTimes.push(row);
    if(delta)addActualMinutes(row.date,delta);
    var result=!warmup&&s.results[s.index];
    if(result){result.actualMinutes=minutes;result.timingId=id;}
  }
  function checkpointTimer(pause) {
    var t=currentTimer(false);
    if(!t)return;
    if(t.runningSince!=null){t.elapsedMs=elapsedTimer(t);t.runningSince=pause?null:timerClock();}
    t.checkpoint=timerClock();storeTiming(t);save();
  }
  function startTimer() {
    var s=store.session,t=currentTimer(true);
    if(!t||s.paused||t.finished)return false;
    if(t.runningSince==null){t.runningSince=timerClock();t.checkpoint=timerClock();t.started=true;save();}
    return true;
  }
  function ensureTimer() {var t=currentTimer(true);if(t&&!t.started)startTimer();}
  function adjustTimer(minutes) {
    var t=currentTimer(true);if(!t)return;
    t.elapsedMs=Math.max(0,num(minutes,0))*60000;t.runningSince=null;t.started=true;
    storeTiming(t);save();
  }
  function timedGrade(grade,issue) {
    checkpointTimer(false);
    return recordAt(store.session.index,{grade:grade,issue:issue});
  }
  function finishTimedItem(payload) {
    var s=store.session;if(!s)return false;
    checkpointTimer(true);
    if(payload){recordAt(s.index,payload);s.learningDraft=null;}
    var r=s.results[s.index];if(!r||r.skipped)return false;
    var t=currentTimer(true);t.finished=true;storeTiming(t);r.finished=true;
    advanceFrom(s.index);save();return true;
  }
  function timingSummary(id,sectionId) {
    var rows=store.practiceTimes.filter(function(x){return x.pieceId===id&&(x.sectionId||null)===(sectionId||null)&&x.kind!=='technical'&&x.finished&&x.minutes>0&&x.state!=='repair'&&x.state!=='learning';});
    if(rows.length<3)return null;
    var values=rows.slice(-8).map(function(x){return x.minutes;}).sort(function(a,b){return a-b;});
    var mid=Math.floor(values.length/2);
    return {minutes:values.length%2?values[mid]:(values[mid-1]+values[mid])/2,sessions:values.length};
  }
  function enableDemandPlanning() {
    var id='demand-timer-20261020';
    if(needsSeed()||store.appliedUpdates.indexOf(id)>=0)return false;
    store.settings.demandDriven=true;store.settings.learningEnabled=true;
    [8,12,14,16,18,19].forEach(function(n){
      var p=store.pieces.find(function(p){return p.composerId==='chopin'&&p.catalogue==='Op. 28 No. '+n;});
      if(p){p.practiceDifficulty=Math.max(4,p.practiceDifficulty);if(n===16&&p.practiceMinutes==null)p.practiceMinutes=5;}
    });
    var b=store.pieces.find(function(p){return p.composerId==='chopin'&&p.catalogue==='Op. 23';});
    if(b&&b.practiceMinutes==null)b.practiceMinutes=13;
    // A live plan keeps its items and grades, but its unrecorded estimates
    // need the new allowances. No review dates or histories are rewritten.
    if(store.session)store.session.plan.forEach(function(it,i){
      if(store.session.results[i])return;
      var p=pieceById(it.pieceId),subject=p&&(it.sectionId?sectionById(p,it.sectionId):p);
      if(subject)it.estMin=it.kind==='learning'?store.settings.learningMinutes:pieceCost(subject);
    });
    if(store.session){
      var session=store.session,slots=[];
      session.plan.forEach(function(it,i){if(!session.results[i])slots.push(i);});
      var ordered=orderForPractice(slots.map(function(i){return session.plan[i];}));
      slots.forEach(function(index,i){session.plan[index]=ordered[i];});
    }
    store.appliedUpdates.push(id);save();return true;
  }


  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  global.App = {
    VERSION: '6.5',
    weekPlan:weekPlan,
    refinePracticeRules:refinePracticeRules,
    enablePerformanceSpacing:enablePerformanceSpacing,
    consolidationSuggestion:consolidationSuggestion,
    spaceConsolidation:spaceConsolidation,
    timerInfo:timerInfo,
    ensureTimer:ensureTimer,
    startTimer:startTimer,
    pauseTimer:function(){checkpointTimer(true);},
    checkpointTimer:function(){checkpointTimer(false);},
    adjustTimer:adjustTimer,
    timedGrade:timedGrade,
    finishTimedItem:finishTimedItem,
    timingSummary:timingSummary,
    enableDemandPlanning:enableDemandPlanning,
    setTimerClock:function(fn){timerClock=fn||function(){return Date.now();};},
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
      if(fields.demandDriven!=null)s.demandDriven=fields.demandDriven===true;
      if(fields.learningEnabled!=null)s.learningEnabled=fields.learningEnabled===true;
      if(fields.learningMinutes!=null)s.learningMinutes=Math.max(1,num(fields.learningMinutes,10));
      if(fields.dailyOverrides)store.reviewAssignments={};
      if (fields.targetDailyMinutes != null) s.targetDailyMinutes = Math.max(0, Math.round(num(fields.targetDailyMinutes, s.targetDailyMinutes)));
      if (fields.dailyOverrides) {
        for (var d = 0; d <= 6; d++) {
          if (fields.dailyOverrides[d] === null) delete s.dailyOverrides[d];
          else if (fields.dailyOverrides[d] != null) s.dailyOverrides[d] = Math.max(0, Math.round(num(fields.dailyOverrides[d], 0)));
        }
      }
      if (fields.scaleStep != null) { s.scaleStep = Math.max(0,Math.floor(num(fields.scaleStep,0))); syncPendingWarmup(); }
      if (fields.warmupMinutes != null) s.warmupMinutes = clamp(num(fields.warmupMinutes,2),0,5);
      if (fields.skippedDate === null) s.skippedDate = null;
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
    sectionProgress: sectionProgress,
    replaceSections: replaceSections,
    normalizeSection: normalizeSection,
    skipCurrent: skipCurrent,
    recordAt: recordAt,
    undoCurrent: undoCurrent,
    goToIndex: goToIndex,
    stepIndex: stepIndex,
    sessionProgress: sessionProgress,
    finishSession: finishSession,
    pauseSession: pauseSession,
    resumeSession: resumeSession,
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
    correctCatalogue: correctCatalogue,
    expandRepertoire: expandRepertoire,
    correctPreludeStates: correctPreludeStates,
    practiceLog: practiceLog,
    markWarmup: markWarmup,
    resumeClosed: resumeClosed,
    unfinishedItems: unfinishedItems,
    startPieceSession: startPieceSession,
    saveLearningDraft: saveLearningDraft,
    setBreak: setBreak,
    inBreak: inBreak,
    warmupForDate: warmupForDate,
    scaleAtStep: scaleAtStep,
    nextScaleStep: nextScaleStep,
    updatePracticePreferences: updatePracticePreferences,
    needsSeed: needsSeed,
    bootstrapFromSeed: bootstrapFromSeed,
    launch: launch
  };

  load();

})(typeof globalThis !== 'undefined' ? globalThis : this);
