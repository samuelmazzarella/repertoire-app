/* ui.js — rendering and events. All business logic lives in app.js; this
 * file reads from App and calls into it, and holds only view state. */
(function () {
  'use strict';

  var A = window.App;

  /* View state only — nothing here is persisted. */
  var view = {
    tab: 'today',
    minutes: null,          // current stepper value
    dismissedGap: false,
    dismissedNudge: false,
    dismissedExport: false,
    openTiers: { 0: true, 1: true, 2: true, 3: true },
    filters: { tier: '', state: '', composerId: '', search: '' },
    editing: null,          // draft piece being edited in the sheet
    editingIsNew: false,
    composerQuery: '',
    booted: false
  };

  var launchInfo = null;

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mins(n) {
    var r = Math.round(n * 10) / 10;
    return (r % 1 === 0 ? r.toFixed(0) : r.toFixed(1));
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function longDate(iso) {
    var p = iso.split('-');
    return DAYS[A.weekdayOf(iso)] + ' ' + (+p[2]) + ' ' + MONTHS[+p[1] - 1];
  }

  function dueLabel(p, today) {
    if (!p.nextDue) return '';
    var d = A.daysBetween(today, p.nextDue);
    if (d === 0) return 'due today';
    if (d < 0) return 'due ' + (-d) + 'd ago';
    return 'due in ' + d + 'd';
  }

  function pieceLine(p, today) {
    var bits = [p.state];
    if (p.state === 'learning') {
      if (p.learningFocus) bits.push(p.learningFocus);
      var dl = A.daysLearning(p, today);
      if (dl != null) bits.push(plural(dl, 'day') + ' in');
    } else if (p.intervalDays) {
      bits.push('every ' + p.intervalDays + 'd');
    }
    if (p.nextDue && p.state !== 'learning') bits.push(dueLabel(p, today));
    bits.push(mins(p.durationMin) + ' min');
    bits.push('fragility ' + p.fragility);
    return bits;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    if (A.needsSeed()) {
      fetch('seed.json')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) { A.bootstrapFromSeed(json); start(); })
        .catch(function () {
          view.seedError = true;
          start();
        });
    } else {
      start();
    }
  }

  function renderSaveStatus() {
    var root = el('save-status');
    var failed = A.saveError() || !A.storageAvailable();
    root.hidden = !failed;
    root.innerHTML = failed ? '<strong>Changes have not been saved.</strong> Keep this app open. ' +
      '<button class="btn btn-sm" data-action="retry-save">Try again</button> ' +
      '<button class="btn btn-sm" data-action="export">Export backup</button>' : '';
  }

  function start() {
    A.subscribe(renderSaveStatus);
    renderSaveStatus();
    view.booted = true;
    refresh();
  }

  function refresh() {
    launchInfo = A.launch();
    if (view.minutes == null) view.minutes = launchInfo.recommended || launchInfo.budget || 30;
    render();
  }

  function render() {
    el('screen-today').hidden = view.tab !== 'today';
    el('screen-repertoire').hidden = view.tab !== 'repertoire';
    Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (b) {
      var on = b.getAttribute('data-tab') === view.tab;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (view.tab === 'today') renderToday(); else renderRepertoire();
  }

  /* ------------------------------------------------------------------ *
   * Today
   * ------------------------------------------------------------------ */

  function renderToday() {
    var s = A.state();
    var today = launchInfo.today;
    var root = el('screen-today');

    if (view.seedError) {
      root.innerHTML = '<div class="empty-state"><h2>Could not load seed.json</h2>' +
        '<p class="small">Open the app over http rather than from the file system, ' +
        'or import a backup.</p>' +
        '<button class="btn btn-block" data-action="import">Import JSON</button></div>';
      return;
    }

    var session = s.session;
    if (session && session.index < session.plan.length) { renderSession(root, session, today); return; }
    if (session) { renderSummary(root, today); return; }
    renderLaunch(root, today);
  }

  function renderLaunch(root, today) {
    var c = launchInfo.counts;
    var built = A.buildSession(view.minutes, today);
    var html = '';

    html += '<h1>Today</h1>';
    html += '<p class="date-line">' + esc(longDate(today)) + '</p>';

    html += renderNotices(today);

    if (c.total === 0) {
      root.innerHTML = html + '<div class="empty-state"><h2>No repertoire yet</h2>' +
        '<p class="small">Import a backup to get started.</p>' +
        '<button class="btn btn-block" data-action="import">Import JSON</button></div>';
      return;
    }

    var nothingToDo = built.demandMin <= 0;

    /* Nothing scheduled but a full backlog is the first-run state, and a
       Start button that builds an empty session is no help. Route straight
       into choosing something to learn. */
    if (nothingToDo && c.learning === 0 && c.backlog > 0) {
      html += '<section class="card"><p class="headline" style="font-size:1.5rem">Nothing scheduled yet</p>' +
        '<p class="ideal-line">' + plural(c.backlog, 'piece') + ' waiting in the backlog. ' +
        'Pick one to start learning — it will take a 10-minute slot each session.</p>' +
        '<div class="stack" style="margin-top:16px">' +
        '<button class="btn btn-primary btn-block" data-action="browse-backlog">Choose a piece</button>' +
        '<button class="btn btn-quiet btn-block" data-action="import">Import a backup instead</button>' +
        '</div></section>';
      root.innerHTML = html;
      return;
    }

    html += '<section class="card">';

    if (launchInfo.zeroBudgetDay) {
      html += '<p class="headline" style="font-size:1.35rem">No session scheduled</p>';
      html += '<p class="ideal-line">' + esc(DAYS[launchInfo.weekday]) + ' is set to 0 minutes. Practise anyway?</p>';
    } else if (nothingToDo) {
      html += '<p class="headline">Nothing due</p>';
      html += '<p class="ideal-line">Next up ' + esc(nextDueSummary(today)) + '.</p>';
    } else {
      html += '<p class="headline">' + launchInfo.recommended + ' <small>min recommended</small></p>';
      if (launchInfo.ideal > launchInfo.recommended + 0.5) {
        html += '<p class="ideal-line">Clearing everything due today would take ' +
          mins(launchInfo.ideal) + ' min.</p>';
      }
    }

    var counts = [];
    if (c.learning) counts.push(c.learning + ' learning');
    counts.push(c.due + ' due');
    if (c.repair) counts.push(c.repair + ' in repair');
    if (c.backlog) counts.push(c.backlog + ' in backlog');
    html += '<p class="counts">' + counts.map(function (x) {
      return '<span>' + x + '</span>';
    }).join('') + '</p>';

    html += '<div class="stepper">' +
      '<button class="btn" data-action="less" aria-label="Less time">&minus;</button>' +
      '<div class="value"><b>' + view.minutes + ' min</b><span>this session</span></div>' +
      '<button class="btn" data-action="more" aria-label="More time">+</button>' +
      '</div>';

    html += '<p class="plan-preview">' + planPreview(built) + '</p>';

    html += '<div class="stack" style="margin-top:16px">' +
      '<button class="btn btn-primary btn-block" data-action="start">Start</button>' +
      '<button class="btn btn-quiet btn-block" data-action="skip-today">' +
      (launchInfo.zeroBudgetDay ? 'Not today' : 'Skip today') + '</button>' +
      '</div>';

    html += '</section>';

    html += renderForecast(launchInfo.forecast, today);

    root.innerHTML = html;
  }

  function nextDueSummary(today) {
    var s = A.state(), best = null;
    A.reviewUnits().forEach(function (p) {
      if (!A.isScheduled(p) || !p.nextDue) return;
      if (!best || A.daysBetween(p.nextDue, best.nextDue) > 0) best = p;
    });
    if (!best) return 'nothing scheduled';
    var d = A.daysBetween(today, best.nextDue);
    return d <= 1 ? 'tomorrow' : 'in ' + d + ' days';
  }

  function planPreview(b) {
    var parts = [];
    if (b.learning.length) parts.push(plural(b.learning.length, 'learning piece'));
    if (b.maintenance.length) parts.push(b.maintenance.length + ' maintenance');
    if (b.lookahead.length) parts.push(b.lookahead.length + ' pulled forward');
    if (!parts.length) return 'Nothing fits in ' + b.budgetMin + ' minutes.';

    var out = parts.join(' · ') + ' — about ' + mins(b.plannedMin) + ' min.';

    if (b.learningYielded > 0) {
      out += '<br><span class="defer">' + plural(b.learningYielded, 'learning slot') +
        ' paused below your ' + b.referenceMin + '-minute target.</span>';
    }
    if (b.deferredCount > 0) {
      out += '<br><span class="defer">' + plural(b.deferredCount, 'review') +
        ' deferred (' + mins(b.deferredMin) + ' min).</span>';
    }
    if (b.overshot) out += '<br>Runs slightly over to keep a badly overdue piece in.';
    if (b.learningExceedsBudget) out += '<br>Learning alone exceeds the budget — that is the whole session.';
    if (b.excessLearners > 0) {
      out += '<br><span class="defer">' + plural(b.excessLearners, 'extra learning piece') +
        ' beyond your limit of ' + A.state().settings.maxLearning + '.</span>';
    }
    return out;
  }

  function renderNotices(today) {
    var html = '';
    var g = launchInfo.gap;
    if (g.show && !view.dismissedGap) {
      html += '<div class="notice"><p>' + plural(g.missedDays, 'practice day') +
        ' since your last session — ' + plural(g.count, 'review') + ' re-prioritised.</p>' +
        '<button class="dismiss" data-action="dismiss-gap" aria-label="Dismiss">&times;</button></div>';
    }
    if (launchInfo.nudge && !view.dismissedNudge) {
      var n = launchInfo.nudge;
      html += '<div class="notice notice-warn"><p>Your repertoire now needs about ' +
        mins(n.totalDemandPerDay) + ' min a day and you are practising about ' +
        mins(n.supplyPerDay) + '. Two ways back: pause learning, or raise the daily budget.</p>' +
        '<button class="dismiss" data-action="dismiss-nudge" aria-label="Dismiss">&times;</button></div>';
    }
    if (launchInfo.exportReminder && !view.dismissedExport) {
      html += '<div class="notice"><p>No backup for ' +
        plural(launchInfo.exportReminder.days, 'day') + '. ' +
        '<button class="btn btn-sm" data-action="export" style="margin-left:4px">Export</button></p>' +
        '<button class="dismiss" data-action="dismiss-export" aria-label="Dismiss">&times;</button></div>';
    }
    if (launchInfo.storagePersistent === false) {
      html += '<div class="notice notice-warn"><p>Storage is not persisting in this browser. ' +
        'Export before you close the tab.</p></div>';
    }
    return html;
  }

  function renderForecast(forecast, today) {
    var max = 1;
    forecast.forEach(function (d) { max = Math.max(max, d.projectedMin, d.budget); });

    var html = '<section class="card forecast">';
    html += '<div class="forecast-head"><h2>Week ahead</h2>' +
      '<span class="tiny faint">projected minutes</span></div>';
    html += '<div class="bars">';
    forecast.forEach(function (d, i) {
      var h = Math.max(2, Math.round(d.projectedMin / max * 100));
      var bl = Math.round(d.budget / max * 100);
      var cls = 'bar' + (d.over ? ' is-over' : '') + (d.budget === 0 ? ' is-zero-day' : '');
      html += '<div class="bar-col' + (i === 0 ? ' is-today' : '') + '">' +
        '<div class="bar-wrap">' +
        (d.budget > 0 ? '<span class="budget-line" style="bottom:' + bl + '%"></span>' : '') +
        '<span class="' + cls + '" style="height:' + h + '%" title="' +
        mins(d.projectedMin) + ' min"></span>' +
        '</div>' +
        '<span class="bar-label">' + DAYS_SHORT[d.weekday] + '</span>' +
        '</div>';
    });
    html += '</div>';

    var over = forecast.filter(function (d) { return d.over; });
    if (over.length) {
      var worst = over.slice().sort(function (a, b) { return b.overBy - a.overBy; })[0];
      html += '<p class="tiny muted" style="margin:10px 0 0">' +
        DAYS[worst.weekday] + ' is projected ' + mins(worst.overBy) + ' min over budget. ' +
        'Spare minutes today pull some of it forward.</p>';
    } else {
      html += '<p class="tiny muted" style="margin:10px 0 0">Nothing over budget this week.</p>';
    }
    html += '</section>';
    return html;
  }

  /* ---------- running a session ---------- */

  function renderSession(root, session, today) {
    var it = A.currentItem();
    if (!it) { renderSummary(root, today); return; }

    var p = it.piece;
    var subject = it.subject;
    var sec = it.section;
    var isLearning = it.kind === 'learning' || p.state === 'learning';
    var kindLabel = sec ? 'Section check' : isLearning ? 'Learning' :
      it.kind === 'lookahead' ? 'Pulled forward' : 'Maintenance';
    var prog = A.sessionProgress();

    /* Progress strip doubles as navigation — tap any segment to jump. */
    var html = '<div class="session-view"><div class="progress">';
    for (var i = 0; i < session.plan.length; i++) {
      var r = session.results[i];
      var cls = r ? (r.skipped ? 'skipped' : 'done') : '';
      if (i === session.index) cls += ' now';
      html += '<button class="' + cls.trim() + '" data-action="goto" data-index="' + i +
        '" aria-label="Item ' + (i + 1) + '"></button>';
    }
    html += '</div>';

    html += '<div class="now-playing">';
    html += '<span class="kind-badge">' + kindLabel + ' · ' + (it.index + 1) + ' of ' + it.total + '</span>';
    html += '<p class="np-composer">' + esc(A.composerName(p.composerId)) + '</p>';
    html += '<h1 class="np-title">' + esc(p.title) + '</h1>';
    if (p.catalogue) html += '<p class="np-cat">' + esc(p.catalogue) + '</p>';

    html += '<p class="np-meta">about ' + mins(it.estMin) + ' min';
    if (isLearning) {
      var dl = A.daysLearning(p, today);
      if (dl != null) html += ' · ' + plural(dl, 'day') + ' in learning';
    } else {
      html += ' · every ' + subject.intervalDays + 'd · ' + subject.state;
    }
    html += ' <button class="btn btn-sm btn-quiet np-edit" data-action="edit-piece" data-id="' +
      esc(p.id) + '">Edit</button></p>';

    if (sec) {
      var prompt = sec.prompt === 'transition' ? 'Play the lead-in and transition into ' :
        sec.prompt === 'recover' ? 'Pause just before this point, then resume from memory: ' : 'Start from memory at ';
      var bars = sec.startBar ? ' · bar ' + sec.startBar + (sec.endBar ? '–' + sec.endBar : '') : '';
      html += '<div class="section-prompt"><strong>' + esc(prompt + sec.label) + '</strong>' +
        '<p class="small">' + esc(bars ? bars.slice(3) : '') + '</p>' +
        '<p class="small muted">Check this section before rehearsing it. This result changes only its own schedule.</p>' +
        (sec.notes ? '<p>' + esc(sec.notes) + '</p>' : '') + '</div>';
    } else if (!isLearning) {
      html += '<p class="small muted">' + (p.state === 'repair' ? 'Repair the parts that need work. Grade the first attempt you use to check recall.' :
        'Whole-piece review. Grade your first attempt from memory, before practising this piece.') + '</p>';
    }
    if (p.notes) html += '<div class="np-notes">' + esc(p.notes) + '</div>';
    html += '</div>';

    if (it.result) {
      html += '<p class="recorded-note">' +
        (it.result.skipped ? 'Skipped' + (it.result.pushed ? ' — due tomorrow' : ' — still due')
          : it.result.learning ? 'Practice recorded'
          : it.result.pct != null ? 'Learning recorded'
          : 'Recorded ' + esc(it.result.grade)) +
        ' · <button class="btn btn-sm btn-quiet" data-action="undo-item">Undo</button></p>';
    }

    if (isLearning) {
      html += renderLearningControl(p, it);
    } else {
      html += '<div class="grades">' +
        '<button class="grade" data-grade="clean">Clean</button>' +
        '<button class="grade" data-grade="wobbled">Wobbled</button>' +
        '<button class="grade" data-grade="broke">Broke down</button>' +
        '</div>' + gradeHelp();
    }

    html += '<div class="nav-row">' +
      '<button class="btn btn-quiet" data-action="prev-item"' +
      (it.index === 0 ? ' disabled' : '') + '>&larr; Back</button>' +
      '<button class="btn btn-quiet" data-action="skip-item">Skip</button>' +
      '<button class="btn btn-quiet" data-action="next-item"' +
      (it.index >= it.total - 1 ? ' disabled' : '') + '>Next &rarr;</button>' +
      '</div>';

    html += '<div class="skip-row"><button class="btn btn-quiet small" data-action="finish-session">' +
      'Finish session' + (prog.remaining ? ' (' + prog.remaining + ' left)' : '') +
      '</button></div>';

    html += '</div>';
    root.innerHTML = html;
  }

  function gradeHelp() {
    return '<details class="grade-help"><summary>What do the grades mean?</summary>' +
      '<p><b>Clean:</b> Recalled independently at the intended tempo, with no meaningful memory hesitation.</p>' +
      '<p><b>Wobbled:</b> Recalled without the score, but hesitated or needed to recover.</p>' +
      '<p><b>Broke down:</b> Needed the score, a prompt, or substantial reconstruction.</p>' +
      '<p>An isolated wrong note need not be a memory failure. Grade recall before practising the piece or section.</p>' +
      '<p>Repair ends after three Clean checks on separate days. Wobbled does not count; Broke down restarts the count.</p></details>';
  }

  function renderLearningControl(p, it) {
    var last = p.history.filter(function (h) { return h.type === 'learning' && h.achievement; }).slice(-1)[0];
    return '<div class="learning-record">' +
      '<div class="field"><label for="learning-focus">Today’s focus</label>' +
      '<textarea id="learning-focus" placeholder="Bars 17–24, hands together">' + esc(p.learningFocus) + '</textarea></div>' +
      (last ? '<p class="small muted">Last time: ' + esc(last.achievement) + '</p>' : '') +
      '<div class="field"><label for="learning-achievement">What can you do now?</label>' +
      '<textarea id="learning-achievement" placeholder="From memory at 80 bpm; transition still uncertain">' +
      esc(it.result && it.result.achievement || '') + '</textarea></div>' +
      '<div class="field"><label for="learning-next">Next focus</label>' +
      '<textarea id="learning-next" placeholder="Join bars 24–25 without stopping">' +
      esc(it.result && it.result.nextFocus || '') + '</textarea></div>' +
      '<button class="btn btn-primary btn-block" data-action="save-learning">Record practice</button></div>';
  }

  function renderSummary(root, today) {
    var sum = A.sessionSummary(today);
    if (!sum) { A.endSession(); refresh(); return; }

    var html = '<h1>Done</h1>';
    html += '<p class="date-line">' + esc(longDate(sum.date)) + '</p>';

    html += '<section class="card"><ul class="summary-list">';
    sum.rows.forEach(function (row) {
      var p = row.piece;
      var r = row.result;
      var subject = row.section || p;
      var label, detail = '';
      if (!r) {
        label = 'not done';
      } else if (r.skipped) {
        label = 'skipped';
        detail = r.pushed ? 'tomorrow' : 'still due';
      } else if (r.learning) {
        label = 'learning';
        detail = r.achievement || r.nextFocus || 'practice recorded';
      } else if (r.pct != null) {
        label = r.pct + '%';
        var prev = r.change && r.change.from ? r.change.from.learnedPct : null;
        detail = prev != null && prev !== r.pct ? 'was ' + prev + '%' : 'learning';
      } else {
        label = r.grade;
        if (r.change && r.change.enteredRepair) detail = 'into repair';
        else if (r.change && r.change.leftRepair) detail = 'back to established · ' + subject.intervalDays + 'd';
        else detail = 'every ' + subject.intervalDays + 'd';
      }
      html += '<li><span class="g" data-grade="' + esc(r && r.pct != null ? 'pct' : label) + '">' +
        esc(label) + '</span>' +
        '<span class="t">' + esc(p.title + (row.section ? ' — ' + row.section.label : '')) + '</span>' +
        '<span class="d">' + esc(detail) + '</span></li>';
    });
    html += '</ul></section>';

    if (sum.untouched.length) {
      html += '<div class="notice"><p>' + plural(sum.untouched.length, 'review') +
        ' left untouched — they stay exactly as they were.</p></div>';
    }

    if (sum.deferredCount > 0) {
      html += '<div class="notice"><p>' + plural(sum.deferredCount, 'review') +
        ' deferred today (' + mins(sum.deferredMin) + ' min). They stay due and rank higher next time.</p></div>';
    }

    html += '<section class="card"><h2 style="font-size:0.95rem;margin:0 0 6px">Tomorrow</h2>' +
      '<p class="small muted" style="margin:0">' +
      (sum.dueTomorrow.length
        ? plural(sum.dueTomorrow.length, 'review') + ' due, about ' + mins(sum.dueTomorrowMin) + ' min'
        : 'Nothing due') +
      '</p></section>';

    html += '<button class="btn btn-primary btn-block" data-action="close-summary">Close</button>';
    if (sum.untouched.length) {
      html += '<button class="btn btn-block btn-quiet" style="margin-top:8px" data-action="resume-session">' +
        'Back to the session</button>';
    }
    root.innerHTML = html;
  }

  /* ------------------------------------------------------------------ *
   * Repertoire
   * ------------------------------------------------------------------ */

  function renderRepertoire() {
    var today = launchInfo.today;
    var root = el('screen-repertoire');
    var s = A.state();
    var html = '';

    html += '<div class="row-between"><h1>Repertoire</h1>' +
      '<button class="btn btn-sm" data-action="add-piece">Add piece</button></div>';
    html += '<p class="date-line">' + s.pieces.length + ' pieces · ' + s.composers.length + ' composers</p>';

    html += renderCapacityCard();

    html += '<div class="filters">';
    html += '<input type="search" id="f-search" placeholder="Search title, composer, tag, note" value="' +
      esc(view.filters.search) + '">';
    html += '<select id="f-tier"><option value="">All tiers</option>' +
      [0, 1, 2, 3].map(function (t) {
        return '<option value="' + t + '"' + (view.filters.tier === String(t) ? ' selected' : '') +
          '>Tier ' + t + '</option>';
      }).join('') + '</select>';
    html += '<select id="f-state"><option value="">All states</option>' +
      A.STATES.map(function (st) {
        return '<option value="' + st + '"' + (view.filters.state === st ? ' selected' : '') +
          '>' + st + '</option>';
      }).join('') + '</select>';
    html += '<select id="f-composer"><option value="">All composers</option>' +
      s.composers.slice().sort(function (a, b) {
        return a.canonicalName < b.canonicalName ? -1 : 1;
      }).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (view.filters.composerId === c.id ? ' selected' : '') +
          '>' + esc(c.canonicalName) + '</option>';
      }).join('') + '</select>';
    html += '</div>';

    var filtered = A.filterPieces({
      tier: view.filters.tier === '' ? null : +view.filters.tier,
      state: view.filters.state || null,
      composerId: view.filters.composerId || null,
      search: view.filters.search
    }, today);

    var groups = A.groupByTier(filtered);
    var any = false;

    groups.forEach(function (g) {
      if (!g.pieces.length) return;
      any = true;
      var open = view.openTiers[g.tier];
      html += '<div class="tier-group">';
      html += '<button class="tier-head" data-action="toggle-tier" data-tier="' + g.tier + '">' +
        '<span class="chev">' + (open ? '▾' : '▸') + '</span>' +
        '<span>Tier ' + g.tier + '</span>' +
        '<span class="n">' + g.pieces.length + '</span></button>';
      if (open) {
        g.pieces.forEach(function (p) {
          var bits = pieceLine(p, today);
          var overdue = A.isDue(p, today);
          html += '<button class="piece-row" data-action="edit-piece" data-id="' + esc(p.id) + '">' +
            '<span class="pr-top">' +
            '<span class="pr-name">' + esc(A.composerName(p.composerId)) + ' — ' + esc(p.title) + '</span>' +
            (p.catalogue ? '<span class="pr-cat">' + esc(p.catalogue) + '</span>' : '') +
            '</span>' +
            '<span class="pr-meta' + (overdue ? ' pr-due-now' : '') + '">' +
            '<span class="st" data-state="' + esc(p.state) + '">' + esc(bits[0]) + '</span>' +
            (bits.length > 1 ? ' · ' + bits.slice(1).map(esc).join(' · ') : '') +
            (A.suggestsPromotion(p, today) ? ' · ready to promote?' : '') +
            '</span>' +
            (p.notes ? '<span class="pr-notes">' + esc(p.notes) + '</span>' : '') +
            '</button>';
        });
      }
      html += '</div>';
    });

    if (!any) html += '<div class="empty-state"><p>No pieces match.</p></div>';

    html += '<div class="stack" style="margin-top:22px">' +
      '<button class="btn btn-block" data-action="export">Export backup</button>' +
      '<button class="btn btn-block" data-action="copy-export">Copy backup to clipboard</button>' +
      '<button class="btn btn-block" data-action="import">Import JSON</button>' +
      '</div>';

    root.innerHTML = html;

    el('f-search').oninput = function () { view.filters.search = this.value; renderRepertoire(); this.focus(); };
    el('f-tier').onchange = function () { view.filters.tier = this.value; renderRepertoire(); };
    el('f-state').onchange = function () { view.filters.state = this.value; renderRepertoire(); };
    el('f-composer').onchange = function () { view.filters.composerId = this.value; renderRepertoire(); };
  }

  function renderCapacityCard() {
    var r = launchInfo.capacity;
    var pct = Math.min(140, Math.round(r.ratio * 100));
    var basisNote = r.supplyBasis === 'observed'
      ? 'from ' + mins(r.observed.sessionDaysPerWeek) + ' session days a week actually practised'
      : 'from your configured budget — ' + r.observed.spanDays + ' of ' + r.observed.needsDays +
        ' days logged so far';

    var html = '<section class="card capacity-card">';
    html += '<div class="row-between"><span class="big">' + Math.round(r.ratio * 100) + '%</span>' +
      '<span class="tiny faint">of capacity</span></div>';
    html += '<div class="meter"><i class="' + (r.over ? 'is-over' : '') +
      '" style="width:' + Math.min(100, pct) + '%"></i></div>';
    html += '<dl>' +
      '<dt>Maintenance load</dt><dd>' + mins(r.maintenanceLoadPerDay) + ' min/day</dd>' +
      '<dt>Learning load</dt><dd>' + mins(r.learningLoadPerDay) + ' min/day</dd>' +
      '<dt><b>Total demand</b></dt><dd><b>' + mins(r.totalDemandPerDay) + ' min/day</b></dd>' +
      '<dt>Supply (' + r.supplyBasis + ')</dt><dd>' + mins(r.supplyPerDay) + ' min/day</dd>' +
      '</dl>';
    html += '<p class="tiny faint" style="margin:10px 0 0">' + esc(basisNote) + '.';
    if (r.observed.daysLogged > 0) {
      html += ' Last 30 days: ' + mins(r.observed.meanPractisedPerDay) + ' estimated min/day completed, ' +
        plural(r.observed.deferredItems, 'item') + ' deferred.';
    }
    html += '</p>';
    html += '</section>';
    return html;
  }

  /* ------------------------------------------------------------------ *
   * Editor sheet
   * ------------------------------------------------------------------ */

  function openSheet(html) {
    var sheet = el('sheet');
    sheet.querySelector('.sheet-panel').innerHTML = html;
    sheet.hidden = false;
  }

  function closeSheet() {
    el('sheet').hidden = true;
    view.editing = null;
    view.editingIsNew = false;
    view.composerQuery = '';
  }

  function openEditor(id) {
    var p = id ? A.pieceById(id) : null;
    view.editingIsNew = !p;
    view.editing = p
      ? JSON.parse(JSON.stringify(p))
      : A.normalizePiece({ id: '', title: '', composerId: '', state: 'backlog', durationMin: 3, contentMin: 3, fragility: 3, tier: 0 });
    view.composerQuery = p ? A.composerName(p.composerId) : '';
    renderEditor();
  }

  function renderEditor() {
    var d = view.editing;
    var html = '';

    html += '<div class="row-between" style="margin-bottom:14px">' +
      '<h2 style="margin:0;font-size:1.1rem">' + (view.editingIsNew ? 'Add piece' : 'Edit piece') + '</h2>' +
      '<button class="btn btn-sm btn-quiet" data-action="close-sheet">Cancel</button></div>';

    /* Fragility and both durations first — these are corrected constantly and
       must never be buried under the metadata. */
    html += '<div class="field"><label>Fragility — how fast it decays (caps the interval at ' +
      A.appliedCap(d.fragility) + ' days)</label>' +
      quick('fragility', d.fragility, 0.5) + '</div>';

    html += '<div class="field-row">' +
      '<div class="field"><label>Duration (min, with repeats)</label>' + quick('durationMin', d.durationMin, 0.5) + '</div>' +
      '<div class="field"><label>Content (min, to memorise)</label>' + quick('contentMin', d.contentMin, 0.5) + '</div>' +
      '</div>';

    html += '<div class="field"><label>Title</label>' +
      '<input data-field="title" value="' + esc(d.title) + '" placeholder="Prelude in G minor"></div>';

    html += '<div class="field"><label>Catalogue</label>' +
      '<input data-field="catalogue" value="' + esc(d.catalogue) + '" placeholder="Op. 23 No. 5"></div>';

    html += renderComposerField(d);

    html += '<div class="field-row">' +
      '<div class="field"><label>Tier</label><select data-field="tier">' +
      [0, 1, 2, 3].map(function (t) {
        return '<option value="' + t + '"' + (d.tier === t ? ' selected' : '') + '>Tier ' + t + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>State</label><select data-field="state">' +
      A.STATES.map(function (st) {
        return '<option value="' + st + '"' + (d.state === st ? ' selected' : '') + '>' + st + '</option>';
      }).join('') + '</select></div>' +
      '</div>';

    if (d.state === 'learning') {
      html += '<div class="field"><label>Next practice focus</label>' +
        '<textarea data-field="learningFocus" placeholder="Bars, hands, memory, tempo, or transition">' +
        esc(d.learningFocus) + '</textarea></div>';
    }

    if (d.state !== 'backlog' && d.state !== 'learning') {
      html += '<div class="field-row">' +
        '<div class="field"><label>Interval (days)</label>' +
        '<input type="number" min="1" step="1" data-field="intervalDays" value="' + (d.intervalDays || '') + '"></div>' +
        '<div class="field"><label>Next due</label>' +
        '<input type="date" data-field="nextDue" value="' + esc(d.nextDue || '') + '"></div>' +
        '</div>';
    }

    html += '<div class="field-row">' +
      '<div class="field"><label>Prior knowledge</label><select data-field="priorKnowledge">' +
      ['new', 'played', 'near'].map(function (k) {
        return '<option value="' + k + '"' + (d.priorKnowledge === k ? ' selected' : '') + '>' + k + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>Tags (comma separated)</label>' +
      '<input data-field="tags" value="' + esc(d.tags.join(', ')) + '"></div>' +
      '</div>';

    html += '<div class="field"><label>Notes</label>' +
      '<textarea data-field="notes" placeholder="Shown while you play">' + esc(d.notes) + '</textarea></div>';

    html += '<div class="field"><label>Sections (' + d.sections.length + ')</label>' +
      '<p class="tiny muted">Each has its own schedule and repair state. Whole-piece reviews continue separately. Checks start after the piece leaves learning.</p>';
    d.sections.forEach(function (sec, i) {
      function input(field, label, type, extra) {
        return '<div class="field"><label>' + label + '</label><input type="' + (type || 'text') +
          '" data-section="' + i + '" data-section-field="' + field + '" value="' +
          esc(sec[field] == null ? '' : sec[field]) + '" ' + (extra || '') + '></div>';
      }
      html += '<details class="section-editor"><summary>' + esc(sec.label || 'New section') +
        ' <span class="tiny muted">' + (sec.enabled === false ? 'paused' : esc(sec.state || 'consolidating')) + '</span></summary>' +
        input('label', 'Name / landmark') +
        '<div class="field-row">' + input('startBar', 'First bar', 'number', 'min="1"') + input('endBar', 'Last bar', 'number', 'min="1"') + '</div>' +
        '<div class="field"><label>Prompt</label><select data-section="' + i + '" data-section-field="prompt">' +
        [['start', 'Start here from memory'], ['transition', 'Play the transition into here'], ['recover', 'Pause, then resume here']].map(function (x) {
          return '<option value="' + x[0] + '"' + (sec.prompt === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field-row">' + input('durationMin', 'Playing time (min)', 'number', 'min="0.25" step="0.25"') +
        input('fragilityOverride', 'Fragility (blank = piece)', 'number', 'min="1" max="5" step="0.5"') + '</div>' +
        input('notes', 'Practice note') +
        '<div class="field-row">' + input('intervalDays', 'Interval (days)', 'number', 'min="1"') + input('nextDue', 'Next due', 'date') + '</div>' +
        '<label class="check-label"><input type="checkbox" data-section="' + i + '" data-section-field="enabled"' +
        (sec.enabled !== false ? ' checked' : '') + '> Include in reviews</label>' +
        '<p class="tiny muted">' + esc(sec.lastColdCall ? 'Last checked ' + sec.lastColdCall : 'Not checked in this app yet') +
        ' · ' + plural((sec.history || []).length, 'check') + '</p>' +
        '<button class="btn btn-sm danger" data-action="del-section" data-index="' + i + '">Delete section</button></details>';
    });
    html += '<button class="btn btn-sm" style="margin-top:9px" data-action="add-section">Add section</button></div>';

    if (!view.editingIsNew) {
      var live = A.pieceById(d.id);
      if (live) {
        var extra = [];
        if (live.lapses) extra.push(plural(live.lapses, 'lapse'));
        if (live.dateFirstLearned) extra.push('first learned ' + live.dateFirstLearned);
        if (live.lastPlayed) extra.push('last played ' + live.lastPlayed);
        extra.push(plural(live.history.length, 'session') + ' logged');
        html += '<p class="tiny faint">' + esc(extra.join(' · ')) + '</p>';
        var recent = live.history.filter(function (h) { return h.achievement || h.focus; }).slice(-5).reverse();
        if (recent.length) html += '<details class="grade-help"><summary>Recent learning notes</summary>' + recent.map(function (h) {
          return '<p><b>' + esc(h.date) + '</b><br>' + esc(h.achievement || h.focus) +
            (h.nextFocus ? '<br>Next: ' + esc(h.nextFocus) : '') + '</p>';
        }).join('') + '</details>';
      }
    }

    html += '<div class="sheet-actions">' +
      '<button class="btn btn-primary" data-action="save-piece">Save</button>';
    if (!view.editingIsNew) {
      if (d.state === 'backlog') html += '<button class="btn" data-action="start-learning">Start learning</button>';
      if (d.state === 'learning' || d.state === 'consolidating') {
        html += '<button class="btn" data-action="promote">Promote</button>';
      }
    }
    html += '</div>';

    if (!view.editingIsNew) {
      html += '<button class="btn btn-block danger" style="margin-top:9px" data-action="delete-piece">Delete piece</button>';
    }

    openSheet(html);
  }

  function quick(field, value, step) {
    return '<div class="quick">' +
      '<button data-action="bump" data-field="' + field + '" data-step="' + (-step) + '">&minus;</button>' +
      '<output>' + mins(value) + '</output>' +
      '<button data-action="bump" data-field="' + field + '" data-step="' + step + '">+</button>' +
      '</div>';
  }

  function renderComposerField(d) {
    var q = view.composerQuery;
    var current = A.composerById(d.composerId);
    var matches = q && (!current || current.canonicalName !== q) ? A.searchComposers(q).slice(0, 6) : [];

    var html = '<div class="field autocomplete"><label>Composer</label>' +
      '<input data-field="composerQuery" value="' + esc(q) + '" placeholder="Start typing — matches aliases too" autocomplete="off">';
    if (matches.length) {
      html += '<ul class="ac-list">';
      matches.forEach(function (c) {
        html += '<li><button data-action="pick-composer" data-id="' + esc(c.id) + '">' +
          esc(c.canonicalName) +
          (c.aliases.length ? ' <span class="alias">' + esc(c.aliases.join(', ')) + '</span>' : '') +
          '</button></li>';
      });
      html += '</ul>';
    }
    if (q && !matches.length) {
      html += '<ul class="ac-list"><li><button data-action="new-composer">Add “' + esc(q) + '” as a new composer</button></li></ul>';
    }
    if (!q && !d.composerId) {
      html += '<p class="tiny faint" style="margin:6px 0 0">Required — pieces are always joined to a composer record.</p>';
    }
    html += '</div>';
    return html;
  }

  function renderNewComposer(name) {
    openSheet(
      '<h2 style="margin:0 0 14px;font-size:1.1rem">New composer</h2>' +
      '<div class="field"><label>Canonical name</label><input id="nc-name" value="' + esc(name) + '"></div>' +
      '<div class="field"><label>Era</label><input id="nc-era" placeholder="Late Romantic"></div>' +
      '<div class="field"><label>Nationality</label><input id="nc-nat" placeholder="Russian"></div>' +
      '<div class="field"><label>Aliases (comma separated)</label><input id="nc-alias" placeholder="Rachmaninov, Rakhmaninov"></div>' +
      '<div class="sheet-actions">' +
      '<button class="btn btn-primary" data-action="save-composer">Add</button>' +
      '<button class="btn" data-action="back-to-editor">Back</button></div>'
    );
  }

  /* ------------------------------------------------------------------ *
   * Export / import
   * ------------------------------------------------------------------ */

  function doExport() {
    var text = A.exportJSON();
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = A.exportFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    view.dismissedExport = true;
    refresh();
  }

  function doCopyExport() {
    var text = JSON.stringify(A.exportPayload(), null, 2);
    var done = function () {
      A.markExported();
      view.dismissedExport = true;
      alert('Backup copied to the clipboard. Paste it somewhere safe.');
      refresh();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { alert('Could not copy.'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { alert('Could not copy.'); }
      document.body.removeChild(ta);
    }
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var json;
      try { json = JSON.parse(reader.result); }
      catch (e) { alert('That file is not valid JSON.'); return; }

      var pv = A.previewImport(json);
      if (!pv.ok) { alert('Unrecognised file format.'); return; }

      var msg;
      if (pv.mode === 'replace') {
        msg = 'Full backup: ' + pv.pieces + ' pieces, ' + pv.sections + ' sections, ' +
          pv.composers + ' composers.\n\nThis REPLACES everything currently stored. Continue?';
      } else {
        msg = pv.pieces + ' pieces, ' + pv.sections + ' sections, ' + pv.composers + ' composer.\n' +
          pv['new'] + ' new, ' + pv.updated + ' updated.\n\nImport?';
      }
      if (!confirm(msg)) return;
      A.commitImport(pv);
      view.minutes = null;
      refresh();
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action], [data-grade], [data-tab]');
    if (!t) return;

    var tab = t.getAttribute('data-tab');
    if (tab) { view.tab = tab; render(); return; }

    if (t.classList.contains('grade')) {
      A.gradeCurrent(t.getAttribute('data-grade'));
      view.pctFor = null;
      renderToday();
      window.scrollTo(0, 0);
      return;
    }

    var action = t.getAttribute('data-action');
    var d = view.editing;

    switch (action) {
      case 'more':
        view.minutes += 5;
        renderToday();
        break;
      case 'less':
        view.minutes = Math.max(5, view.minutes - 5);
        renderToday();
        break;
      case 'start':
        A.startSession(view.minutes);
        refresh();
        window.scrollTo(0, 0);
        break;
      case 'skip-today':
        A.skipToday();
        view.minutes = null;
        refresh();
        break;
      case 'skip-item':
        A.skipCurrent();
        view.pctFor = null;
        renderToday();
        window.scrollTo(0, 0);
        break;

      /* --- moving around inside a session --- */
      case 'goto':
        A.goToIndex(+t.getAttribute('data-index'));
        view.pctFor = null;
        renderToday();
        window.scrollTo(0, 0);
        break;
      case 'prev-item':
        A.stepIndex(-1);
        view.pctFor = null;
        renderToday();
        window.scrollTo(0, 0);
        break;
      case 'next-item':
        A.stepIndex(1);
        view.pctFor = null;
        renderToday();
        window.scrollTo(0, 0);
        break;
      case 'undo-item':
        A.undoCurrent();
        view.pctFor = null;
        renderToday();
        break;
      case 'finish-session':
        A.finishSession();
        renderToday();
        window.scrollTo(0, 0);
        break;
      case 'resume-session': {
        var sum = A.sessionSummary();
        var first = sum && sum.untouched.length ? sum.untouched[0].index : 0;
        A.goToIndex(first);
        view.pctFor = null;
        renderToday();
        window.scrollTo(0, 0);
        break;
      }

      case 'save-learning':
        A.setLearningCurrent({focus: el('learning-focus').value, achievement: el('learning-achievement').value, nextFocus: el('learning-next').value});
        renderToday(); window.scrollTo(0, 0); break;
      case 'retry-save': A.save(); renderSaveStatus(); break;

      case 'close-summary':
        A.endSession();
        view.minutes = null;
        view.pctFor = null;
        refresh();
        break;
      case 'browse-backlog':
        view.tab = 'repertoire';
        view.filters = { tier: '', state: 'backlog', composerId: '', search: '' };
        render();
        window.scrollTo(0, 0);
        break;
      case 'dismiss-gap': view.dismissedGap = true; renderToday(); break;
      case 'dismiss-nudge': view.dismissedNudge = true; renderToday(); break;
      case 'dismiss-export': view.dismissedExport = true; renderToday(); break;

      case 'toggle-tier': {
        var tier = t.getAttribute('data-tier');
        view.openTiers[tier] = !view.openTiers[tier];
        renderRepertoire();
        break;
      }
      case 'edit-piece': openEditor(t.getAttribute('data-id')); break;
      case 'add-piece': openEditor(null); break;
      case 'close-sheet': closeSheet(); break;

      case 'bump': {
        var f = t.getAttribute('data-field');
        var step = parseFloat(t.getAttribute('data-step'));
        var next = Math.round((d[f] + step) * 10) / 10;
        if (f === 'fragility') next = Math.max(1, Math.min(5, next));
        else next = Math.max(0.1, next);
        d[f] = next;
        renderEditor();
        break;
      }
      case 'pick-composer': {
        d.composerId = t.getAttribute('data-id');
        view.composerQuery = A.composerName(d.composerId);
        renderEditor();
        break;
      }
      case 'new-composer': renderNewComposer(view.composerQuery); break;
      case 'back-to-editor': renderEditor(); break;
      case 'save-composer': {
        var name = el('nc-name').value.trim();
        if (!name) { alert('A canonical name is required.'); return; }
        var c = A.addComposer({
          canonicalName: name,
          era: el('nc-era').value.trim(),
          nationality: el('nc-nat').value.trim(),
          aliases: el('nc-alias').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean)
        });
        d.composerId = c.id;
        view.composerQuery = c.canonicalName;
        renderEditor();
        break;
      }
      case 'add-section': {
        var n = 1; while (d.sections.some(function (sec) { return sec.id === 's' + n; })) n++;
        d.sections.push(A.normalizeSection({ id: 's' + n, label: '' }, d.sections.length));
        renderEditor();
        var editors = document.querySelectorAll('.section-editor');
        if (editors.length) { editors[editors.length - 1].open = true; editors[editors.length - 1].querySelector('input').focus(); }
        break;
      }
      case 'del-section': {
        d.sections.splice(+t.getAttribute('data-index'), 1);
        renderEditor();
        break;
      }
      case 'save-piece': savePiece(); break;
      case 'delete-piece': {
        if (confirm('Delete “' + d.title + '” and its history? This cannot be undone.')) {
          A.deletePiece(d.id);
          closeSheet();
          refresh();
        }
        break;
      }
      case 'start-learning': {
        savePiece(true);
        A.startLearning(d.id);
        closeSheet();
        refresh();
        break;
      }
      case 'promote': {
        savePiece(true);
        A.promote(d.id);
        closeSheet();
        refresh();
        break;
      }
      case 'export': doExport(); break;
      case 'copy-export': doCopyExport(); break;
      case 'import': el('import-file').click(); break;
    }
  });

  /* Text inputs in the sheet write straight into the draft. */
  document.addEventListener('input', function (e) {
    var d = view.editing;
    if (!d) return;
    var f = e.target.getAttribute('data-field');
    if (f === 'composerQuery') { view.composerQuery = e.target.value; renderComposerLater(); return; }
    if (f) { d[f] = e.target.value; return; }
    var si = e.target.getAttribute('data-section');
    if (si != null) {
      var sf = e.target.getAttribute('data-section-field') || 'label';
      d.sections[+si][sf] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    }
  });

  /* Re-render only the composer block so typing does not lose focus. */
  var acTimer = null;
  function renderComposerLater() {
    clearTimeout(acTimer);
    acTimer = setTimeout(function () {
      var wrap = document.querySelector('.autocomplete');
      if (!wrap) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = renderComposerField(view.editing);
      wrap.parentNode.replaceChild(tmp.firstChild, wrap);
      var input = document.querySelector('[data-field="composerQuery"]');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }, 120);
  }

  function savePiece(silent) {
    var d = view.editing;
    if (!d.title.trim()) { alert('A title is required.'); return; }
    if (!d.composerId) { alert('Pick a composer — pieces are always joined to a composer record.'); return; }

    var fields = {
      title: d.title, catalogue: d.catalogue, composerId: d.composerId,
      tier: +d.tier, state: d.state, durationMin: d.durationMin, contentMin: d.contentMin,
      fragility: d.fragility, priorKnowledge: d.priorKnowledge, notes: d.notes, learningFocus: d.learningFocus,
      tags: String(d.tags).split(',').map(function (x) { return x.trim(); }).filter(Boolean)
    };

    var previous = A.pieceById(d.id);
    if (d.state !== 'backlog' && d.state !== 'learning' && (!previous || previous.state === d.state)) {
      if (d.intervalDays) fields.intervalDays = +d.intervalDays;
      if (d.nextDue) fields.nextDue = d.nextDue;
    }

    var saved;
    if (view.editingIsNew) {
      saved = A.addPiece(fields);
      d.id = saved.id;
      view.editingIsNew = false;
    } else {
      saved = A.updatePiece(d.id, fields);
    }

    A.replaceSections(d.id, d.sections);

    /* Editing mid-session: a changed duration must move the estimate for any
     * item not yet recorded, or the plan silently disagrees with itself. */
    A.refreshPlanEstimate(d.id);

    if (!silent) { closeSheet(); refresh(); }
  }

  el('import-file').addEventListener('change', function () {
    if (this.files && this.files[0]) handleImportFile(this.files[0]);
    this.value = '';
  });

  /* Registration is best-effort: file:// and any non-secure origin will
     reject it, and the app works fine without it. */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* no offline cache */ });
    });
  }

  boot();
})();
