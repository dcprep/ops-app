// ══════════════════════════════════════════════════════════════════════
// DC Prep Ops App — Google Apps Script (corrected, Oct 2026)
//
// CHANGES IN THIS VERSION — read before pasting over the old script:
//
// 1. FIXED (Jul 2026): handleBOYReadiness was writing to a tab called "Full
//    Space Readiness" that doesn't exist in the live spreadsheet. The real
//    tab is "Ops Readiness Log". All SDO (Operations) submissions now write
//    there, in the exact column order that tab's formulas expect
//    (Timestamp / School / [Campus Code — formula] / Section / Space /
//    Room # / Role / Assessment / Notes / Desk Count / Chair Count /
//    [Key, Is Latest, Latest Key, Is Latest w/ Counts, Latest Key w/
//    Counts — all formulas, pre-filled down to row 1000, left untouched).
//
// 2. FIXED (Jul 2026): the general `notes` field was never written
//    anywhere — it's now saved to column I of Ops Readiness Log (SDO) or
//    column L of Classroom Readiness (MDS).
//
// 3. FIXED (Jul 2026): "Ops Readiness Log" has formulas pre-filled down to
//    row 1000 in columns C/L/M/N/O/P, so tab.appendRow(...) would land new
//    writes at row 1001+ instead of the first truly-empty row. Writes now
//    use findFirstEmptyRow() against column A specifically.
//
// 4. REMOVED (Jul 2026): all DOF (Facilities) references. Ops + Facilities
//    were consolidated into one "Operations" (SDO) track in the Ops App
//    months ago; checklistType is now only ever 'MDS', 'SDO', or 'DOT'.
//
// 5. FIXED (Jul 2026): MDS (Schools) submissions from the unified BOY Space
//    Readiness flow were also being sent to the (nonexistent) "Full Space
//    Readiness" tab. They now go to "Classroom Readiness" — which already
//    has a working "Analysis - Classroom Readiness" pipeline built on top
//    of it, just with no live data reaching it until now.
//
// 6. NOTE — Tech (DOT) submissions: the Tech (G) column in All Spaces pulls
//    from six "Tech - XXX" tabs, which are themselves populated via
//    IMPORTRANGE from a *separate* Tech-team spreadsheet — entirely
//    disconnected from this app. There's currently no live destination for
//    a DOT submission from the Ops App to feed that system, so
//    handleBOYReadiness treats DOT as a safe no-op for now rather than
//    guessing at a destination. Flag if you want this wired up for real —
//    it would need to either write into the Tech team's sheet directly, or
//    you'd want a different reconciliation approach.
//
// 7. REWRITTEN (Jul 2026): getBOYReadiness now matches the real 10-column
//    All Spaces layout (no DOF column), and returns `notes`, `deskCount`,
//    `chairCount` per room (parsed from the "24 / 24" style value in the
//    Desks/Chairs column) so the dashboards can show them.
//
// 8. FIXED (Aug 2026): handleArrival() was still using an old payload
//    schema (p.school, p.period, p.rating, p.checkedCount, p.totalCount,
//    p.checks, p.email) that no longer matches either the real "Arrival
//    Dismissal" sheet columns or what index.html's submitArr() actually
//    sends. It's rewritten below to match the real sheet layout, sharing
//    one ARRIVAL_ITEMS constant with getArrivalData so they can't drift
//    apart again.
//
// 9. FIXED (Aug 2026): getArrivalData() previously keyed its CLUSTER
//    lookup on full school names instead of the real short campus codes,
//    and relied on a "period" field the app has never actually collected.
//    It's rewritten below to key on the real codes, and to derive
//    arrival-vs-dismissal straight from the timestamp — before noon is
//    arrival, at/after noon is dismissal — matching the exact rule already
//    used by the "Analysis - Arrival and Dismissal" sheet tab (column S
//    < 12 vs >= 12).
//
// 10. ADDED (Aug 2026): a new consolidated `view=overall` endpoint
//     (getOverallReadinessData) for the Readiness Dashboard's All tab. It
//     used to make 6 separate getBOYReadiness(campus) calls plus 3 more —
//     9 total round trips, each of the 6 re-reading the entire All Spaces
//     sheet just to keep one campus's worth of rows. This reads All Spaces
//     once, buckets every campus server-side, and bundles in history/
//     snapshots/wins in the same response. Both this and the existing
//     per-campus getBOYReadiness are now cached 60 seconds via
//     CacheService, so a burst of page loads doesn't re-trigger the sheet
//     read every time.
//
// 11. ADDED (Aug 2026): Ops AI Bingo — a fun, time-boxed (Sept 1–21) staff
//     contest, unrelated to the operational tools above. Writes to a new
//     "AI Bingo" tab. Unlike every other handler in this file, which
//     appends one row per submission, this is an UPSERT: each person has
//     exactly one row that gets updated in place every time they mark or
//     unmark a square (found by matching the Name column), since a bingo
//     card is mutable per-person state rather than an append-only log
//     entry. The person's 5×5 square layout itself is never stored — it's
//     regenerated deterministically from their name on the client,
//     identically every time, so there's nothing to keep in sync between
//     the sheet and the app. See handleBingo / getBingoData, grouped
//     together below (same pairing precedent as handleDailyWin /
//     getDailyWins) rather than split across the Write/Read sections.
//
// 12. FIXED (Sep 2026): getCustodialData()'s "Where we can improve" list
//     had two problems flagged from a dashboard review:
//       - The flag rate (curr/prior) had no unit label anywhere in the
//         payload or the UI, so it was ambiguous whether a high number
//         was good ("mopped 100% of the time") or bad ("flagged as not
//         mopped 100% of the time"). It has always been the latter — curr/
//         prior are flag rates, i.e. % of walkthroughs where that item was
//         marked 'flagged'. Nothing here changed computationally; this
//         version just adds an explicit `n` (sample size) per item so the
//         dashboard can label and contextualize the number instead of
//         guessing.
//       - There was no minimum sample-size gate, so a single walkthrough
//         that flagged one item produced a 100% rate indistinguishable in
//         the UI from an item flagged 100 times out of 100. Items with
//         n < MIN_CUSTODIAL_N are now excluded from the "improve" list
//         entirely (matching the spirit of Arrival & Dismissal's low-
//         volume handling) rather than surfaced at full alarm with no
//         context.
//       - trend defaulted to 'stable' whenever there was no prior-period
//         data (prate === null), which visually told viewers "this hasn't
//         changed" about an item that has no history to compare against.
//         That case now returns trend:'new' instead, and index.html gives
//         it its own badge/copy so a first-appearance flag doesn't read as
//         "unchanging."
//
// 13. ADDED (Sep 2026) — Custodial dashboard granularity pass, driven by a
//     round of dashboard-design feedback:
//       - getCustodialData() now also returns `topConsistent`: up to 3
//         items with the highest CHECKED (not-flagged) rate over the
//         current window, gated by the same MIN_CUSTODIAL_N sample-size
//         floor as `flags`. This mirrors getArrivalData's existing `top`
//         (Most Consistent) logic exactly — same shape, same gate, same
//         "highest rate wins" sort — just computed from `itemCounts.ok`
//         instead of a separate checkCounts map, since getCustodialData
//         already tracked ok/flag per item.
//       - The month trend (`trend`) is now Aug–Jun (11 months) rather than
//         Aug–Jul (12) — the dashboard's bar chart doesn't show a July bar,
//         so there's no reason to compute or ship one. A walkthrough
//         logged in July (summer, off calendar) is still counted in the
//         overall n/currentPct via the rolling curr/prior window — it's
//         only excluded from the by-month trend series.
//       - ADDED getCustodialWalkthroughDates(days): returns one row per
//         walkthrough logged in the last `days` (timestamp + campus
//         cluster), for the dashboard's new combined "Walkthrough
//         Frequency" calendar — one dot per observation, across all three
//         campuses on one calendar, rather than a per-campus aggregate.
//         Wired into getOpsData() as `custodialCalendar`.
//
// 14. FIXED (Sep 2026): handleWalkthrough() was still appending the old
//     p.school/p.role/p.spaces/p.email payload shape from before the
//     Common Space Walkthrough flow was rebuilt. submitWalk() in
//     index.html actually sends { campus, name, spacesAssessed,
//     spacesGood, spacesUpkeep, spacesFlagged, spacesSkipped, ratings,
//     notes } — ratings is an object keyed by space label (Lobby,
//     Hallways, ...), each one of 'good'/'upkeep'/'flag'/'skipped'. The
//     old code wrote p.school into Campus, p.role into Name (both always
//     blank since neither field exists on the payload), JSON.stringify(p.
//     spaces) — always '{}', since p.spaces doesn't exist either — into
//     Spaces Assessed, and the real notes text into Spaces Good. That's
//     exactly the shape of the bad Sept 9 row in the live sheet. Rewritten
//     below to match the real 19-column layout (A:S).
//
// 15. ADDED (Sep 2026): getCommonSpaceData / getCommonSpaceWalkthroughDates
//     — feeds the Ops Dashboard's new Common Space Walkthrough tile, built
//     to mirror getCustodialData's structure exactly (same `trend`/`flags`/
//     `topConsistent` shape, same MIN_CUSTODIAL_N sample-size gate, same
//     Aug–Jun by-month series). One deliberate difference: each of the 10
//     spaces is marked 'good'/'upkeep'/'flag'/'skipped' (three tiers, shown
//     to the submitter as "Well kept"/"Needs improvement"/"Major issues"),
//     not Custodial's plain checked/flagged. Per direction from Charles:
//     only 'good' ("Well kept") counts as checked/ok; both 'upkeep' and
//     'flag' count against the checked % and both land together in
//     `flags` ("Where We Can Improve"). Wired into getOpsData() as
//     `commonSpace` / `commonSpaceCalendar`.
//
// 16. ADDED (Sep 2026): getCustodialWalkthroughDates(days) and
//     getCommonSpaceWalkthroughDates(days) now return the FULL submission
//     detail for each walkthrough, not just {ts, campus}. This feeds a new
//     "click a day on the calendar to see what was submitted" overlay on
//     the Ops Dashboard, with copy/print — previously the calendar could
//     only show that *something* was logged that day, not what.
//       - Custodial: each row now also carries role, checklistType,
//         itemsChecked, itemsFlagged, checks (the parsed per-item JSON
//         detail), and notes.
//       - Common Space: each row now also carries name, the five
//         spacesAssessed/Good/Upkeep/Flagged/Skipped counts, ratings (the
//         parsed per-space status object), and notes.
//     Both also now include `campusCode` (the raw AEC/AMC/BEC/... value)
//     alongside the existing `campus` cluster name, since the dashboard
//     needs to tell same-cluster campuses (e.g. AEC vs AMC) apart when
//     grouping a day's submissions for the overlay. This is purely
//     additive — `ts` and `campus` are unchanged, so nothing that already
//     reads these arrays breaks.
//
// 17. UPDATED (Oct 2026) — Cluster drills. The app's drill campus picker
//     now shows "Anacostia Cluster (AMC + AEC)" and "Benning Cluster
//     (BMC + BEC)" as single lines (Edgewood stays as EMC / EEC). A
//     cluster drill sends ONE POST PER SCHOOL, back to back, each with its
//     own `campus` code and its own `occupants` count, plus a new
//     `cluster` field ('Anacostia' / 'Benning'; blank for Edgewood).
//     handleDrill changes:
//       - Writes `cluster` to a new column AA ("Cluster"). Adds the column
//         and its header automatically on the first write if missing.
//       - Takes a script lock around find-row-and-write. Without it, the
//         two near-simultaneous POSTs could both find the same empty row
//         and the second would overwrite the first.
//       - Writes the row in two batched setValues calls (A–T, then Y–AA)
//         instead of ~26 single-cell writes, so each lock is held briefly.
//         Columns U–X are still left untouched, same as before.
//     getDrillData already reports per school code, so each school in a
//     cluster drill gets credit for it on the dashboard.
//
// 18. FIXED (Oct 2026): getDrillData now counts only OSL rows (column C
//     Role = 'OSL') toward drill compliance and "last drill." Observer
//     submissions (Principal, COO, SDO, Other) skip the timer, so they
//     land with Duration = 0. Before this fix, a month with only an
//     observer row showed as "slow" instead of "none," and an observer
//     submitting after the OSL made "last drill" show 0:00. Observer
//     rows are still written to Drill Log as before; they're just not
//     treated as the timed record.
//
// 19. REWRITTEN (Oct 2026): getDrillData now returns drill data grouped
//     the way drills actually happen — Anacostia Cluster (AMC + AEC),
//     Benning Cluster (BMC + BEC), Edgewood Middle (EMC), Edgewood
//     Elementary (EEC) — for the current school year only.
//       - A drill logged under either school in a cluster counts for the
//         whole cluster (this also covers older rows logged under just one
//         school).
//       - OSL rows in the same group, of the same type, on the same day are
//         merged into one drill. Occupants are kept per school; flags and
//         notes are combined; times/weather/observations come from the
//         first row logged that day.
//       - Month dots are now done / not done ('ok' / 'none'). Extra drills
//         in a month are fine; the 10-minute goal is shown on each drill
//         instead of on the dots.
//       - Each group returns lastEvac, lastLock, and the full list of the
//         school year's drills (newest first) with every collected field,
//         for the dashboard's fire-marshal-form view.
//       - Observer rows (non-OSL) on the same group/type/day are attached
//         to that drill as `observers` (role, notes, rating).
//     The response shape changed: { groups, months, syStart } replaces
//     { compliance, lastDrills, months, syStart }. Only the Ops Dashboard
//     reads this, and it's updated to match.
//     handleDrill also now writes the observer's overall rating
//     (`assessment`, Strong / OK / Needs work) to new column AB
//     ("Observer Assessment"), added automatically if missing.
var MIN_CUSTODIAL_N = 3;

// Spreadsheet tabs expected in the App Log:
//   Drill Log
//   Common Space Walkthrough
//   Arrival Dismissal
//   Custodial Walkthrough
//   Classroom Readiness          ← MDS submissions land here
//   Ops Readiness Log            ← SDO (Operations) submissions land here
//   Facilities Requests
//   Bus Trip Log
//   Bus Trip - No Shows
//   Bus Trip - Incidents
//   Bus Trip - Monitor Handoffs
//   Bus Trip - Delay Reports
//   All Spaces                   ← paste the BOY Room List tab in verbatim
//   Tech - AEC / AMC / BEC / BMC / EEC / EMC  ← IMPORTRANGE'd from the
//                                                separate Tech-team sheet
//   AI Bingo                     ← auto-created on first mark if missing
// ══════════════════════════════════════════════════════════════════════

// Shared list of Arrival & Dismissal checklist items — columns G–P, in
// this exact order. Single source of truth so the write side
// (handleArrival) and the read side (getArrivalData) can never drift out
// of sync with each other the way they did before.
var ARRIVAL_ITEMS = [
  'Crossing guard present',
  'Arrival / dismissal zones free of obstructions',
  'No unauthorized vehicles in student loading zones',
  'All staff members at duty posts',
  'Staff members attentive — not on phones',
  'Staff behaviors support positive student behaviors and transitions',
  'Staff positioned to maximize visibility of students',
  'Students moving with purpose, minimal crowding',
  'Drop-off / pick-up line moving efficiently',
  'Students needing support identified and assisted promptly'
];

// Shared list of Common Space Walkthrough space labels — columns I–R, in
// this exact order. Matches WALK_SPACES' `label` values in index.html one
// for one, since submitWalk() keys its `ratings` object by that same
// label. Also used by getCommonSpaceData below.
var WALK_SPACE_LABELS = [
  'Lobby',
  'Hallways',
  'Conference rooms',
  'Leader offices',
  'Copy / mail room',
  'Staff lounge / workroom',
  'Staff restroom',
  'Student restrooms',
  'Prepeteria',
  'Central library'
];

// Drill observation items — columns K–S, in this exact order. Shared by
// handleDrill (write) and getDrillData (read). Must match the tog-label
// text in index.html's drill flow exactly.
var DRILL_EVAC_ITEMS = [
  'All classes exited to correct locations',
  'Students were silent during evacuation',
  'All exits used appropriately',
  'Teachers positioned correctly mid-line',
  'Any door / stairwell / alarm issues?'
];
var DRILL_LOCK_ITEMS = [
  'All classroom doors locked promptly',
  'All window blinds / coverings down',
  'Hallways clear within 60 seconds',
  'Any door / lock / blind issues?'
];

// How drills are grouped on the dashboard. Anacostia and Benning drill as
// clusters; Edgewood Middle and Elementary drill separately.
var DRILL_GROUPS = [
  { id: 'Anacostia', label: 'Anacostia Cluster (AMC + AEC)', schools: ['AMC', 'AEC'] },
  { id: 'Benning',   label: 'Benning Cluster (BMC + BEC)',   schools: ['BMC', 'BEC'] },
  { id: 'EMC',       label: 'Edgewood Middle (EMC)',         schools: ['EMC'] },
  { id: 'EEC',       label: 'Edgewood Elementary (EEC)',     schools: ['EEC'] }
];

// ── Entry points ──────────────────────────────────────────────────────

function doPost(e) {
  try {
    var raw     = e.postData ? e.postData.contents : '{}';
    var payload = JSON.parse(raw);
    var flow    = payload.flow || '';

    if      (flow === 'drill')          handleDrill(payload);
    else if (flow === 'walkthrough')    handleWalkthrough(payload);
    else if (flow === 'arrival')        handleArrival(payload);
    else if (flow === 'custodial')      handleCustodial(payload);
    else if (flow === 'readiness')      handleReadiness(payload);   // legacy standalone MDS flow (likely unused)
    else if (flow === 'boy-readiness')  handleBOYReadiness(payload);
    else if (flow === 'bus-trip')       handleBusTrip(payload);
    else if (flow === 'bus-handoff')    handleBusHandoff(payload);
    else if (flow === 'bus-delay')      handleBusDelay(payload);
    else if (flow === 'bus-liaison')    handleBusLiaison(payload);
    else if (flow === 'daily-win')      handleDailyWin(payload);
    else if (flow === 'bingo')          handleBingo(payload);

    return jsonOK({ status: 'ok', flow: flow });
  } catch (err) {
    return jsonOK({ status: 'error', message: err.toString() });
  }
}

function doGet(e) {
  try {
    var view = e.parameter.view || '';

    if (view === 'ops')       return jsonOK(getOpsData());
    if (view === 'transport') return jsonOK(getTransportData());
    if (view === 'boy') {
      var campus = e.parameter.campus || 'BEC';
      return jsonOK(getBOYReadiness(campus));
    }
    if (view === 'readinessHistory') return jsonOK(getReadinessHistory());
    if (view === 'dailySnapshots')   return jsonOK(getDailySnapshots());
    if (view === 'dailyWins')        return jsonOK(getDailyWins());
    // ADDED (Aug 2026) — single consolidated payload for the Overall tab.
    // See getOverallReadinessData()'s own header comment for why this
    // exists and how it's cached.
    if (view === 'overall')          return jsonOK(getOverallReadinessData());
    // ADDED (Aug 2026) — Ops AI Bingo "everyone's cards" overview.
    if (view === 'bingo')            return jsonOK(getBingoData());

    return jsonOK({ status: 'ok', message: 'DC Prep Ops Script' });
  } catch (err) {
    return jsonOK({ status: 'error', message: err.toString() });
  }
}

function jsonOK(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ══════════════════════════════════════════════════════════════════════
// WRITE HANDLERS
// ══════════════════════════════════════════════════════════════════════

// ── Drill Log ─────────────────────────────────────────────────────────
// UPDATED (Oct 2026): see change note 17. Sheet layout:
//   A Timestamp | B Campus | C Role | D Drill Type | E Weather |
//   F Alarm Start | G All Clear | H Occupants | I Duration (sec) |
//   J Issues Flagged | K–S (9 observation columns) | T Notes |
//   U–X (left untouched) | Y Exit Time | Z End Time | AA Cluster |
//   AB Observer Assessment
function handleDrill(p) {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Drill Log');
  if (!tab) return;
  var obs = p.observations || {};
  var ITEMS = DRILL_EVAC_ITEMS.concat(DRILL_LOCK_ITEMS);

  var LAST_COL = 28; // AB
  var NEW_HEADERS = { 27: 'Cluster', 28: 'Observer Assessment' };

  // A cluster drill arrives as two POSTs a moment apart. The lock makes
  // the second one wait until the first has claimed and filled its row.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // Make sure columns AA–AB exist and have their headers.
    if (tab.getMaxColumns() < LAST_COL) {
      tab.insertColumnsAfter(tab.getMaxColumns(), LAST_COL - tab.getMaxColumns());
    }
    Object.keys(NEW_HEADERS).forEach(function(col) {
      var cell = tab.getRange(1, Number(col));
      if (!cell.getValue()) cell.setValue(NEW_HEADERS[col]);
    });

    var row = findFirstEmptyRow(tab, 1, 20000);

    var aToT = [
      new Date(),                         // A Timestamp
      p.campus || '',                     // B Campus
      p.role || '',                       // C Role
      p.drillType || '',                  // D Drill Type
      p.weather || '',                    // E Weather
      p.alarmStart || '',                 // F Alarm Start
      p.allClearTime || '',               // G All Clear
      p.occupants || '',                  // H Occupants
      Number(p.durationSecs) || 0,        // I Duration (sec)
      (p.flags || []).join('; ')          // J Issues Flagged (summary)
    ];
    ITEMS.forEach(function(item) {
      aToT.push(obs[item] || '');         // K–S (9 observation columns)
    });
    aToT.push(p.notes || '');             // T Notes
    tab.getRange(row, 1, 1, 20).setValues([aToT]);

    // U–X left untouched
    tab.getRange(row, 25, 1, 4).setValues([[
      p.exitTime   || '',                 // Y Exit Time
      p.endTime    || '',                 // Z End Time
      p.cluster    || '',                 // AA Cluster
      p.assessment || ''                  // AB Observer Assessment
    ]]);

    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ── Common Space Walkthrough ──────────────────────────────────────────
// FIXED (Sep 2026): see change note 14 at the top of this file. Sheet
// layout (A:S):
//   A Timestamp | B Campus | C Name | D Spaces Assessed | E Spaces Good |
//   F Spaces Upkeep | G Spaces Flagged | H Spaces Skipped | I Lobby |
//   J Hallways | K Conference rooms | L Leader offices | M Copy / mail
//   room | N Staff lounge / workroom | O Staff restroom | P Student
//   restrooms | Q Prepeteria | R Central library | S Notes
// No pre-filled formulas past the last data row or past column S in this
// tab, so a plain appendRow (via appendToTab) is fine here — unlike Ops
// Readiness Log, there's no need for findFirstEmptyRow.
function handleWalkthrough(p) {
  var ratings = p.ratings || {};
  var row = [
    new Date(),                       // A Timestamp
    p.campus || '',                   // B Campus
    p.name || '',                     // C Name
    Number(p.spacesAssessed) || 0,    // D Spaces Assessed
    Number(p.spacesGood) || 0,        // E Spaces Good
    Number(p.spacesUpkeep) || 0,      // F Spaces Upkeep
    Number(p.spacesFlagged) || 0,     // G Spaces Flagged
    Number(p.spacesSkipped) || 0      // H Spaces Skipped
  ];
  WALK_SPACE_LABELS.forEach(function(label) {
    row.push(ratings[label] || '');   // I–R (10 per-space ratings)
  });
  row.push(p.notes || '');            // S Notes
  appendToTab('Common Space Walkthrough', row);
}

// ── Arrival & Dismissal ───────────────────────────────────────────────
function handleArrival(p) {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Arrival Dismissal');
  if (!tab) return;
  var obs = p.observations || {};

  var row = findFirstEmptyRow(tab, 1, 5000);

  tab.getRange(row, 1).setValue(new Date());                  // A Timestamp
  tab.getRange(row, 2).setValue(p.campus || '');               // B Campus
  tab.getRange(row, 3).setValue(p.role || '');                 // C Role
  tab.getRange(row, 4).setValue(Number(p.itemsChecked) || 0);  // D Items Checked
  tab.getRange(row, 5).setValue(Number(p.itemsFlagged) || 0);  // E Items Flagged
  tab.getRange(row, 6).setValue(p.overallRating || '');        // F Overall Rating
  ARRIVAL_ITEMS.forEach(function(item, i) {
    tab.getRange(row, 7 + i).setValue(obs[item] || 'no input'); // G–P
  });
  tab.getRange(row, 17).setValue(p.notes || '');                // Q Notes
  // R, S (Date Only / Hour only) — left alone
}

// ── Custodial Walkthrough ─────────────────────────────────────────────
// FIXED (Aug 2026): this was reading a payload shape (p.school, p.walkType,
// p.checks, p.email) that hasn't matched what index.html's submitCust()
// actually sends since that flow was rebuilt around named campuses/
// checklistType/itemsChecked/itemsFlagged/checks/notes. That mismatch is
// why Campus and Checklist Type were landing blank, Items Checked was
// getting the literal string "{}", and the real notes text was landing in
// the Items Flagged column instead of Notes.
//
// Sheet layout after the Aug 2026 restructure (74 unused per-item columns
// removed — they held a stale generic checklist that never matched what
// the app actually collects, and nothing else in the workbook referenced
// them):
//   A Timestamp | B Campus | C Role | D Checklist Type | E Items Checked
//   | F Items Flagged | G Checklist Detail (JSON: {item: 'checked' /
//   'flagged' / 'no input' / 'skipped'}) | H Notes | I Date only
//   (formula) | J Month (formula) | K Year (formula)
//
// The per-item detail is stored as one JSON blob in column G rather than
// one column per item — the app's checklists differ by walk type and by
// campus cluster (DoF Bi-Weekly has 9 fixed items; the weekly/vendor walk
// has a different item set per space, and BEC/BMC's Stairwells section has
// 2 more items than AEC/AMC or EEC/EMC), so there's no single fixed set of
// per-item columns that could represent all of them. This mirrors the
// same pattern Common Space Walkthrough already uses successfully
// (JSON.stringify(p.spaces) in one column) — see handleWalkthrough above.
function handleCustodial(p) {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Custodial Walkthrough');
  if (!tab) return;

  var row = findFirstEmptyRow(tab, 1, 5000);

  tab.getRange(row, 1).setValue(new Date());                     // A Timestamp
  tab.getRange(row, 2).setValue(p.campus || '');                 // B Campus
  tab.getRange(row, 3).setValue(p.role || '');                   // C Role
  tab.getRange(row, 4).setValue(p.checklistType || '');          // D Checklist Type
  tab.getRange(row, 5).setValue(Number(p.itemsChecked) || 0);    // E Items Checked
  tab.getRange(row, 6).setValue(Number(p.itemsFlagged) || 0);    // F Items Flagged
  tab.getRange(row, 7).setValue(JSON.stringify(p.checks || {})); // G Checklist Detail (JSON)
  tab.getRange(row, 8).setValue(p.notes || '');                  // H Notes
  // I, J, K (Date only / Month / Year) — formulas, left alone
}

// ── ONE-TIME MIGRATION — run manually from the Apps Script editor ──────
// Collapses Custodial Walkthrough from its old 84-column layout (74 of
// which held a stale, unused generic checklist — see handleCustodial's
// header comment) down to the new 11-column layout. Run this ONCE, after
// pasting this whole file over the old script, before the app sends any
// more custodial submissions. Select this function in the Apps Script
// editor's function dropdown and click Run.
//
// Also recovers the two existing rows rather than discarding them:
//  - A normal old-format row (numeric Items Checked/Flagged, item columns
//    populated) gets its checked/flagged item data folded into the new
//    JSON detail column, keyed by the old column headers.
//  - The broken Aug 31 row — where Items Checked held the literal string
//    "{}" and the real notes text had landed in the Items Flagged column
//    — is detected (Items Flagged isn't a plain number) and its text is
//    moved into Notes where it belongs, rather than migrated as if it
//    were a real flagged-item count.
//
// Safe to run more than once: it always rebuilds from whatever is
// currently in the sheet, and does nothing if the tab doesn't exist.
function migrateCustodialWalkthroughSchema() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Custodial Walkthrough');
  if (!tab) return;

  var lastRow = tab.getLastRow();
  var lastCol = tab.getLastColumn();
  if (lastRow < 1) return;

  var OLD_ITEM_START = 7;   // G
  var OLD_ITEM_END   = 80;  // CB — last of the 74 old item columns
  var OLD_NOTES_COL  = 81;  // CC — old Notes column
  var oldHeaders = lastCol >= OLD_ITEM_END
    ? tab.getRange(1, OLD_ITEM_START, 1, OLD_ITEM_END - OLD_ITEM_START + 1).getValues()[0]
    : [];

  var migrated = [];
  if (lastRow >= 2) {
    var oldData = tab.getRange(2, 1, lastRow - 1, lastCol).getValues();
    oldData.forEach(function(r) {
      if (!r[0]) return; // blank row, skip

      var timestamp     = r[0];
      var campus        = r[1] || '';
      var role           = r[2] || '';
      var checklistType = r[3] || '';
      var rawChecked    = r[4];
      var rawFlagged    = r[5];
      var rawNotes      = lastCol >= OLD_NOTES_COL ? (r[OLD_NOTES_COL - 1] || '') : '';

      // Detect the broken shape: Items Flagged holding text (the
      // misplaced notes) instead of a number.
      var flaggedIsNumeric = rawFlagged === '' || rawFlagged === null ||
        !isNaN(Number(rawFlagged));
      var itemsChecked, itemsFlagged, notes;
      if (!flaggedIsNumeric) {
        // Broken row: recover the real notes, leave counts blank rather
        // than inventing numbers that were never actually captured.
        itemsChecked = '';
        itemsFlagged = '';
        notes = String(rawFlagged);
      } else {
        itemsChecked = (rawChecked === '' || isNaN(Number(rawChecked))) ? '' : Number(rawChecked);
        itemsFlagged = (rawFlagged === '' || rawFlagged === null) ? '' : Number(rawFlagged);
        notes = rawNotes;
      }

      // Fold whatever old per-item columns had into a JSON blob keyed by
      // the old headers, so nothing recorded is silently lost.
      var detail = {};
      if (lastCol >= OLD_ITEM_END) {
        for (var i = 0; i < oldHeaders.length; i++) {
          var val = r[OLD_ITEM_START - 1 + i];
          if (val !== '' && val !== null && oldHeaders[i]) {
            detail[oldHeaders[i]] = val;
          }
        }
      }

      migrated.push([
        timestamp, campus, role, checklistType,
        itemsChecked, itemsFlagged, JSON.stringify(detail), notes
      ]);
    });
  }

  // Rebuild the sheet: clear everything, trim to 11 columns, write the
  // new header row, write back the migrated data, then re-add the
  // Date only / Month / Year formulas at their new positions.
  tab.clear();
  if (tab.getMaxColumns() > 11) {
    tab.deleteColumns(12, tab.getMaxColumns() - 11);
  }
  tab.getRange(1, 1, 1, 11).setValues([[
    'Timestamp', 'Campus', 'Role', 'Checklist Type', 'Items Checked',
    'Items Flagged', 'Checklist Detail', 'Notes', 'Date only', 'Month', 'Year'
  ]]);

  if (migrated.length) {
    tab.getRange(2, 1, migrated.length, 8).setValues(migrated);
    tab.getRange(2, 9, migrated.length, 1).setFormulaR1C1(
      'IF(RC[-8]<>"",INT(RC[-8]),"")');
    tab.getRange(2, 10, migrated.length, 1).setFormulaR1C1(
      'IF(RC[-9]<>"",MONTH(RC[-9]),"")');
    tab.getRange(2, 11, migrated.length, 1).setFormulaR1C1(
      'IF(RC[-10]<>"",YEAR(RC[-10]),"")');
  }

  Logger.log('Migrated ' + migrated.length + ' row(s). Review the recovered ' +
    'Aug 31 row\'s Notes column and re-enter its Campus / Checklist Type / ' +
    'item detail by hand if you want that data fully intact — the migration ' +
    'could recover the notes text but not the campus or which items were ' +
    'checked, since those were never actually captured by the broken submission.');
}

// ── Classroom Readiness — legacy standalone flow (flow:'readiness') ───
function handleReadiness(p) {
  writeClassroomReadinessRow(p);
}

// ── BOY Space Readiness (MDS / SDO / DOT — unified app flow) ─────────
function handleBOYReadiness(p) {
  var type = p.checklistType || '';

  if (type === 'SDO') {
    writeOpsReadinessLogRow(p);
  } else if (type === 'MDS') {
    writeClassroomReadinessRow(p);
  } else if (type === 'DOT') {
    // Tech data currently lives entirely in the separate Tech-team
    // spreadsheet (see file header, note 6). No-op until that's wired up.
  }
}

function writeOpsReadinessLogRow(p) {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Ops Readiness Log');
  if (!tab) return;

  var row = findFirstEmptyRow(tab, 1, 1000); // first empty cell in column A
  var now = new Date();

  tab.getRange(row, 1).setValue(now);               // A Timestamp
  tab.getRange(row, 2).setValue(p.school   || '');   // B School
  // C Campus Code — formula, left alone
  tab.getRange(row, 4).setValue(p.section  || '');   // D Section
  tab.getRange(row, 5).setValue(p.classroom|| '');   // E Space
  tab.getRange(row, 6).setValue(p.roomNumber || ''); // F Room #
  tab.getRange(row, 7).setValue(p.role       || ''); // G Role
  tab.getRange(row, 8).setValue(p.assessment || ''); // H Assessment
  tab.getRange(row, 9).setValue(p.notes      || ''); // I Notes
  tab.getRange(row, 10).setValue(p.deskCount  || ''); // J Desk Count
  tab.getRange(row, 11).setValue(p.chairCount || ''); // K Chair Count
  // L Key, M Is Latest, N Latest Key, O Is Latest w/ Counts,
  // P Latest Key w/ Counts — formulas, left alone
}

function writeClassroomReadinessRow(p) {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Classroom Readiness');
  if (!tab) return;

  tab.appendRow([
    new Date(),
    p.school || '',
    campusCodeFromSchool(p.school),
    p.classroom || '',
    p.gradeBand || '',
    p.role || '',
    p.assessment || '',
    p.checkedItems || '',
    p.flaggedItems || '',
    Number(p.itemsChecked) || 0,
    Number(p.itemsTotal)   || 0,
    p.notes || ''
  ]);
}

function campusCodeFromSchool(school) {
  var MAP = {
    'Anacostia Elementary': 'AEC', 'Anacostia Middle': 'AMC',
    'Benning Elementary':   'BEC', 'Benning Middle':   'BMC',
    'Edgewood Elementary':  'EEC', 'Edgewood Middle':  'EMC'
  };
  return MAP[String(school).trim()] || '';
}

function findFirstEmptyRow(tab, col, maxRow) {
  var lastRow = Math.min(maxRow, tab.getMaxRows());
  if (lastRow < 2) return 2;
  var values = tab.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) return i + 2;
  }
  return lastRow + 1;
}

// ── Bus Trip Log ──────────────────────────────────────────────────────
function handleBusTrip(p) {
  appendToTab('Bus Trip Log', [
    new Date(), p.tripId, p.route, p.leg, p.role,
    p.departureTime, p.arrivalTime, p.ridersBoarded,
    p.manifestSize, p.onTime || ''
  ]);
  var noShows = p.noShows || [];
  if (noShows.length) {
    var nsTab = getOrCreateTab('Bus Trip - No Shows',
      ['Timestamp','Trip ID','Route','Leg','Student Name','Notes']);
    noShows.forEach(function(ns) {
      nsTab.appendRow([new Date(), p.tripId, p.route, p.leg,
                       ns.name || '', ns.notes || '']);
    });
  }
  var incidents = p.incidents || [];
  if (incidents.length) {
    var incTab = getOrCreateTab('Bus Trip - Incidents',
      ['Timestamp','Trip ID','Route','Leg','Category','Notes']);
    incidents.forEach(function(inc) {
      incTab.appendRow([new Date(), p.tripId, p.route, p.leg,
                        inc.category || '', inc.notes || '']);
    });
  }
}

// ── Bus Monitor Handoff ───────────────────────────────────────────────
function handleBusHandoff(p) {
  appendToTab('Bus Trip - Monitor Handoffs', [
    new Date(), p.tripId, p.route, p.leg, p.role,
    p.absencesRelayed ? 'Yes' : 'No',
    p.notableObservations || '',
    p.studentNeedingAttention || '',
    p.submittedAt || ''
  ]);
}

// ── Bus Delay Report ──────────────────────────────────────────────────
function handleBusDelay(p) {
  appendToTab('Bus Trip - Delay Reports', [
    new Date(), p.tripId, p.route, p.leg, p.role,
    p.reason || '', p.notes || '', p.submittedAt || ''
  ]);
}

// ── Bus Liaison Confirmation ──────────────────────────────────────────
function handleBusLiaison(p) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Bus Trip - Monitor Handoffs');
  if (!tab) return;

  var data = tab.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(p.tripId) &&
        String(data[i][3]) === String(p.leg)) {
      tab.getRange(i + 1, 10).setValue(p.confirmedAt       || '');
      tab.getRange(i + 1, 11).setValue(p.confirmedTimestamp|| '');
      return;
    }
  }
}


// ══════════════════════════════════════════════════════════════════════
// READ HANDLERS
// ══════════════════════════════════════════════════════════════════════

function getOpsData() {
  var WIN = 14;   // rolling window (days)
  return {
    window:              WIN,
    generated:           Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a'),
    arrival:             getArrivalData(WIN),
    custodial:           getCustodialData(WIN),
    // ADDED (Sep 2026) — one row per walkthrough logged in the last 28
    // days, across all campuses, for the dashboard's combined "Walkthrough
    // Frequency" calendar. See getCustodialWalkthroughDates's own header.
    custodialCalendar:   getCustodialWalkthroughDates(28),
    // ADDED (Sep 2026) — see change note 15. Feeds the Ops Dashboard's
    // Common Space Walkthrough tile, same shape as custodial/custodialCalendar.
    commonSpace:         getCommonSpaceData(WIN),
    commonSpaceCalendar: getCommonSpaceWalkthroughDates(28),
    drills:              getDrillData()
  };
}

// FIXED (Aug 2026): keyed CLUSTER on real short campus codes (not full
// school names), and derives arrival-vs-dismissal from the timestamp's
// hour — before noon is arrival, at/after noon is dismissal — matching the
// "Analysis - Arrival and Dismissal" sheet tab's own rule exactly. The app
// itself has never collected a separate period field, and doesn't need to.
function getArrivalData(win) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Arrival Dismissal');
  if (!tab || tab.getLastRow() < 2) return [];

  var now    = new Date();
  var cutoff = new Date(now - win * 864e5);
  var prior  = new Date(now - 2 * win * 864e5);
  var data   = tab.getRange(2, 1, tab.getLastRow() - 1, 17).getValues(); // A:Q

  var CLUSTER = {
    AEC: 'Anacostia', AMC: 'Anacostia',
    BEC: 'Benning',   BMC: 'Benning',
    EEC: 'Edgewood',  EMC: 'Edgewood'
  };
  var CLUSTERS = ['Anacostia', 'Benning', 'Edgewood'];

  // ADDED (Aug 2026): checkCounts alongside the existing flagCounts, so we
  // can compute a "checked rate" per item — not just a "flagged rate" —
  // for the new "Most Consistent" section on the Arrival & Dismissal
  // dashboard screen.
  function emptyBucket() { return { n:0, strong:0, ok:0, needsWork:0, flagCounts:{}, checkCounts:{} }; }
  var buckets = {};
  CLUSTERS.forEach(function(cl) {
    buckets[cl] = {
      arrival:   { curr: emptyBucket(), prior: emptyBucket() },
      dismissal: { curr: emptyBucket(), prior: emptyBucket() }
    };
  });

  data.forEach(function(r) {
    var ts  = r[0] instanceof Date ? r[0] : new Date(r[0]);
    var cl  = CLUSTER[String(r[1]).trim()] || '';   // B Campus
    var rat = String(r[5]).trim();                   // F Overall Rating
    if (!cl) return;

    var per = ts.getHours() < 12 ? 'arrival' : 'dismissal';

    var bucket;
    if      (ts >= cutoff) bucket = buckets[cl][per].curr;
    else if (ts >= prior)  bucket = buckets[cl][per].prior;
    else return;

    bucket.n++;
    if      (rat === 'Strong')     bucket.strong++;
    else if (rat === 'OK')         bucket.ok++;
    else if (rat === 'Needs work') bucket.needsWork++;

    ARRIVAL_ITEMS.forEach(function(item, i) {
      var val = r[6 + i];                             // G–P
      if (val === 'flagged') {
        bucket.flagCounts[item] = (bucket.flagCounts[item] || 0) + 1;
      } else if (val === 'checked') {
        // ADDED (Aug 2026)
        bucket.checkCounts[item] = (bucket.checkCounts[item] || 0) + 1;
      }
    });
  });

  return CLUSTERS.map(function(cl) {
    var result = { cluster: cl };
    ['arrival','dismissal'].forEach(function(per) {
      var cur = buckets[cl][per].curr;
      var pri = buckets[cl][per].prior;
      var n   = cur.n;
      function pct(v) { return n ? Math.round(v / n * 100) : 0; }
      var flags = ARRIVAL_ITEMS.map(function(item) {
        var cnt  = cur.flagCounts[item] || 0;
        var rate = n ? Math.round(cnt / n * 100) : 0;
        return { item: item, rate: rate };
      }).filter(function(f) { return f.rate >= 30; })
        .sort(function(a,b) { return b.rate - a.rate; });

      // ADDED (Aug 2026): up to 3 items with the highest checked rate
      // over the current window, for the "Most Consistent" section.
      var top = n ? ARRIVAL_ITEMS.map(function(item) {
        var cnt  = cur.checkCounts[item] || 0;
        var rate = Math.round(cnt / n * 100);
        return { item: item, rate: rate };
      }).sort(function(a,b) { return b.rate - a.rate; })
        .slice(0, 3) : [];

      result[per] = {
        current: { n: n, strong: pct(cur.strong), ok: pct(cur.ok), needsWork: pct(cur.needsWork) },
        prior:   pri.n ? { n: pri.n, strong: Math.round(pri.strong/pri.n*100),
                            ok: Math.round(pri.ok/pri.n*100),
                            needsWork: Math.round(pri.needsWork/pri.n*100) } : null,
        flags: flags,
        top: top
      };
    });
    return result;
  });
}

// FIXED (Aug 2026): CLUSTER was keyed on full school names ('Anacostia
// Elementary', etc.), but the Campus column has only ever held the short
// codes the app actually sends (AEC, BEC, ...) — same class of bug already
// fixed in getArrivalData above. That meant every row failed the cluster
// lookup and got silently dropped before any bucketing happened. Also
// reads the JSON checklist detail from column G now (was reading it from
// column E, which is the Items Checked count, not the detail blob) — see
// handleCustodial's header comment for the current column layout.
//
// FIXED (Sep 2026): see change note 12 at the top of this file. Two
// changes here specifically:
//   - flags[] now excludes any item with n < MIN_CUSTODIAL_N (a rate
//     computed from 1–2 walkthroughs was showing up looking exactly as
//     confident as one computed from dozens).
//   - each flag now carries its own `n` so the dashboard can show/label
//     sample size, and `trend` is 'new' (not 'stable') when there's no
//     prior-period rate to compare against.
//
// ADDED (Sep 2026): see change note 13. `topConsistent` (Most Consistent
// Items) mirrors getArrivalData's `top`, and `trend` now covers Aug–Jun
// (11 months) instead of Aug–Jul (12) — see MONTHS below.
function getCustodialData(win) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Custodial Walkthrough');
  if (!tab || tab.getLastRow() < 2) return [];

  var now    = new Date();
  var cutoff = new Date(now - win * 864e5);
  var prior  = new Date(now - 2 * win * 864e5);
  var data   = tab.getRange(2, 1, tab.getLastRow() - 1, 7).getValues();

  var CLUSTER = {
    AEC: 'Anacostia', AMC: 'Anacostia',
    BEC: 'Benning',   BMC: 'Benning',
    EEC: 'Edgewood',  EMC: 'Edgewood'
  };
  var CLUSTERS = ['Anacostia','Benning','Edgewood'];
  // ADDED (Sep 2026): Aug–Jun only (11 months) — the dashboard's bar chart
  // doesn't show a July bar, so the trend series no longer computes one.
  var MONTHS   = ['Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];

  function emptyPeriod() { return { n:0, checked:0, total:0, itemCounts:{} }; }
  var buckets = {};
  CLUSTERS.forEach(function(cl) {
    buckets[cl] = { curr: emptyPeriod(), prior: emptyPeriod(),
                    months: MONTHS.map(function(){ return emptyPeriod(); }) };
  });

  data.forEach(function(r) {
    var ts  = r[0] instanceof Date ? r[0] : new Date(r[0]);
    var cl  = CLUSTER[String(r[1]).trim()] || '';
    var chk = safeParseJSON(r[6]);   // G Checklist Detail (JSON)
    if (!cl) return;

    var items = Object.keys(chk);
    var done  = items.filter(function(k){ return chk[k] === 'checked'; }).length;

    var bucket;
    if      (ts >= cutoff)  bucket = buckets[cl].curr;
    else if (ts >= prior)   bucket = buckets[cl].prior;
    else                    bucket = null;
    if (bucket) {
      bucket.n++; bucket.checked += done; bucket.total += items.length;
      items.forEach(function(item) {
        bucket.itemCounts[item] = (bucket.itemCounts[item] || { ok:0, flag:0 });
        if (chk[item] === 'checked') bucket.itemCounts[item].ok++;
        if (chk[item] === 'flagged') bucket.itemCounts[item].flag++;
      });
    }
    // ADDED (Sep 2026): July (mIdx 11 under the old 12-month scheme) has
    // no bar in MONTHS anymore — skip it here rather than let it throw on
    // an out-of-range months[] index. Still fully counted in curr/prior
    // above; only the by-month trend series excludes it.
    var mIdx = (ts.getMonth() + 12 - 7) % 12;
    if (mIdx < MONTHS.length) {
      var mb = buckets[cl].months[mIdx];
      mb.n++; mb.checked += done; mb.total += items.length;
    }
  });

  return CLUSTERS.map(function(cl) {
    var cur  = buckets[cl].curr;
    var pri  = buckets[cl].prior;
    var curPct  = cur.total  ? Math.round(cur.checked  / cur.total  * 100) : null;
    var priPct  = pri.total  ? Math.round(pri.checked  / pri.total  * 100) : null;

    var allItems = Object.keys(cur.itemCounts);
    var flags = allItems.map(function(item) {
      var ic   = cur.itemCounts[item];
      var n    = ic.ok + ic.flag;
      var rate = n ? Math.round(ic.flag / n * 100) : 0;
      var pic  = pri.itemCounts[item] || { ok:0, flag:0 };
      var pn   = pic.ok + pic.flag;
      var prate = pn ? Math.round(pic.flag / pn * 100) : null;
      // FIXED (Sep 2026): 'new' (not 'stable') when there's no prior-
      // period rate to compare against — see change note 12.
      var trend = prate === null ? 'new' :
                  (rate > prate + 5 ? 'focus' : rate < prate - 5 ? 'improving' : 'stable');
      return { item: item, curr: rate, prior: prate, n: n, trend: trend };
    })
      // FIXED (Sep 2026): drop items with too few observations to trust
      // the rate — see MIN_CUSTODIAL_N and change note 12.
      .filter(function(f){ return f.curr >= 20 && f.n >= MIN_CUSTODIAL_N; })
      .sort(function(a,b){ return b.curr - a.curr; })
      .slice(0, 6);

    // ADDED (Sep 2026): Most Consistent Items — mirrors getArrivalData's
    // `top`. Same min-sample gate as `flags` (MIN_CUSTODIAL_N), sorted by
    // highest checked (not-flagged) rate, top 3.
    var topConsistent = allItems.map(function(item) {
      var ic   = cur.itemCounts[item];
      var n    = ic.ok + ic.flag;
      var rate = n ? Math.round(ic.ok / n * 100) : 0;
      return { item: item, rate: rate, n: n };
    })
      .filter(function(t){ return t.n >= MIN_CUSTODIAL_N; })
      .sort(function(a,b){ return b.rate - a.rate; })
      .slice(0, 3);

    var trend = buckets[cl].months.map(function(mb, i) {
      return { label: MONTHS[i], pct: mb.total ? Math.round(mb.checked/mb.total*100) : null };
    });

    return {
      cluster: cl, n: cur.n,
      currentPct: curPct, priorPct: priPct,
      window: win, trend: trend, flags: flags,
      topConsistent: topConsistent
    };
  });
}

// ADDED (Sep 2026) — see change note 13. Feeds the dashboard's combined
// "Walkthrough Frequency" calendar: one row per walkthrough actually
// logged in the last `days` days, tagged with its campus cluster, so the
// front end can render one dot per observation (not an aggregate count)
// on a single calendar spanning all three campuses.
//
// EXPANDED (Sep 2026) — see change note 16. Now also returns the full
// submission detail (role, checklistType, itemsChecked/Flagged, the
// per-item checks object, notes) and the raw campusCode, so the dashboard
// can show exactly what was submitted when someone clicks into a day
// rather than just that a walkthrough happened.
function getCustodialWalkthroughDates(days) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Custodial Walkthrough');
  if (!tab || tab.getLastRow() < 2) return [];

  var cutoff = new Date(new Date() - days * 864e5);
  var data   = tab.getRange(2, 1, tab.getLastRow() - 1, 8).getValues(); // A:H

  var CLUSTER = {
    AEC: 'Anacostia', AMC: 'Anacostia',
    BEC: 'Benning',   BMC: 'Benning',
    EEC: 'Edgewood',  EMC: 'Edgewood'
  };

  var rows = [];
  data.forEach(function(r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (!(ts instanceof Date) || isNaN(ts.getTime()) || ts < cutoff) return;
    var campusCode = String(r[1] || '').trim();
    var cl = CLUSTER[campusCode] || '';
    if (!cl) return;
    rows.push({
      ts: ts.getTime(),
      campus: cl,
      campusCode: campusCode,
      role: String(r[2] || '').trim(),
      checklistType: String(r[3] || '').trim(),
      itemsChecked: Number(r[4]) || 0,
      itemsFlagged: Number(r[5]) || 0,
      checks: safeParseJSON(r[6]),
      notes: String(r[7] || '').trim()
    });
  });
  return rows;
}

// ADDED (Sep 2026) — see change note 15. Feeds the Ops Dashboard's Common
// Space Walkthrough tile, built to mirror getCustodialData's structure
// exactly (same trend/flags/topConsistent shape, same MIN_CUSTODIAL_N
// sample-size gate, same Aug–Jun by-month series). One deliberate
// difference: each of the 10 spaces (columns I–R, WALK_SPACE_LABELS) is
// marked 'good'/'upkeep'/'flag'/'skipped' — three tiers, shown to the
// submitter as "Well kept"/"Needs improvement"/"Major issues" — rather
// than Custodial's plain checked/flagged. Per direction from Charles:
// only 'good' ("Well kept") counts as checked/ok; both 'upkeep' and
// 'flag' count against the checked % and both land together in `flags`
// ("Where We Can Improve"). 'skipped' counts toward the denominator (it
// was part of the walkthrough) but toward neither ok nor flag — same
// treatment Custodial gives 'no input'/'skipped'.
function getCommonSpaceData(win) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Common Space Walkthrough');
  if (!tab || tab.getLastRow() < 2) return [];

  var now    = new Date();
  var cutoff = new Date(now - win * 864e5);
  var prior  = new Date(now - 2 * win * 864e5);
  var data   = tab.getRange(2, 1, tab.getLastRow() - 1, 18).getValues(); // A:R

  var CLUSTER = {
    AEC: 'Anacostia', AMC: 'Anacostia',
    BEC: 'Benning',   BMC: 'Benning',
    EEC: 'Edgewood',  EMC: 'Edgewood'
  };
  var CLUSTERS = ['Anacostia', 'Benning', 'Edgewood'];
  // Same Aug–Jun (11 months) window as Custodial's trend — see
  // getCustodialData's own comment (change note 13) for why July is
  // excluded from the by-month series but not from curr/prior.
  var MONTHS = ['Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];

  function emptyPeriod() { return { n:0, ok:0, total:0, itemCounts:{} }; }
  var buckets = {};
  CLUSTERS.forEach(function(cl) {
    buckets[cl] = { curr: emptyPeriod(), prior: emptyPeriod(),
                    months: MONTHS.map(function(){ return emptyPeriod(); }) };
  });

  data.forEach(function(r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    var cl = CLUSTER[String(r[1]).trim()] || '';
    if (!cl) return;

    var rowStatuses = {}; // space label -> status, only for non-blank cells
    var okCount = 0, itemsPresent = 0;
    WALK_SPACE_LABELS.forEach(function(label, idx) {
      var val = String(r[8 + idx] || '').trim(); // I is index 8 (0-based)
      if (!val) return; // blank = not part of this walkthrough at all
      rowStatuses[label] = val;
      itemsPresent++;
      if (val === 'good') okCount++;
    });

    var bucket = null;
    if      (ts >= cutoff) bucket = buckets[cl].curr;
    else if (ts >= prior)  bucket = buckets[cl].prior;
    if (bucket) {
      bucket.n++; bucket.ok += okCount; bucket.total += itemsPresent;
      Object.keys(rowStatuses).forEach(function(label) {
        bucket.itemCounts[label] = bucket.itemCounts[label] || { ok:0, flag:0 };
        var val = rowStatuses[label];
        if (val === 'good') bucket.itemCounts[label].ok++;
        else if (val === 'upkeep' || val === 'flag') bucket.itemCounts[label].flag++;
        // 'skipped' increments neither — counted in bucket.total above only.
      });
    }

    var mIdx = (ts.getMonth() + 12 - 7) % 12;
    if (mIdx < MONTHS.length) {
      var mb = buckets[cl].months[mIdx];
      mb.n++; mb.ok += okCount; mb.total += itemsPresent;
    }
  });

  return CLUSTERS.map(function(cl) {
    var cur = buckets[cl].curr;
    var pri = buckets[cl].prior;
    var curPct = cur.total ? Math.round(cur.ok / cur.total * 100) : null;
    var priPct = pri.total ? Math.round(pri.ok / pri.total * 100) : null;

    var allItems = Object.keys(cur.itemCounts);
    var flags = allItems.map(function(item) {
      var ic   = cur.itemCounts[item];
      var n    = ic.ok + ic.flag;
      var rate = n ? Math.round(ic.flag / n * 100) : 0;
      var pic  = pri.itemCounts[item] || { ok:0, flag:0 };
      var pn   = pic.ok + pic.flag;
      var prate = pn ? Math.round(pic.flag / pn * 100) : null;
      var trend = prate === null ? 'new' :
                  (rate > prate + 5 ? 'focus' : rate < prate - 5 ? 'improving' : 'stable');
      return { item: item, curr: rate, prior: prate, n: n, trend: trend };
    })
      .filter(function(f){ return f.curr >= 20 && f.n >= MIN_CUSTODIAL_N; })
      .sort(function(a,b){ return b.curr - a.curr; })
      .slice(0, 6);

    var topConsistent = allItems.map(function(item) {
      var ic   = cur.itemCounts[item];
      var n    = ic.ok + ic.flag;
      var rate = n ? Math.round(ic.ok / n * 100) : 0;
      return { item: item, rate: rate, n: n };
    })
      .filter(function(t){ return t.n >= MIN_CUSTODIAL_N; })
      .sort(function(a,b){ return b.rate - a.rate; })
      .slice(0, 3);

    var trend = buckets[cl].months.map(function(mb, i) {
      return { label: MONTHS[i], pct: mb.total ? Math.round(mb.ok/mb.total*100) : null };
    });

    return {
      cluster: cl, n: cur.n,
      currentPct: curPct, priorPct: priPct,
      window: win, trend: trend, flags: flags,
      topConsistent: topConsistent
    };
  });
}

// One row per Common Space Walkthrough logged in the last `days` days,
// tagged with campus cluster — same shape as getCustodialWalkthroughDates,
// for the Common Space tile's own calendar.
//
// EXPANDED (Sep 2026) — see change note 16. Now also returns name, the
// five spacesAssessed/Good/Upkeep/Flagged/Skipped counts, the parsed
// per-space ratings object, notes, and the raw campusCode.
function getCommonSpaceWalkthroughDates(days) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Common Space Walkthrough');
  if (!tab || tab.getLastRow() < 2) return [];

  var cutoff = new Date(new Date() - days * 864e5);
  var data   = tab.getRange(2, 1, tab.getLastRow() - 1, 19).getValues(); // A:S

  var CLUSTER = {
    AEC: 'Anacostia', AMC: 'Anacostia',
    BEC: 'Benning',   BMC: 'Benning',
    EEC: 'Edgewood',  EMC: 'Edgewood'
  };

  var rows = [];
  data.forEach(function(r) {
    var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (!(ts instanceof Date) || isNaN(ts.getTime()) || ts < cutoff) return;
    var campusCode = String(r[1] || '').trim();
    var cl = CLUSTER[campusCode] || '';
    if (!cl) return;

    var ratings = {};
    WALK_SPACE_LABELS.forEach(function(label, idx) {
      var val = String(r[8 + idx] || '').trim(); // I is index 8 (0-based)
      if (val) ratings[label] = val;
    });

    rows.push({
      ts: ts.getTime(),
      campus: cl,
      campusCode: campusCode,
      name: String(r[2] || '').trim(),
      spacesAssessed: Number(r[3]) || 0,
      spacesGood: Number(r[4]) || 0,
      spacesUpkeep: Number(r[5]) || 0,
      spacesFlagged: Number(r[6]) || 0,
      spacesSkipped: Number(r[7]) || 0,
      ratings: ratings,
      notes: String(r[18] || '').trim() // S is index 18 (0-based)
    });
  });
  return rows;
}

// REWRITTEN (Oct 2026) — see change note 19.
function getDrillData() {
  var tz  = Session.getScriptTimeZone();
  var now = new Date();
  var syStart = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  var syFrom  = new Date(syStart, 7, 1);      // Aug 1
  var syTo    = new Date(syStart + 1, 7, 1);  // next Aug 1
  var MONTHS  = [
    {label:'Aug',num:8},{label:'Sep',num:9},{label:'Oct',num:10},{label:'Nov',num:11},
    {label:'Dec',num:12},{label:'Jan',num:1},{label:'Feb',num:2},{label:'Mar',num:3},
    {label:'Apr',num:4},{label:'May',num:5},{label:'Jun',num:6},{label:'Jul',num:7}
  ];

  var groupOf = {};
  DRILL_GROUPS.forEach(function(g) {
    g.schools.forEach(function(code) { groupOf[code] = g.id; });
  });
  function emptyGroups() {
    return DRILL_GROUPS.map(function(g) {
      return {
        id: g.id, label: g.label, schools: g.schools,
        evac: MONTHS.map(function(){ return 'none'; }),
        lock: MONTHS.map(function(){ return 'none'; }),
        lastEvac: null, lastLock: null, drills: []
      };
    });
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Drill Log');
  if (!tab) return { groups: emptyGroups(), months: MONTHS, syStart: syStart };
  var lastRow = findLastDataRow(tab, 1, 20000);
  if (lastRow < 2) return { groups: emptyGroups(), months: MONTHS, syStart: syStart };

  var nCols = Math.min(28, tab.getMaxColumns());
  var range = tab.getRange(2, 1, lastRow - 1, nCols);
  var vals  = range.getValues();
  var disp  = range.getDisplayValues(); // times exactly as the sheet shows them

  function cell(i, col) { return col < nCols ? String(disp[i][col] || '').trim() : ''; }
  function fmtDur(secs) {
    var m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var oslByKey = {}, obsByKey = {};
  vals.forEach(function(r, i) {
    var ts = r[0];
    if (!(ts instanceof Date) || ts < syFrom || ts >= syTo) return;
    var code = String(r[1]).trim();
    var gid  = groupOf[code];
    if (!gid) return;
    var typeRaw = String(r[3]).trim();
    var type = typeRaw.toLowerCase();
    if (type !== 'evacuation' && type !== 'lockdown') return;
    var key = gid + '|' + type + '|' + Utilities.formatDate(ts, tz, 'yyyy-MM-dd');

    if (String(r[2]).trim() === 'OSL') {
      (oslByKey[key] = oslByKey[key] || []).push({ ts: ts, i: i, r: r, code: code, typeRaw: typeRaw });
    } else {
      (obsByKey[key] = obsByKey[key] || []).push({
        ts: ts, code: code,
        role: String(r[2]).trim(),
        notes: cell(i, 19),
        assessment: cell(i, 27)
      });
    }
  });

  var groups = emptyGroups();
  var byId = {};
  groups.forEach(function(g) { byId[g.id] = g; });

  Object.keys(oslByKey).forEach(function(key) {
    var parts = key.split('|');
    var g     = byId[parts[0]];
    var type  = parts[1];
    var rows  = oslByKey[key].sort(function(a, b) { return a.ts - b.ts; });
    var first = rows[0], fi = first.i, fr = first.r;
    var items = type === 'evacuation' ? DRILL_EVAC_ITEMS : DRILL_LOCK_ITEMS;
    var offset = type === 'evacuation' ? 10 : 10 + DRILL_EVAC_ITEMS.length; // K, or P

    var schools = [], occupants = [], flags = [], notes = [];
    rows.forEach(function(x) {
      if (schools.indexOf(x.code) === -1) {
        schools.push(x.code);
        occupants.push({ campus: x.code, count: cell(x.i, 7) });
      }
      String(x.r[9] || '').split(';').forEach(function(f) {
        f = f.trim();
        if (f && flags.indexOf(f) === -1) flags.push(f);
      });
      var n = cell(x.i, 19);
      if (n && notes.indexOf(n) === -1) notes.push(n);
    });

    // List schools in the group's own order (e.g. AMC before AEC).
    var order = g.schools;
    occupants.sort(function(a, b) { return order.indexOf(a.campus) - order.indexOf(b.campus); });
    schools = occupants.map(function(o) { return o.campus; });

    var observations = items.map(function(item, k) {
      return { item: item, value: cell(fi, offset + k) };
    });

    var seen = {}, observers = [];
    (obsByKey[key] || []).sort(function(a, b) { return a.ts - b.ts; }).forEach(function(o) {
      var sig = o.role + '|' + o.notes + '|' + o.assessment;
      if (seen[sig]) { seen[sig].schools.push(o.code); return; }
      seen[sig] = { role: o.role, notes: o.notes, assessment: o.assessment, schools: [o.code] };
      observers.push(seen[sig]);
    });

    var durationSecs = Number(fr[8]) || 0;
    var drill = {
      ts:           first.ts.getTime(),
      type:         first.typeRaw,
      date:         Utilities.formatDate(first.ts, tz, 'MMM d, yyyy'),
      dateLong:     Utilities.formatDate(first.ts, tz, 'EEEE, MMMM d, yyyy'),
      schools:      schools,
      weather:      cell(fi, 4),
      alarmStart:   cell(fi, 5),
      exitTime:     cell(fi, 24),
      allClearTime: cell(fi, 6),
      endTime:      cell(fi, 25),
      occupants:    occupants,
      durationSecs: durationSecs,
      duration:     fmtDur(durationSecs),
      under10:      durationSecs > 0 && durationSecs < 600,
      flags:        flags,
      observations: observations,
      notes:        notes.join('\n\n'),
      observers:    observers
    };
    g.drills.push(drill);

    var mIdx = (first.ts.getMonth() + 12 - 7) % 12; // Aug = 0
    if (type === 'evacuation') g.evac[mIdx] = 'ok'; else g.lock[mIdx] = 'ok';
  });

  groups.forEach(function(g) {
    g.drills.sort(function(a, b) { return b.ts - a.ts; });
    g.lastEvac = g.drills.filter(function(d){ return d.type.toLowerCase() === 'evacuation'; })[0] || null;
    g.lastLock = g.drills.filter(function(d){ return d.type.toLowerCase() === 'lockdown'; })[0] || null;
  });

  return { groups: groups, months: MONTHS, syStart: syStart };
}

function findLastDataRow(tab, col, maxRow) {
  var lastRow = Math.min(maxRow, tab.getMaxRows());
  if (lastRow < 2) return 1;
  var values = tab.getRange(2, col, lastRow - 1, 1).getValues();
  var last = 1;
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] !== '' && values[i][0] !== null) last = i + 2;
  }
  return last;
}

// ── Transport Dashboard data ───────────────────────────────────────────
function getTransportData() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Bus Trip Log');
  if (!tab || tab.getLastRow() < 2) return { routes: [] };

  var data = tab.getRange(2, 1, tab.getLastRow() - 1, 10).getValues();
  var hTab = ss.getSheetByName('Bus Trip - Monitor Handoffs');
  var hData = hTab && hTab.getLastRow() > 1
    ? hTab.getRange(2, 1, hTab.getLastRow() - 1, 11).getValues() : [];
  var iTab = ss.getSheetByName('Bus Trip - Incidents');
  var iData = iTab && iTab.getLastRow() > 1
    ? iTab.getRange(2, 1, iTab.getLastRow() - 1, 6).getValues() : [];

  var trips = data.map(function(r) {
    var dep = r[5] instanceof Date ? r[5] : null;
    var arr = r[6] instanceof Date ? r[6] : null;
    var mins = dep && arr ? (arr - dep) / 60000 : null;
    var targetDep = r[3] === 'AM' ? {h:7,m:45} : {h:15,m:35};
    var ts  = r[0] instanceof Date ? r[0] : new Date(r[0]);
    if (r[3] === 'PM' && ts.getDay() === 3) targetDep = {h:13,m:45};
    var onTime = dep ? (dep.getHours() * 60 + dep.getMinutes()) <= (targetDep.h * 60 + targetDep.m + 5) : null;
    return { ts: ts, tripId: String(r[1]), leg: String(r[3]), riders: Number(r[7]),
             manifest: Number(r[8]), durationMins: mins, onTime: onTime };
  });

  var amTrips = trips.filter(function(t){ return t.leg === 'AM'; });
  var pmTrips = trips.filter(function(t){ return t.leg === 'PM'; });
  var tz      = Session.getScriptTimeZone();

  function stats(arr) {
    if (!arr.length) return { onTime: null, median: null, p90: null };
    var onTimeN = arr.filter(function(t){ return t.onTime; }).length;
    var durs    = arr.map(function(t){ return t.durationMins; }).filter(function(x){ return x !== null; }).sort(function(a,b){ return a-b; });
    return {
      onTime: Math.round(onTimeN / arr.length * 100),
      median: durs.length ? Math.round(durs[Math.floor(durs.length/2)]) : null,
      p90:    durs.length ? Math.round(durs[Math.floor(durs.length * 0.9)]) : null
    };
  }

  var sameDayConfirmed = hData.filter(function(r){
    return r[9] && r[9] !== '';
  }).length;
  var handoffTotal = hData.length;
  var confirmedPct = handoffTotal ? Math.round(sameDayConfirmed / handoffTotal * 100) : null;

  var uniqueDays = {};
  trips.forEach(function(t){ uniqueDays[Utilities.formatDate(t.ts, tz, 'yyyy-MM-dd')] = true; });
  var schoolDays = 35;
  var daysLoggedPct = Math.round(Object.keys(uniqueDays).length / schoolDays * 100);

  var avgRiders = trips.length
    ? Math.round(trips.reduce(function(s,t){ return s+t.riders; },0) / trips.length)
    : null;
  var manifestSize = trips.length ? trips[trips.length-1].manifest : null;

  var issues = iData.slice(-20).map(function(r) {
    var ts   = r[0] instanceof Date ? r[0] : new Date(r[0]);
    var hRow = hData.find(function(h){ return String(h[1]) === String(r[1]) && String(h[3]) === String(r[3]); });
    return {
      date:              Utilities.formatDate(ts, tz, 'MMM d'),
      tripId:            String(r[1]),
      leg:               String(r[3]),
      category:          String(r[4]),
      notes:             String(r[5]),
      liaisonConfirmed:  hRow && hRow[9] ? 'yes' : 'no'
    };
  }).reverse();

  return {
    routes: [{
      label:              'R1: The Next Step ↔ Edgewood',
      campuses:           'The Next Step (TNS) ↔ Edgewood Elementary / Middle',
      avgRidership:       avgRiders,
      manifestSize:       manifestSize,
      daysLogged:         daysLoggedPct,
      handoffsConfirmed:  confirmedPct,
      am:                 stats(amTrips),
      pm:                 stats(pmTrips)
    }],
    issues: issues,
    generated: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a')
  };
}

// ── BOY Readiness Dashboard data ──────────────────────────────────────
function getReadinessHistory() {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Ops Readiness Log');
  if (!tab) return { rows: [] };

  var lastRow = findLastDataRow(tab, 1, 1000);
  if (lastRow < 2) return { rows: [] };

  var data = tab.getRange(2, 1, lastRow - 1, 8).getValues();
  var rows = [];
  data.forEach(function(r) {
    var ts = r[0];
    if (!(ts instanceof Date)) return;
    rows.push({
      ts:         ts.getTime(),
      campus:     String(r[2] || '').trim(),
      section:    String(r[3] || '').trim(),
      space:      String(r[4] || '').trim(),
      room:       String(r[5] || '').trim(),
      assessment: String(r[7] || '').trim()
    });
  });
  return { rows: rows };
}

function dotClassGAS(assessment) {
  if (!assessment) return 'blank';
  var a = String(assessment).toLowerCase();
  if (a.indexOf('pending sdo signoff') > -1) return 'pending';
  if (a.indexOf('fully') > -1) return 'ok';
  if (a.indexOf('minor') > -1) return 'minor';
  if (a.indexOf('not ready') > -1) return 'bad';
  if (a === 'n/a' || a === 'na') return 'na';
  if (a === 'ready') return 'ok';
  if (a === 'issues') return 'bad';
  if (a === 'resolved') return 'ok';
  return 'blank';
}

function combinedStatusGAS(sdoAssessment, techAssessment) {
  var sdoCls = dotClassGAS(sdoAssessment);
  var techCls = dotClassGAS(techAssessment);
  var sdoNA = sdoCls === 'na';
  var techNA = techCls === 'na';
  if (sdoNA && techNA) return 'na';
  function simplify(cls) { return (cls === 'ok' || cls === 'minor') ? cls : null; }
  if (sdoNA)  return simplify(techCls) || 'blank';
  if (techNA) return simplify(sdoCls)  || 'blank';
  var a = simplify(sdoCls), b = simplify(techCls);
  if (a === 'ok' && b === 'ok') return 'ok';
  if (a && b) return 'minor';
  return 'blank';
}

function logDailySnapshot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allSpaces = ss.getSheetByName('All Spaces');
  var snap = ss.getSheetByName('Readiness Daily Snapshot');
  if (!allSpaces) return;
  if (!snap) {
    snap = ss.insertSheet('Readiness Daily Snapshot');
    snap.getRange(1,1,1,2).setValues([['Date','Total Remaining']]);
  }

  var lastRow = allSpaces.getLastRow();
  if (lastRow < 2) return;
  var data = allSpaces.getRange(2, 1, lastRow - 1, 8).getValues();

  var remaining = 0;
  data.forEach(function(r) {
    if (!r[0]) return;
    var techAssessment = r[6];
    var sdoAssessment  = r[7];
    var cls = combinedStatusGAS(sdoAssessment, techAssessment);
    if (cls === 'na' || cls === 'ok') return;
    remaining++;
  });

  var today = new Date();
  today.setHours(0,0,0,0);
  var row = findFirstEmptyRow(snap, 1, 2000);
  snap.getRange(row, 1).setValue(today);
  snap.getRange(row, 2).setValue(remaining);
}

function setupDailySnapshotTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'logDailySnapshot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('logDailySnapshot')
    .timeBased()
    .everyDays(1)
    .atHour(18)
    .create();
}

function getDailySnapshots() {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Readiness Daily Snapshot');
  if (!tab) return { rows: [] };
  var lastRow = findLastDataRow(tab, 1, 2000);
  if (lastRow < 2) return { rows: [] };
  var data = tab.getRange(2, 1, lastRow - 1, 2).getValues();
  var rows = [];
  data.forEach(function(r) {
    if (!(r[0] instanceof Date)) return;
    rows.push({ ts: r[0].getTime(), totalRemaining: Number(r[1]) || 0 });
  });
  return { rows: rows };
}

// ── Daily Readiness Wins ────────────────────────────────────────────────────
function handleDailyWin(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName('Daily Wins');
  if (!tab) {
    tab = ss.insertSheet('Daily Wins');
    tab.getRange(1,1,1,3).setValues([['Timestamp','Role','Text']]);
  }
  var row = findFirstEmptyRow(tab, 1, 5000);
  tab.getRange(row, 1).setValue(new Date());
  tab.getRange(row, 2).setValue(p.role || '');
  tab.getRange(row, 3).setValue(p.text || '');
}

function getDailyWins() {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Daily Wins');
  if (!tab) return { rows: [] };
  var lastRow = findLastDataRow(tab, 1, 5000);
  if (lastRow < 2) return { rows: [] };
  var data = tab.getRange(2, 1, lastRow - 1, 3).getValues();
  var rows = [];
  data.forEach(function(r) {
    if (!(r[0] instanceof Date)) return;
    rows.push({ ts: r[0].getTime(), role: String(r[1] || '').trim(), text: String(r[2] || '').trim() });
  });
  rows.sort(function(a,b) { return b.ts - a.ts; });
  return { rows: rows };
}

// ── Ops AI Bingo ─────────────────────────────────────────────────────────
// ADDED (Aug 2026). See file-header note 11 for the full rationale. Unlike
// every write handler above, this is an UPSERT rather than an append: a
// bingo card is one person's mutable state (which squares they've marked),
// not a log of discrete events, so the same row gets found and updated in
// place on every mark/unmark rather than a new row being added each time.
//
// Sheet layout — tab "AI Bingo" (auto-created via getOrCreateTab if it
// doesn't exist yet):
//   A Timestamp (of most recent change) | B Name | C Marked (JSON array
//   of marked square positions, e.g. "[3,7,12]")
//
// Deliberately does NOT store each person's 5×5 square order. The app
// regenerates it deterministically from the person's name on every load
// (same hash-seeded shuffle client-side), so storing it here would just
// be a second copy that could drift out of sync for no benefit.
function handleBingo(p) {
  var name = String(p.name || '').trim();
  if (!name) return; // no name, nothing to upsert against
  var marked = Array.isArray(p.marked) ? p.marked : [];

  var tab = getOrCreateTab('AI Bingo', ['Timestamp', 'Name', 'Marked']);
  var row = findBingoRow(tab, name);
  var now = new Date();

  if (row) {
    // Existing card — update in place. This is the upsert behavior.
    tab.getRange(row, 1).setValue(now);                     // A Timestamp
    tab.getRange(row, 3).setValue(JSON.stringify(marked));  // C Marked
  } else {
    // First time this person has ever marked a square.
    tab.appendRow([now, name, JSON.stringify(marked)]);
  }
}

// Finds the row for a given name (case-insensitive, trimmed) in the AI
// Bingo tab's Name column (B). Returns the 1-indexed sheet row, or null
// if that person doesn't have a card yet.
function findBingoRow(tab, name) {
  var lastRow = tab.getLastRow();
  if (lastRow < 2) return null;
  var target = String(name).trim().toLowerCase();
  var values = tab.getRange(2, 2, lastRow - 1, 1).getValues(); // column B
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim().toLowerCase() === target) return i + 2;
  }
  return null;
}

// Called from the app as: fetch(SCRIPT_URL + '?view=bingo')
// Returns everyone's cards for the "everyone's cards" overview screen.
function getBingoData() {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AI Bingo');
  if (!tab) return { cards: [] };
  var lastRow = findLastDataRow(tab, 2, 2000); // last row with a Name (col B)
  if (lastRow < 2) return { cards: [] };

  var data = tab.getRange(2, 1, lastRow - 1, 3).getValues();
  var cards = [];
  data.forEach(function(r) {
    var name = String(r[1] || '').trim();
    if (!name) return;
    cards.push({ name: name, marked: bingoParseMarked(r[2]) });
  });
  return { cards: cards };
}

// Like safeParseJSON, but specifically falls back to [] rather than {} —
// `marked` is always expected to be an array on the client (it's read
// with .includes()/.length), so a blank or corrupted cell should resolve
// to an empty board rather than an object that would break those calls.
function bingoParseMarked(raw) {
  if (!raw) return [];
  try {
    var v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

// FIXED (Aug 2026): now cached 60 seconds via CacheService — repeatedly
// tapping into the same campus tab, or two people loading it close
// together, skips re-reading All Spaces within that window. Nothing about
// the parsing logic below changed.
function getBOYReadiness(campus) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'boy_' + campus;
  var cachedVal = cache.get(cacheKey);
  if (cachedVal) {
    try { return JSON.parse(cachedVal); } catch (e) { /* fall through and recompute */ }
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tz  = Session.getScriptTimeZone();
  var tab = ss.getSheetByName('All Spaces');

  if (!tab || tab.getLastRow() < 2) {
    return { campus: campus, rooms: [], summary: emptySummary(),
             generated: Utilities.formatDate(new Date(), tz, 'MMM d, yyyy h:mm a') };
  }

  var data = tab.getRange(2, 1, tab.getLastRow() - 1, 10).getValues();
  var summary = emptySummary();
  var rooms = [];

  data.forEach(function(r) {
    var code      = String(r[0]).trim();
    var section   = String(r[2]).trim() || 'Other';
    var space     = String(r[3]).trim();
    var roomNum   = String(r[4]).trim();
    var mdsRaw    = String(r[5]).trim();
    var techRaw   = String(r[6]).trim();
    var sdoRaw    = String(r[7]).trim();
    var countsRaw = String(r[8]).trim();
    var notesRaw  = String(r[9]).trim();

    if (code !== campus || !space) return;

    function makeEntry(raw) {
      if (!raw || raw === '') return null;
      return { assessment: raw };
    }
    function isNA(raw) {
      return raw.toLowerCase() === 'n/a' || raw.toLowerCase() === 'na';
    }

    ['MDS','SDO'].forEach(function(t) {
      var raw = t === 'MDS' ? mdsRaw : sdoRaw;
      summary[t].total++;
      if      (!raw || raw === '')                        summary[t].notAssessed++;
      else if (isNA(raw))                                 summary[t].total--;
      else if (raw === 'Fully ready')                     summary[t].fullyReady++;
      else if (raw === 'Ready — minor items remain')       summary[t].minorItems++;
      else if (raw === 'Not ready — return visit needed') summary[t].notReady++;
      else                                                 summary[t].notAssessed++;
    });

    var deskCount = '', chairCount = '';
    if (countsRaw && countsRaw.indexOf('/') > -1) {
      var parts = countsRaw.split('/');
      deskCount  = parts[0] ? parts[0].trim() : '';
      chairCount = parts[1] ? parts[1].trim() : '';
    }

    rooms.push({
      space:      space,
      roomNumber: roomNum || '',
      section:    section,
      MDS:        makeEntry(mdsRaw),
      SDO:        makeEntry(sdoRaw),
      tech:       makeEntry(techRaw),
      notes:      notesRaw || '',
      deskCount:  deskCount,
      chairCount: chairCount
    });
  });

  var result = {
    campus:    campus,
    rooms:     rooms,
    summary:   summary,
    generated: Utilities.formatDate(new Date(), tz, 'MMM d, yyyy h:mm a')
  };

  try {
    var json = JSON.stringify(result);
    if (json.length < 95000) cache.put(cacheKey, json, 60);
  } catch (e) { /* caching is a bonus, not required for correctness */ }

  return result;
}

function emptySummary() {
  var s = {};
  ['MDS','SDO'].forEach(function(t) {
    s[t] = { total: 0, fullyReady: 0, minorItems: 0, notReady: 0, notAssessed: 0 };
  });
  return s;
}

// ── ADDED (Aug 2026): consolidated Overall-tab endpoint ────────────────
// Reads All Spaces ONCE and buckets every campus server-side, instead of
// the front end asking for getBOYReadiness(campus) six separate times —
// each of which re-read the entire sheet just to keep the rows for one
// campus. Also bundles in the readiness history, daily snapshots, and
// daily wins the Overall tab needs anyway, so the front end can get
// everything in a single request instead of nine.
//
// Cached 60 seconds via CacheService — a burst of page loads within that
// window (two people opening the dashboard back to back, or someone
// switching tabs and back to Overall) skips the sheet read entirely.
//
// Deliberately mirrors getBOYReadiness's per-room parsing as a separate
// pass rather than calling into it: that function is the tested,
// single-campus path, and duplicating its small parsing block here means
// a future fix to one can't silently change the other's behavior without
// someone noticing. If All Spaces' column layout ever changes, both need
// updating — see getBOYReadiness's own inline column comments for the
// canonical reference.
function getOverallReadinessData() {
  var cache = CacheService.getScriptCache();
  var cachedVal = cache.get('overallReadinessData');
  if (cachedVal) {
    try { return JSON.parse(cachedVal); } catch (e) { /* fall through and recompute */ }
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tz  = Session.getScriptTimeZone();
  var tab = ss.getSheetByName('All Spaces');

  var campusCodes = ['AEC', 'AMC', 'BEC', 'BMC', 'EEC', 'EMC'];
  var campuses = {};
  campusCodes.forEach(function(code) {
    campuses[code] = { campus: code, rooms: [], summary: emptySummary() };
  });

  if (tab && tab.getLastRow() >= 2) {
    var data = tab.getRange(2, 1, tab.getLastRow() - 1, 10).getValues();
    data.forEach(function(r) {
      var code = String(r[0]).trim();
      if (!campuses[code]) return; // not one of the six known campus codes

      var section   = String(r[2]).trim() || 'Other';
      var space     = String(r[3]).trim();
      if (!space) return;
      var roomNum   = String(r[4]).trim();
      var mdsRaw    = String(r[5]).trim();
      var techRaw   = String(r[6]).trim();
      var sdoRaw    = String(r[7]).trim();
      var countsRaw = String(r[8]).trim();
      var notesRaw  = String(r[9]).trim();

      function makeEntry(raw) { return (!raw || raw === '') ? null : { assessment: raw }; }
      function isNA(raw) { return raw.toLowerCase() === 'n/a' || raw.toLowerCase() === 'na'; }

      var summary = campuses[code].summary;
      ['MDS', 'SDO'].forEach(function(t) {
        var raw = t === 'MDS' ? mdsRaw : sdoRaw;
        summary[t].total++;
        if      (!raw || raw === '')                        summary[t].notAssessed++;
        else if (isNA(raw))                                 summary[t].total--;
        else if (raw === 'Fully ready')                     summary[t].fullyReady++;
        else if (raw === 'Ready — minor items remain')      summary[t].minorItems++;
        else if (raw === 'Not ready — return visit needed') summary[t].notReady++;
        else                                                 summary[t].notAssessed++;
      });

      var deskCount = '', chairCount = '';
      if (countsRaw && countsRaw.indexOf('/') > -1) {
        var parts = countsRaw.split('/');
        deskCount  = parts[0] ? parts[0].trim() : '';
        chairCount = parts[1] ? parts[1].trim() : '';
      }

      campuses[code].rooms.push({
        space: space,
        roomNumber: roomNum || '',
        section: section,
        MDS: makeEntry(mdsRaw),
        SDO: makeEntry(sdoRaw),
        tech: makeEntry(techRaw),
        notes: notesRaw || '',
        deskCount: deskCount,
        chairCount: chairCount
      });
    });
  }

  var generated = Utilities.formatDate(new Date(), tz, 'MMM d, yyyy h:mm a');
  campusCodes.forEach(function(code) { campuses[code].generated = generated; });

  var result = {
    campuses:  campuses,
    history:   getReadinessHistory(),
    snapshots: getDailySnapshots(),
    wins:      getDailyWins(),
    generated: generated
  };

  try {
    var json = JSON.stringify(result);
    // CacheService caps individual values around 100KB — comfortably
    // enough headroom for All Spaces plus the three smaller tabs, but if
    // that ever changes, this just quietly skips caching that round
    // rather than erroring.
    if (json.length < 95000) cache.put('overallReadinessData', json, 60);
  } catch (e) { /* caching is a bonus, not required for correctness */ }

  return result;
}


// ══════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════

function appendToTab(tabName, row) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(tabName);
  if (!tab) tab = ss.insertSheet(tabName);
  tab.appendRow(row);
}

function getOrCreateTab(tabName, headers) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(tabName);
  if (!tab) {
    tab = ss.insertSheet(tabName);
    if (headers) tab.appendRow(headers);
  }
  return tab;
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch(e) { return {}; }
}
