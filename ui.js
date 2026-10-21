/* ui.js — rendering and events. All business logic lives in app.js; this
 * file reads from App and calls into it, and holds only view state. */
(function () {
  'use strict';

  var A = window.App;

  /* View state only — nothing here is persisted. */
  var view = {
    tab: 'today',
    extra: false,
    day: null,
    logDate: null,
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
      if (p.sectionFirst) { var sp = A.sectionProgress(p); bits.push(sp.passed + '/' + sp.total + ' hot spots clean'); }
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
    A.correctCatalogue();
    A.correctPreludeStates();
    A.updatePracticePreferences();
    A.expandRepertoire();
    A.enableDemandPlanning();
    A.refinePracticeRules();
    A.subscribe(renderSaveStatus);
    renderSaveStatus();
    view.booted = true;
    refresh();
  }

  function refresh() {
    launchInfo = A.launch();
    if (view.day !== launchInfo.today) { view.day = launchInfo.today; view.extra = false; view.minutes = null; }
    if (A.practiceLog(launchInfo.today).length || A.state().sessionArchive.some(function (s) { return s.date === launchInfo.today; })) view.extra = true;
    if (view.minutes == null) view.minutes = view.extra ? 15 : launchInfo.recommended || launchInfo.budget || 45;
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
    if (session && session.paused) { renderPaused(root, session, today); return; }
    if (session && ((session.warmup && session.warmup.status === 'pending') || session.index < session.plan.length)) { renderSession(root, session, today); return; }
    if (session) { renderSummary(root, today); return; }
    renderLaunch(root, today);
  }

  function renderLaunch(root, today) {
    var c = launchInfo.counts;
    var built = A.buildSession(view.minutes, today, {extra:view.extra});
    var html = '';

    html += '<h1>Today</h1>';
    html += '<p class="date-line">' + esc(longDate(today)) + '</p>';

    html += renderNotices(today);
    html += renderPracticeLog(today);
    html += renderSavedPlans(today);
    if (A.state().settings.onBreak) {
      root.innerHTML = html + '<section class="card"><h2>Taking a break</h2><p>No piano or no time: your records are saved. Review dates keep their meaning; missed days are not failures.</p><button class="btn btn-primary btn-block" data-action="end-break">I’m ready to practise</button></section>'; return;
    }
    if (A.state().settings.skippedDate === today) {
      root.innerHTML = html + '<section class="card"><h2>Taking today off</h2><p>Your pieces stay on their existing schedules.</p><button class="btn btn-block" data-action="unskip-day">I have time after all</button></section>'; return;
    }

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
    if (nothingToDo && c.learning === 0 && c.backlog === c.total) {
      html += '<section class="card"><p class="headline" style="font-size:1.5rem">Nothing scheduled yet</p>' +
        '<p class="ideal-line">' + plural(c.backlog, 'piece') + ' waiting in the backlog. ' +
        'Pick one to start learning. Learning comes last; its time estimate is yours to change.</p>' +
        '<div class="stack" style="margin-top:16px">' +
        '<button class="btn btn-primary btn-block" data-action="browse-backlog">Choose a piece</button>' +
        '<button class="btn btn-quiet btn-block" data-action="import">Import a backup instead</button>' +
        '</div></section>';
      root.innerHTML = html;
      return;
    }

    html += '<section class="card">';
    html += '<h2>' + (view.extra ? 'Extra practice' : 'Plan a session') + '</h2>';

    if (view.extra) {
      html += '<p class="ideal-line">Optional: finish today’s reviews, with one extra full play-through of a learned piece. Learning comes last.</p>';
    } else if (launchInfo.zeroBudgetDay) {
      html += '<p class="headline" style="font-size:1.35rem">No session scheduled</p>';
      html += '<p class="ideal-line">' + esc(DAYS[launchInfo.weekday]) + ' is set to 0 minutes. Practise anyway?</p>';
    } else if (nothingToDo) {
      html += '<p class="headline">Nothing due</p>';
      html += '<p class="ideal-line">Next up ' + esc(nextDueSummary(today)) + '.</p>';
    } else {
      html += '<p class="headline">' + mins(built.plannedMin) + ' <small>min estimated</small></p>';
    }

    var counts = [];
    if (c.learning) counts.push(c.learning + ' learning');
    counts.push(c.due + ' due');
    if (c.repair) counts.push(c.repair + ' in repair');
    if (c.backlog) counts.push(c.backlog + ' in backlog');
    html += '<p class="counts">' + counts.map(function (x) {
      return '<span>' + x + '</span>';
    }).join('') + '</p>';

    if (view.extra) html += '<p><b>' + mins(built.plannedMin) + ' min estimated</b></p>';
    html += '<p class="small muted">No time limit. Reviews are balanced across your practice days; learning comes last.</p>';
    if (built.allowanceMin) html += '<p class="small muted">Includes ' + mins(built.allowanceMin) + ' min for extra work on difficult passages.</p>';

    html += '<p class="plan-preview">' + planPreview(built) + '</p>';
    html += warmupPreview(built.warmup);

    html += '<div class="stack" style="margin-top:16px">' +
      '<button class="btn btn-primary btn-block" data-action="start">' + (view.extra ? 'Start extra practice' : 'Start') + '</button>';
    if (!view.extra) html += '<button class="btn btn-quiet btn-block" data-action="skip-today">' +
      (launchInfo.zeroBudgetDay ? 'Not today' : 'Skip today') + '</button>' +
      '<button class="btn btn-quiet btn-block" data-action="optional-practice">Plan optional practice</button>';
    html += '</div>';

    html += '</section>';

    html += '<div class="row-between session-options"><button class="btn btn-quiet" data-action="start-break">No piano / take a break</button><button class="btn btn-quiet" data-action="practice-settings">Practice settings</button></div>';
    if (view.extra) html += '<details class="card next-session"><summary>Preview next session (' + built.items.length + ' items)</summary><p class="small muted">These are suggestions for your next session, not a record of today’s practice.</p>' + renderPlan(built.items,null,'Suggested next session') + '</details>';
    else html += renderPlan(built.items,null,'Proposed session');
    html += renderForecast(launchInfo.forecast, today);

    root.innerHTML = html;
  }

  function warmupPreview(w) {
    return w && w.minutes ? '<p class="warmup-preview"><b>Start with ' + esc(w.scale) + '</b> · ' + mins(w.minutes) + ' min warmup, included in your time.</p>' : '';
  }

  function renderPracticeLog(today) {
    var date = view.logDate || today, rows = A.practiceLog(date);
    var html = '<section class="card practice-log"><div class="row-between"><h2>' + (date === today ? 'Practised today' : 'Practice record') + '</h2>' +
      '<input aria-label="Practice record date" type="date" id="log-date" value="' + esc(date) + '" max="' + today + '"></div>';
    if (!rows.length) html += '<p class="small muted">No practice recorded for this date.</p>';
    else {
      html += '<ul class="summary-list">';
      rows.forEach(function (r) {
        var result = r.type === 'warmup' ? 'Warmup' : r.grade === 'clean' ? 'Clean' : r.grade === 'wobbled' ? 'Wobbled' : r.grade === 'broke' ? 'Broke down' : 'Recorded';
        html += '<li><span class="g">' + result + '</span><span class="t">' + esc(r.title + (r.section ? ' — ' + r.section : '')) +
          '<span class="plan-meta">' + esc(r.composer) + '</span></span><span class="d">' + esc(r.detail) + '</span></li>';
      });
      html += '</ul>';
    }
    if (date !== today) html += '<button class="btn btn-sm btn-quiet" data-action="log-today">Back to today’s record</button>';
    return html + '</section>';
  }

  function renderSavedPlans(today) {
    var date = view.logDate || today;
    var saved = A.state().sessionArchive.filter(function (s) { return s.date === date && A.unfinishedItems(s).length; });
    if (!saved.length) return '';
    return '<details class="card"><summary>Unfinished plans (' + saved.length + ')</summary>' + saved.map(function (s) {
      var remaining = A.unfinishedItems(s).length;
      return '<p class="small">' + remaining + ' items left from a closed session.</p><button class="btn btn-block" data-action="resume-closed" data-id="' + esc(s.id) + '">Continue unfinished items</button>';
    }).join('') + '</details>';
  }

  function openSettings() {
    var settings = A.state().settings;
    var html = '<h2>Practice settings</h2><p class="small muted">Choose your usual practice days. Due work is balanced across these days, with no daily time limit. You can still practise on a rest day.</p>';
    DAYS.forEach(function(day,i){html += '<label class="check-label"><input id="practice-day-'+i+'" type="checkbox"'+(A.budgetForWeekday(i)>0?' checked':'')+'> '+esc(day)+'</label>';});
    html += '<label class="check-label"><input id="learning-enabled" type="checkbox"'+(settings.learningEnabled?' checked':'')+'> Include learning in sessions</label><p class="tiny muted">Turn off to focus on maintenance. Your learning progress stays saved.</p>';
    html += '<div class="field"><label for="learning-minutes">Estimate per learning piece (minutes)</label><input id="learning-minutes" type="number" min="1" max="180" value="'+settings.learningMinutes+'"><p class="tiny muted">An estimate, not a limit. Hot spots use their own practice allowances.</p></div>';
    html += '<div class="field"><label for="next-scale">Next scale</label><select id="next-scale">' + Array.from({length:24},function (_,index) { var i = Math.floor(A.nextScaleStep() / 24) * 24 + index; return '<option value="' + i + '"' + (i === A.nextScaleStep() ? ' selected' : '') + '>' + esc(A.scaleAtStep(i)) + '</option>'; }).join('') + '</select><p class="tiny muted">Advances only when you complete a scale. Choose a starting point here.</p></div>';
    html += '<div class="field"><label for="warmup-minutes">Scale warmup (minutes; 0 to turn off)</label><input id="warmup-minutes" type="number" min="0" max="5" value="' + settings.warmupMinutes + '"></div>' +
      '<div class="field"><label for="max-learning">Learning pieces per session</label><input id="max-learning" type="number" min="0" max="20" value="' + settings.maxLearning + '"></div>' +
      '<button class="btn btn-primary btn-block" data-action="save-settings">Save settings</button><button class="btn btn-quiet btn-block" data-action="close-sheet">Cancel</button>';
    openSheet(html);
  }

  function renderPlan(items, session, title) {
    var html = '<section class="card day-plan"><h2>' + esc(title || (session ? 'Session overview' : 'Proposed session')) + '</h2>';
    if (!items.length) return html + '<p class="muted">No reviews in this session.</p></section>';
    html += '<ol>';
    items.forEach(function (entry, i) {
      var p = entry.piece || A.pieceById(entry.pieceId);
      if (!p) return;
      var sec = entry.sectionId && p.sections.find(function (x) { return x.id === entry.sectionId; });
      var r = session && session.results[i];
      var status = !r ? 'To do' : r.finished===false ? 'In progress' : r.skipped ? 'Skipped' : r.learning ? 'Recorded' : (r.grade === 'broke' ? 'Broke down' : r.grade === 'clean' ? 'Clean' : 'Wobbled');
      var label = sec ? sec.label : entry.kind === 'continuity' ? 'Full play-through' : entry.kind === 'learning' ? 'Learning' : p.state === 'repair' ? 'Repair' : p.state === 'consolidating' && p.focusedMinutes ? 'Focused practice' : 'Whole piece';
      html += '<li class="' + (r ? 'plan-recorded' : '') + '">' +
        (session ? '<button class="plan-item" data-action="resume-item" data-index="' + i + '">' : '<div class="plan-item">') +
        '<span class="plan-title">' + esc(p.title) + '</span><span class="plan-meta">' +
        esc(A.composerName(p.composerId) + (p.catalogue ? ' · ' + p.catalogue : '')) + '</span>' +
        '<span class="plan-meta">' + esc(label) + ' · ' + mins(entry.estMin) + ' min' +
        (session ? ' · ' + status : '') + '</span>' + (session ? '</button>' : '</div>') + '</li>';
    });
    return html + '</ol></section>';
  }

  function renderPaused(root, session, today) {
    var prog = A.sessionProgress();
    var remaining = session.plan.reduce(function (n,it,i) { return n + (session.results[i] && session.results[i].finished!==false ? 0 : it.estMin); },0);
    root.innerHTML = '<h1>Today</h1><p class="date-line">' + esc(longDate(today)) + '</p>' +
      '<section class="card"><h2>Session paused</h2><p>' + prog.recorded + ' of ' + prog.total +
      ' recorded · about ' + mins(remaining) + ' min left</p>' +
      (session.date !== today ? '<p class="small muted">Continuing the plan from ' + esc(longDate(session.date)) + '.</p>' : '') +
      '<button class="btn btn-primary btn-block" data-action="resume-paused">Resume session</button>' +
      '<button class="btn btn-quiet btn-block" data-action="finish-session">Finish for now</button></section>' +
      '<button class="btn btn-block btn-quiet" data-action="replan">Plan a different session</button>' +
      '<button class="btn btn-block btn-quiet" data-action="start-break">No piano / take a break</button>' +
      renderPlan(session.plan, session) + renderPracticeLog(today);
  }

  function captureLearningDraft() {
    var it = A.currentItem();
    if (it && el('learning-focus')) A.saveLearningDraft({pieceId:it.piece.id,focus:el('learning-focus').value,
      achievement:el('learning-achievement').value,nextFocus:el('learning-next').value});
  }
  function pauseWithDraft() {
    captureLearningDraft(); A.pauseSession(); refresh(); window.scrollTo(0,0);
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
    if (b.continuity && b.continuity.length) parts.push(plural(b.continuity.length, 'full play-through'));
    if (b.lookahead.length) parts.push(b.lookahead.length + ' pulled forward');
    if (!parts.length) return b.warmup && b.warmup.minutes ? 'Scale warmup only; no pieces fit or need another review.' : 'No pieces fit or need another review.';

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
        mins(n.totalPerPracticeDay) + ' min per practice day against your ' +
        mins(n.budgetPerPracticeDay) + '-minute budget. You can pause learning or change your budget in Practice settings.</p>' +
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
    var max=Math.max(1,...forecast.map(function(d){return d.projectedMin;}));
    return '<section class="card forecast"><h2>Week ahead</h2><div class="bars">'+forecast.map(function(d,i){
      return '<div class="bar-col'+(i===0?' is-today':'')+'"><span class="tiny">'+mins(d.projectedMin)+'</span><div class="bar-wrap"><span class="bar'+(!d.practiceDay?' is-zero-day':'')+'" style="height:'+Math.max(2,Math.round(d.projectedMin/max*100))+'%"></span></div><span class="bar-label">'+DAYS_SHORT[d.weekday]+'</span><span class="tiny muted">'+(d.hardCount?d.hardCount+' hard':'')+'</span></div>';
    }).join('')+'</div><p class="tiny muted">Estimated minutes, including learning and warmup. Balanced across the coming weeks using current review intervals. Future plans adjust after practice; repair and frequent checks stay close to their due dates. Hard counts are whole pieces; section work is included in the minutes.</p></section>';
  }

  function timerText(ms) {var seconds=Math.floor(ms/1000);return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
  function timerControls() {
    var t=A.timerInfo();
    return '<div class="practice-timer"><b id="elapsed-time" aria-label="Elapsed practice time">'+timerText(t.milliseconds)+'</b><button class="btn" data-action="toggle-timer"'+(t.finished?' disabled':'')+'>'+ (t.finished?'Recorded':t.running?'Pause timer':'Resume timer')+'</button><button class="btn btn-sm btn-quiet" data-action="adjust-timer">Correct time</button></div>';
  }
  function beginVisibleTimer() {if(document.visibilityState==='visible'&&el('sheet').hidden)A.ensureTimer();}

  /* ---------- running a session ---------- */

  function renderSession(root, session, today) {
    if (session.warmup && session.warmup.status === 'pending') {
      beginVisibleTimer();
      root.innerHTML = '<h1>Warm up</h1><section class="card"><h2>' + esc(session.warmup.scale) + '</h2>' + timerControls() +
        '<p>About ' + mins(session.warmup.minutes) + ' minutes. One or two octaves, hands separately or together, at a comfortable tempo.</p>' +
        '<p class="small muted">The scale advances when you tap Done. Days off and skipped warmups keep your place. Minor scales rotate through natural, harmonic and melodic forms.</p>' +
        '<button class="btn btn-primary btn-block" data-action="warmup-done">Done — start pieces</button>' +
        '<button class="btn btn-quiet btn-block" data-action="warmup-skip">Skip warmup</button>' +
        '<button class="btn btn-quiet btn-block" data-action="pause-session">Pause &amp; view plan</button></section>' + renderPlan(session.plan,null,'This session');
      return;
    }
    var it = A.currentItem();
    if (!it) { renderSummary(root, today); return; }

    var p = it.piece;
    var subject = it.subject;
    var sec = it.section;
    var isLearning = !sec && !p.sectionFirst && (it.kind === 'learning' || p.state === 'learning');
    var kindLabel = sec ? 'Section check' : isLearning ? 'Learning' :
      it.kind === 'continuity' ? 'Full play-through' : it.kind === 'lookahead' ? 'Pulled forward' : 'Maintenance';
    var prog = A.sessionProgress();

    /* Progress strip doubles as navigation — tap any segment to jump. */
    var html = '<div class="session-view"><button class="btn session-pause" data-action="pause-session">Pause &amp; view plan</button><div class="progress">';
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
    } else if (p.sectionFirst && p.state === 'learning' && !sec) {
      html += ' · first full run';
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
      html += '<p class="small muted">' + (it.kind === 'continuity' ? 'Play the whole piece from memory for continuity. Grade the first run; an early Clean result will not lengthen its interval.' : p.state === 'repair' ? 'Repair the parts that need work. Grade the first attempt you use to check recall.' :
        p.state === 'consolidating' && p.focusedMinutes ? 'Use this slot for focused practice. Grade the first attempt you use to check recall.' :
        'Whole-piece review. Grade your first attempt from memory, before practising this piece.') + '</p>';
    }
    if (!isLearning && p.learningFocus) html += '<p class="np-notes"><b>Your practice focus:</b> ' + esc(p.learningFocus) + '</p>';
    if (p.notes) html += '<div class="np-notes">' + esc(p.notes) + '</div>';
    html += '<button class="btn btn-sm btn-quiet" data-action="edit-practice-notes" data-id="' + esc(p.id) + '" data-section-id="' + esc(sec ? sec.id : '') + '">Edit notes and sections</button>';
    html += '</div>';

    if (it.result) {
      html += '<p class="recorded-note" aria-live="polite">' +
        (it.result.skipped ? 'Skipped' + (it.result.pushed ? ' — due tomorrow' : ' — still due')
          : it.result.learning ? 'Practice recorded'
          : it.result.pct != null ? 'Learning recorded'
          : 'Recorded ' + esc(it.result.grade)) +
        (it.result.locked ? ' · saved record' : ' · <button class="btn btn-sm btn-quiet" data-action="undo-item">Undo</button>') + '</p>';
    }

    if (it.result && it.result.locked) {
      root.innerHTML = html + '<p class="small muted">This result is kept as recorded because the piece was edited afterwards.</p>' + (it.result.finished===false ? timerControls()+'<button class="btn btn-primary btn-block" data-action="done-item">Done — next</button>' : '') + '<button class="btn btn-block" data-action="pause-session">Back to plan</button></div>'; return;
    }

    if(!it.result || it.result.finished===false)beginVisibleTimer();
    html += timerControls();
    if (isLearning) {
      html += renderLearningControl(p, it);
    } else {
      html += '<button class="btn btn-primary btn-block" data-action="done-item"'+(!it.result||it.result.skipped?' disabled':'')+'>Done — next</button>' + '<div class="grades">' +
        [['clean','Clean'],['wobbled','Wobbled'],['broke','Broke down']].map(function(choice){
          var selected=!!it.result&&it.result.grade===choice[0]&&!it.result.skipped;
          return '<button class="grade'+(selected?' is-selected':'')+'" data-grade="'+choice[0]+'" aria-label="'+choice[1]+'" aria-pressed="'+selected+'">'+(selected?'<span aria-hidden="true">✓ </span>':'')+choice[1]+'</button>';
        }).join('') +
        '</div><p class="small muted">Grade your first attempt, then keep practising. Tap Done when you finish this piece or section.</p>' + gradeHelp();
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
    var draft = A.state().session && A.state().session.learningDraft;
    if (!draft || draft.pieceId !== p.id) draft = null;
    return '<div class="learning-record">' +
      '<div class="field"><label for="learning-focus">Today’s focus</label>' +
      '<textarea id="learning-focus" placeholder="Optional — your own practice focus">' + esc(draft ? draft.focus : p.learningFocus) + '</textarea></div>' +
      (last ? '<p class="small muted">Last time: ' + esc(last.achievement) + '</p>' : '') +
      '<div class="field"><label for="learning-achievement">What can you do now?</label>' +
      '<textarea id="learning-achievement" placeholder="Optional — what you achieved">' +
      esc(draft ? draft.achievement : it.result && it.result.achievement || '') + '</textarea></div>' +
      '<div class="field"><label for="learning-next">Next focus</label>' +
      '<textarea id="learning-next" placeholder="Optional — what you want to work on next">' +
      esc(draft ? draft.nextFocus : it.result && it.result.nextFocus || '') + '</textarea></div>' +
      '<button class="btn btn-primary btn-block" data-action="save-learning">Done — next</button></div>';
  }

  function renderSummary(root, today) {
    var sum = A.sessionSummary(today);
    if (!sum) { A.endSession(); refresh(); return; }

    var html = '<h1>Done</h1>';
    html += '<p class="date-line">' + esc(longDate(sum.date)) + '</p>';

    var sessionId=A.state().session.id;
    var measured=A.state().practiceTimes.filter(function(t){return t.id.indexOf(sessionId+':')===0;}).reduce(function(n,t){return n+t.minutes;},0);
    html += '<section class="card"><p><b>'+mins(measured)+' min measured</b> · breaks excluded</p><ul class="summary-list">';
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
      if(r&&r.actualMinutes!=null)detail+=(detail?' · ':'')+mins(r.actualMinutes)+' min measured';
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

    sum.rows.forEach(function(row){var suggestion=A.consolidationSuggestion(row.piece,today);if(suggestion)html+='<p class="small">'+esc(row.piece.title)+' has earned a longer consolidation interval.</p><button class="btn btn-block" data-action="review-spacing" data-id="'+esc(row.piece.id)+'">Review spacing</button>';});
    var nextDay=A.weekPlan(today,8,false).find(function(d){return d.date>today&&d.items.length;});
    if(nextDay)html += '<section class="card"><h2>Next practice day</h2><p>'+esc(longDate(nextDay.date))+' · '+mins(nextDay.projectedMin)+' min estimated</p></section>';

    html += '<button class="btn btn-primary btn-block" data-action="close-summary">Back to today</button>' +
      '<button class="btn btn-block" data-action="plan-extra">I have more time</button>';
    if (sum.untouched.length) {
      html += '<button class="btn btn-block btn-quiet" style="margin-top:8px" data-action="resume-session">' +
        'Back to the session</button>';
    }
    root.innerHTML = html;
  }

  /* ------------------------------------------------------------------ *
   * Repertoire
   * ------------------------------------------------------------------ */

  function renderRepertoire(listOnly) {
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

    html += '<div id="repertoire-results">';
    var listStart = html.length;
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
          var overdue = p.sectionFirst ? A.reviewUnits().some(function (unit) {
            return (unit.id === p.id || unit.parentPieceId === p.id) && A.isDue(unit,today);
          }) : A.isDue(p, today);
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
    if (listOnly && el('repertoire-results')) { el('repertoire-results').innerHTML = html.slice(listStart); return; }
    html += '</div>';

    html += '<div class="stack" style="margin-top:22px">' +
      '<button class="btn btn-block" data-action="practice-settings">Practice settings</button>' +
      '<button class="btn btn-block" data-action="export">Export backup</button>' +
      '<button class="btn btn-block" data-action="copy-export">Copy backup to clipboard</button>' +
      '<button class="btn btn-block" data-action="import">Import JSON</button>' +
      '</div><p class="tiny muted">Repertoire ' + A.VERSION + '</p>';

    root.innerHTML = html;

    el('f-search').oninput = function () { view.filters.search = this.value; renderRepertoire(true); };
    el('f-tier').onchange = function () { view.filters.tier = this.value; renderRepertoire(true); };
    el('f-state').onchange = function () { view.filters.state = this.value; renderRepertoire(true); };
    el('f-composer').onchange = function () { view.filters.composerId = this.value; renderRepertoire(true); };
  }

  function renderCapacityCard() {
    var r=launchInfo.capacity;
    if(!r.configuredSessionDaysPerWeek)return '<section class="card"><h2>Practice workload</h2><p>No usual practice days selected.</p><button class="btn" data-action="practice-settings">Choose practice days</button></section>';
    return '<section class="card capacity-card"><h2>Practice workload</h2><p class="capacity-headline"><b>'+mins(r.totalWeekly)+' min over the next week</b><span>'+mins(r.totalPerPracticeDay)+' min per practice day on average</span></p><dl><dt>Maintenance per practice day</dt><dd>'+mins(r.maintenancePerPracticeDay)+' min</dd><dt>Learning per practice day</dt><dd>'+mins(r.learningPerPracticeDay)+' min</dd><dt>Scale warmup per practice day</dt><dd>'+mins(r.warmupPerPracticeDay)+' min</dd><dt>Extra allowance this week</dt><dd>'+mins(r.allowanceWeekly)+' min</dd></dl><p class="small">Measured practice in the past 7 days: <b>'+mins(r.measuredWeekly)+' min</b></p><p class="tiny muted">The estimate follows your current review schedules. There is no daily time limit. Pause learning whenever maintenance needs your time.</p><button class="btn btn-sm btn-quiet" data-action="practice-settings">Practice settings</button></section>';
  }

  /* ------------------------------------------------------------------ *
   * Editor sheet
   * ------------------------------------------------------------------ */

  function openSheet(html) {
    A.pauseTimer();
    var sheet = el('sheet');
    sheet.querySelector('.sheet-panel').innerHTML = html;
    sheet.hidden = false;
  }

  function closeSheet() {
    el('sheet').hidden = true;
    view.editing = null;
    view.editingIsNew = false;
    view.composerQuery = '';
    if(view.booted)refresh();
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
      A.appliedCap(d.fragility, d.intervalCapDays) + ' days)</label>' +
      quick('fragility', d.fragility, 0.5) + '</div>';

    html += '<div class="field"><label>Maximum review interval (days; blank = fragility default)</label><input type="number" min="1" max="60" data-field="intervalCapDays" value="' + (d.intervalCapDays || '') + '"></div>';

    html += '<div class="field"><label>Playing difficulty — 1 easy, 5 hardest (order and allowance)</label>' + quick('practiceDifficulty', d.practiceDifficulty, 1) + '</div>';
    html += '<div class="field-row">' +
      '<div class="field"><label>Duration (min)</label>' + quick('durationMin', d.durationMin, 0.5) + '</div>' +
      '<div class="field"><label>Content (min, to memorise)</label>' + quick('contentMin', d.contentMin, 0.5) + '</div>' +
      '</div>';

    html += '<div class="field"><label>Practice allowance (minutes; blank = automatic)</label><input type="number" min="0.25" step="0.25" data-field="practiceMinutes" value="'+(d.practiceMinutes||'')+'"><p class="tiny muted">Automatic: 3× playing time for difficulty 4–5, otherwise 1.3×. An explicit allowance takes priority over focused practice.</p></div>';
    var measured=A.timingSummary(d.id);
    if(measured)html += '<p class="small muted">Typical measured review: '+mins(measured.minutes)+' min (median of '+measured.sessions+' recent sessions, excluding learning and repair).</p>';
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

    {
      html += '<div class="field"><label>Your practice focus (optional)</label>' +
        '<textarea data-field="learningFocus" placeholder="Optional — your own practice focus">' +
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

    if (d.state === 'consolidating') html += '<p class="small muted">Promotion is your choice. The app suggests it after 14 calendar days in consolidation and two clean reviews on separate days since the last breakdown. Early reviews do not count. Choose Mark established when ready; the interval grows after clean reviews.</p>';
    if(d.state==='consolidating'&&d.practiceDifficulty<=2&&!d.sectionFirst){
      var suggestion=A.consolidationSuggestion(A.pieceById(d.id));
      html += '<p class="small muted">Easy pieces can stay consolidating at two- or three-day intervals. A clean week earns a spacing suggestion; this never marks the piece established. Wobbled holds the interval; Broke down returns an easy consolidating piece to daily checks.</p>';
      if(suggestion)html += '<button class="btn btn-block" data-action="space-consolidation" data-id="'+esc(d.id)+'">Move to every '+suggestion.intervalDays+' days</button>';
    }
    if (d.state === 'consolidating') html += '<div class="field"><label>Consolidation interval (days)</label>' +
      '<input type="number" min="1" max="20" data-field="consolidatingIntervalDays" value="' + (d.consolidatingIntervalDays || 3) + '"></div>';
    if (d.state === 'consolidating' || d.state === 'repair') html += '<div class="field"><label>Focused practice (minutes; blank = usual estimate)</label>' +
      '<input type="number" min="0.5" step="0.5" data-field="focusedMinutes" value="' + (d.focusedMinutes || '') + '"></div>';

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
      '<p class="tiny muted">Each has its own schedule and repair state.</p>' +
      '<label class="check-label"><input type="checkbox" data-field="sectionFirst"' + (d.sectionFirst ? ' checked' : '') + '> Relearn through hot spots first</label>' +
      '<p class="tiny muted">When enabled, Start learning spreads the sections across practice days. A clean result on every included section unlocks the first full run. This does not mark the whole piece established.</p>' +
      '<div class="field"><label>Maximum hot spots per day</label><input type="number" min="1" max="6" data-field="maxSectionsPerDay" value="' + d.maxSectionsPerDay + '"></div>';
    if (d.sectionFirst && d.state === 'learning') {
      var progress = A.sectionProgress(d);
      html += '<p class="small"><b>' + progress.passed + ' of ' + progress.total + ' hot spots clean.</b> ' +
        (progress.ready ? 'The first full run is available from the next practice day.' : 'Full runs wait until all included hot spots are clean.') + '</p>';
    }
    d.sections.forEach(function (sec, i) {
      function input(field, label, type, extra) {
        return '<div class="field"><label>' + label + '</label><input type="' + (type || 'text') +
          '" data-section="' + i + '" data-section-field="' + field + '" value="' +
          esc(sec[field] == null ? '' : sec[field]) + '" ' + (extra || '') + '></div>';
      }
      var measuredSection=A.timingSummary(d.id,sec.id);
      html += '<details class="section-editor" data-section-id="' + esc(sec.id) + '"><summary>' + esc(sec.label || 'New section') +
        ' <span class="tiny muted">' + (sec.enabled === false ? 'paused' : esc(sec.state || 'consolidating')) + '</span></summary>' +
        input('label', 'Name / landmark') +
        '<div class="field-row">' + input('startBar', 'First bar', 'number', 'min="1"') + input('endBar', 'Last bar', 'number', 'min="1"') + '</div>' +
        '<div class="field"><label>Prompt</label><select data-section="' + i + '" data-section-field="prompt">' +
        [['start', 'Start here from memory'], ['transition', 'Play the transition into here'], ['recover', 'Pause, then resume here']].map(function (x) {
          return '<option value="' + x[0] + '"' + (sec.prompt === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field-row">' + input('durationMin', 'Playing time (min)', 'number', 'min="0.25" step="0.25"') +
        input('fragilityOverride', 'Fragility (blank = piece)', 'number', 'min="1" max="5" step="0.5"') + '</div>' +
        '<div class="field-row">' + input('practiceDifficulty', 'Playing difficulty (1–5; blank = piece)', 'number', 'min="1" max="5"') +
        input('practiceMinutes', 'Practice time (min; blank = usual estimate)', 'number', 'min="0.25" step="0.25"') + '</div>' +
        (measuredSection?'<p class="small muted">Typical measured practice: '+mins(measuredSection.minutes)+' min (median of '+measuredSection.sessions+' completed sessions).</p><button class="btn btn-sm" data-action="use-section-timing" data-index="'+i+'">Use measured allowance</button>':'') +
        input('intervalCapDays', 'Maximum interval (days; blank = fragility default)', 'number', 'min="1" max="60"') +
        input('notes', 'Practice note') +
        '<div class="field-row">' + input('intervalDays', 'Interval (days)', 'number', 'min="1"') + input('nextDue', 'Next due', 'date') + '</div>' +
        '<label class="check-label"><input type="checkbox" data-section="' + i + '" data-section-field="enabled"' +
        (sec.enabled !== false ? ' checked' : '') + '> Include in reviews</label>' +
        '<p class="tiny muted">' + esc(sec.lastColdCall ? 'Last checked ' + sec.lastColdCall : 'Not checked in this app yet') +
        ' · ' + plural((sec.history || []).length, 'check') + '</p>' +
        '<button class="btn btn-sm danger" data-action="del-section" data-index="' + i + '">Delete section</button></details>';
    });
    html += '<button class="btn btn-sm" style="margin-top:9px" data-action="add-section">Add section</button></div>';

    if (!view.editingIsNew && d.state !== 'backlog') html += '<button class="btn btn-block" data-action="practise-piece">Save and practise this piece</button>';
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
      if ((d.state === 'learning' && !d.sectionFirst) || d.state === 'consolidating') {
        html += '<button class="btn" data-action="promote">' + (d.state === 'consolidating' ? 'Mark established' : 'Start consolidating') + '</button>';
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
      if (!pv.ok) { alert(pv.missing && pv.missing.length ? 'Could not match: ' + pv.missing.join(', ') + '. Import your Chopin backup first.' : 'Unrecognised or invalid file format.'); return; }
      if (pv.alreadyApplied) { alert('This practice update has already been applied.'); return; }

      var msg;
      if (pv.mode === 'practice-update') {
        msg = 'Practice update: ' + pv.plays + ' plays across ' + pv.pieces + ' pieces.\n\nAdds the reported practice and adjusts the requested schedules. Keeps your other pieces, sections, notes and newer reviews. Your current session plan will close; recorded results stay saved. Apply?';
      } else if (pv.mode === 'replace') {
        msg = 'Full backup: ' + pv.pieces + ' pieces, ' + pv.sections + ' sections, ' +
          pv.composers + ' composers.\n\nThis REPLACES everything currently stored. Continue?';
      } else {
        msg = pv.pieces + ' pieces, ' + pv.sections + ' sections, ' + pv.composers + ' composer.\n' +
          pv['new'] + ' new, ' + pv.updated + ' updated.\n\nImport?';
      }
      if (!confirm(msg)) return;
      A.commitImport(pv);
      A.correctCatalogue();
    A.correctPreludeStates();
    A.updatePracticePreferences();
    A.expandRepertoire();
    A.enableDemandPlanning();
    A.refinePracticeRules();
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
    if (tab) { A.pauseTimer(); captureLearningDraft(); view.tab = tab; refresh(); return; }

    if (t.classList.contains('grade')) {
      var gradeTop=t.getBoundingClientRect().top;
      if (A.state().session && A.state().session.date !== A.todayISO()) A.resumeSession(A.todayISO(), A.state().session.index);
      A.timedGrade(t.getAttribute('data-grade'));
      view.pctFor = null;
      renderToday();
      var selectedGrade=document.querySelector('.grade.is-selected');
      if(selectedGrade)window.scrollBy(0,selectedGrade.getBoundingClientRect().top-gradeTop);
      return;
    }

    var action = t.getAttribute('data-action');
    var d = view.editing;

    if (action !== 'save-learning') captureLearningDraft();
    switch (action) {
      case 'use-section-timing': {var si=+t.getAttribute('data-index'),stat=A.timingSummary(d.id,d.sections[si].id);if(stat){d.sections[si].practiceMinutes=Math.max(.25,Math.ceil(stat.minutes*4)/4);renderEditor();}break;}
      case 'space-consolidation': {var id=t.getAttribute('data-id');if(!savePiece(true))break;A.spaceConsolidation(id);closeSheet();refresh();break;}

      case 'toggle-timer': if(A.timerInfo().running)A.pauseTimer();else A.startTimer();renderToday();break;
      case 'adjust-timer': {A.pauseTimer();var value=prompt('Practice minutes (excluding breaks):',mins(A.timerInfo().milliseconds/60000));if(value!==null&&value.trim()!==''&&Number.isFinite(+value)&&+value>=0)A.adjustTimer(+value);renderToday();break;}
      case 'done-item': A.finishTimedItem();refresh();window.scrollTo(0,0);break;
      case 'optional-practice': view.extra = true; view.minutes = 15; refresh(); break;
      case 'warmup-done': A.markWarmup(true); refresh(); break;
      case 'warmup-skip': A.markWarmup(false); refresh(); break;
      case 'plan-extra': A.endSession(); view.extra = true; view.minutes = 15; refresh(); break;
      case 'replan': A.endSession(); view.minutes = null; refresh(); break;
      case 'resume-closed':
        if (!A.resumeClosed(t.getAttribute('data-id'))) alert('Those items have already been reviewed or are no longer scheduled. You can plan a new session below.');
        refresh(); break;
      case 'log-today': view.logDate = null; refresh(); break;
      case 'practice-settings': openSettings(); break;
      case 'save-settings': {
        var overrides = {}; DAYS.forEach(function (day,i) { overrides[i] = el('practice-day-'+i).checked ? 1 : 0; });
        A.updateSettings({dailyOverrides:overrides,learningEnabled:el('learning-enabled').checked,learningMinutes:+el('learning-minutes').value,warmupMinutes:+el('warmup-minutes').value,scaleStep:+el('next-scale').value,maxLearning:+el('max-learning').value});
        closeSheet(); view.minutes = null; refresh(); break;
      }
      case 'start-break': A.setBreak(true); refresh(); break;
      case 'end-break': A.setBreak(false); view.minutes = null; refresh(); break;
      case 'unskip-day': A.updateSettings({skippedDate:null}); refresh(); break;
      case 'edit-practice-notes': {
        openEditor(t.getAttribute('data-id'));
        var sectionId = t.getAttribute('data-section-id');
        var editors = Array.from(document.querySelectorAll('.section-editor'));
        var editor = editors.find(function (e) { return e.getAttribute('data-section-id') === sectionId; });
        if (editor) { editor.open = true; editor.scrollIntoView({block:'center'}); }
        else { var notes = document.querySelector('[data-field="learningFocus"]'); if (notes) notes.scrollIntoView({block:'center'}); }
        break;
      }
      case 'practise-piece': {
        var pieceId = d.id; if (!savePiece(true)) break;
        if (!A.startPieceSession(pieceId)) {
          alert('No hot spots are available today. The next group will appear on its scheduled day; full runs unlock after all included hot spots have a clean result.');
          break;
        }
        closeSheet(); view.tab = 'today'; refresh(); break;
      }
      case 'pause-session': pauseWithDraft(); break;
      case 'resume-paused': A.resumeSession(); refresh(); break;
      case 'resume-item': A.resumeSession(null, +t.getAttribute('data-index')); refresh(); break;
      case 'more':
        view.minutes += 5;
        renderToday();
        break;
      case 'less':
        view.minutes = Math.max(5, view.minutes - 5);
        renderToday();
        break;
      case 'start':
        A.startSession(view.minutes, null, {extra:view.extra});
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
        view.extra = true; view.minutes = 15;
        refresh();
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
        if (A.state().session && A.state().session.date !== A.todayISO()) A.resumeSession(A.todayISO(), A.state().session.index);
        A.finishTimedItem({focus: el('learning-focus').value, achievement: el('learning-achievement').value, nextFocus: el('learning-next').value});
        renderToday(); window.scrollTo(0, 0); break;
      case 'retry-save': A.save(); renderSaveStatus(); break;

      case 'close-summary':
        A.endSession();
        view.extra = true;
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
      case 'review-spacing': openEditor(t.getAttribute('data-id')); break;
      case 'edit-piece': openEditor(t.getAttribute('data-id')); break;
      case 'add-piece': openEditor(null); break;
      case 'close-sheet': closeSheet(); break;

      case 'bump': {
        var f = t.getAttribute('data-field');
        var step = parseFloat(t.getAttribute('data-step'));
        var next = Math.round((d[f] + step) * 10) / 10;
        if (f === 'fragility' || f === 'practiceDifficulty') next = Math.max(1, Math.min(5, next));
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
    if (['learning-focus','learning-achievement','learning-next'].indexOf(e.target.id) >= 0) { captureLearningDraft(); return; }
    var d = view.editing;
    if (!d) return;
    var f = e.target.getAttribute('data-field');
    if (f === 'composerQuery') { view.composerQuery = e.target.value; renderComposerLater(); return; }
    if (f) { d[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; return; }
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
      practiceMinutes: d.practiceMinutes, practiceDifficulty: d.practiceDifficulty, fragility: d.fragility, priorKnowledge: d.priorKnowledge, notes: d.notes, learningFocus: d.learningFocus,
      consolidatingIntervalDays: d.consolidatingIntervalDays, focusedMinutes: d.focusedMinutes,
      sectionFirst: d.sectionFirst, maxSectionsPerDay: d.maxSectionsPerDay, intervalCapDays: d.intervalCapDays,
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
      A.replaceSections(d.id, d.sections);
      saved = A.updatePiece(d.id, fields);
      d.sections = JSON.parse(JSON.stringify(saved.sections));
    }

    A.replaceSections(d.id, d.sections);

    /* Editing mid-session: a changed duration must move the estimate for any
     * item not yet recorded, or the plan silently disagrees with itself. */
    A.refreshPlanEstimate(d.id);

    if (!silent) { closeSheet(); refresh(); }
    return saved;
  }

  document.addEventListener('change', function (e) {
    if (e.target.id === 'log-date') { view.logDate = e.target.value || null; renderToday(); }
  });
  document.addEventListener('visibilitychange', function () {
    if(document.visibilityState!=='visible'){captureLearningDraft();A.pauseTimer();releaseWakeLock();}
    else if(view.booted)refresh();
  });
  window.addEventListener('pagehide',function(){captureLearningDraft();A.pauseTimer();releaseWakeLock();});
  var wakeLock=null,wakePending=false,ticks=0;
  function releaseWakeLock(){if(wakeLock){wakeLock.release().catch(function(){});wakeLock=null;}}
  setInterval(function(){
    if(!view.booted)return;
    var timer=A.timerInfo(),label=el('elapsed-time');
    if(label)label.textContent=timerText(timer.milliseconds);
    if(timer.running&&++ticks%5===0)A.checkpointTimer();
    if(timer.running&&document.visibilityState==='visible'&&navigator.wakeLock&&!wakeLock&&!wakePending){
      wakePending=true;navigator.wakeLock.request('screen').then(function(lock){wakeLock=lock;lock.addEventListener('release',function(){wakeLock=null;});}).catch(function(){}).finally(function(){wakePending=false;});
    } else if(!timer.running)releaseWakeLock();
  },1000);

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
