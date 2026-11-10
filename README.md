# repertoire-app

Personal practice scheduler for a permanent piano repertoire. A static
web app (no build step) installed to the iPhone home screen; all data
lives in the browser's localStorage and leaves only through Export.

## Files

- `app.js` — state, scheduler, session builder. No DOM access.
- `ui.js` — rendering and events.
- `sw.js` — cache-first service worker. **Bump `CACHE_VERSION` on every
  deploy**, or the phone keeps the old version.
- `seed.json` — the starting catalogue.
- `tests/run.js` — headless scheduler checks: `node tests/run.js`.

## Deploying

1. Change `CACHE_VERSION` in `sw.js`.
2. Commit and push to `main`.
3. On the phone, close the app fully and reopen it twice. The version
   number is at the foot of the Repertoire tab.

## Scheduling rules in brief

- Established pieces: a Clean lengthens the interval by 1.4×, up to a
  cap set by fragility. The interval follows the days that actually
  passed: a late Clean is credited half the overrun; an early Clean is
  credited only for the gap it covered.
- One memory wobble holds the interval; a second running shortens it by
  a quarter, unless it came well after the due date. Breaking down
  sends the piece to repair.
- Technical slips never move the memory interval. A recurring technical
  problem gets its own two-day checks.
- Promotion out of learning and consolidation is always your decision.
  The app suggests; nothing changes until you choose Apply.

## Storage

Old detail is trimmed on launch so localStorage does not fill: closed
sessions keep their item lists for 14 days, undo baselines for 30,
per-item timings for 120. Grades, notes and dates are never removed.
The Repertoire tab shows how full storage is.
