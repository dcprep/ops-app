# DC Prep Operations App

A mobile web app for the DC Prep operations team. Staff use it to log drills, walkthroughs, and observations from one link saved to their phone's home screen. Submissions land in a Google Sheet, and that Sheet feeds the ops dashboards.

> Items marked **[TBD]** need to be filled in by the owner before handoff.

---

## 1. Owners and accounts

| Piece | Where it lives | Current owner | Planned owner |
|---|---|---|---|
| App code (`index.html`) and dashboards | GitHub repo `dcprep/ops-app` | `dcprep` GitHub account (shared) | No change |
| Live app | https://dcprep.github.io/ops-app/ | `dcprep` GitHub account | No change |
| Data sheet: "DC Prep Ops App Log" | Charles's Google Drive | Charles | Operations shared drive |
| Ops App Apps Script (bound to the sheet above) | Sheet → Extensions → Apps Script | Charles (deployed and runs as Charles) | Rachel Jones |
| Daily snapshot trigger (`logDailySnapshot`, 6pm daily) | Ops App Apps Script → Triggers | Charles | Rachel Jones |
| Facilities sheet: "Facilities Work Orders and Dashboard - All Campuses SY26-27" and its Apps Script (`facilities-apps-script.js`) | Josh's Google Drive | Josh Fenwick | Operations shared drive (ask Josh to move it) |

Handoff note: moving a sheet to the shared drive doesn't break anything. The file ID, the bound script, and the URLs all stay the same. But the web app keeps running as the account that deployed it, and the trigger keeps running as the account that created it. So after the move, the planned owner needs to:

1. Create a new deployment from their own account (Deploy → New deployment → Web app → Execute as: Me).
2. Paste the new URL everywhere it appears (see section 4).
3. Run `setupDailySnapshotTrigger` from their own account, then delete the old trigger.

Do this before the current owner's account is turned off. The old URL keeps working until then, so there's no gap.

---

## 2. How staff access the app

Share this link: https://dcprep.github.io/ops-app/

Staff open it in their phone browser and tap **Add to Home Screen** (there's also a button for this at the bottom of the home screen).

---

## 3. What's on the home screen

| Section | Tool | Who uses it | Sends `flow` | Lands in tab |
|---|---|---|---|---|
| School Operations | Arrival & Dismissal | OSL, Principal, COO, SDO, Other | `arrival` | Arrival Dismissal |
| School Operations | Evacuation & Lockdown Drill | OSL (official record), others (observations) | `drill` | Drill Log |
| School Operations | Custodial Walkthrough | Director of Facilities, Custodial Vendor | `custodial` | Custodial Walkthrough |
| School Operations | Create Facilities Request | Anyone | none: links out to the 3 campus Google Forms | Campus work-order sheets (not this app) |
| School Operations | Common Space Walkthrough | Anyone (enters their name); rates 10 spaces | `walkthrough` | Common Space Walkthrough |
| Summer Apps | Daily Readiness Wins | By role | `daily-win` | Daily Wins |
| Summer Apps | BOY Building Readiness | Schools (MDS), Operations (SDO), Technology (DOT) | `boy-readiness` | MDS → Classroom Readiness; SDO → Ops Readiness Log; DOT → not saved (see Known issues) |
| Coming Later (marked Live) | Bus Trip Log | Bus monitors, Next Step pilot | `bustriplog`, `monitor-handoff` | See Known issues |
| Coming Later (marked Live) | Bus Trip Handoff | School liaison | `bustriphandoff` | See Known issues |
| Coming Later | Facility Needs Walkthrough, Security Patrol Log, Log Daily Attendance Check | n/a | Preview screens only, nothing is saved | n/a |

---

## 4. How the pieces connect

```
Phone (index.html)
  │  POST {flow: ...}            GET ?view=boy&campus=XXX            
  ▼                               ▲
Ops App Apps Script (SCRIPT_URL) ─┘
  │  writes / reads
  ▼
"DC Prep Ops App Log" Google Sheet
  │  ▲ Tech - AEC…EMC tabs IMPORTRANGE from the separate Tech-team sheet
  │
  ▼  GET ?view=ops | overall | transport | boy | readinessHistory | dailySnapshots | dailyWins
Dashboards (Ops, Readiness, Transport)

Campus Facilities Google Forms → campus work-order sheets → network synthesis sheet
  → Facilities Apps Script (FACILITIES_SCRIPT_URL) → Facilities Dashboard / Ops Dashboard Facilities tab
```

URLs to update if a script is ever redeployed under a new URL:

- `SCRIPT_URL` in `index.html` (about line 1768), plus a second hard-coded copy inside `sendEmailCopy()` (about line 1479)
- The same Ops App script URL in each dashboard file in the repo (`ops-dashboard.html` plus the Readiness and Transport dashboard files [TBD: file names])
- `FACILITIES_SCRIPT_URL` in `facilities-dashboard.html` and `ops-dashboard.html`

To push script changes without changing the URL: Apps Script → **Deploy → Manage deployments → Edit → Version: New version → Deploy**. Choosing **New deployment** creates a new URL, so you'd have to update every place listed above.

---

## 5. Dashboards

| Dashboard | Endpoint | Reads from tabs |
|---|---|---|
| Ops Dashboard | `view=ops` (14-day rolling window; calendars cover 28 days) | Arrival Dismissal, Custodial Walkthrough, Common Space Walkthrough, Drill Log |
| Ops Dashboard: Facilities tab | Facilities script | Campus Work Orders tabs in the synthesis sheet |
| Readiness Dashboard: All tab | `view=overall` (cached 60 sec) | All Spaces, Ops Readiness Log, Readiness Daily Snapshot, Daily Wins |
| Readiness Dashboard: campus tabs | `view=boy&campus=XXX` (cached 60 sec) | All Spaces |
| Transport Dashboard | `view=transport` | Bus Trip Log, Bus Trip - Monitor Handoffs, Bus Trip - Incidents |
| Facilities Dashboard (standalone) | Facilities script; falls back to a static snapshot if the fetch fails | Synthesis sheet |

Metric definitions worth knowing:

- **Arrival vs. dismissal** is determined by timestamp: before noon is arrival, noon or later is dismissal.
- **Custodial and Common Space "Where we can improve"** shows the flag rate (% of walkthroughs where an item was flagged). Items need at least 3 observations (`MIN_CUSTODIAL_N`) to appear. "New" means there's no prior period to compare against.
- **Common Space scoring**: only "Well kept" counts as OK. "Needs improvement" and "Major issues" both count as flagged. "Skipped" counts toward neither.
- **Drill compliance** counts a month as "ok" if at least one drill of that type ran under 10 minutes.
- **Facilities definitions** are in `claude/facilities-live-data-setup.md`.

---

## 6. Back-end conventions (Ops App Apps Script)

- `doPost` routes on `payload.flow`. An unrecognized flow is silently ignored but still returns `ok`, so a renamed flow fails without any error.
- Tabs with formulas pre-filled down the sheet (Drill Log, Arrival Dismissal, Custodial Walkthrough, Ops Readiness Log, Daily Wins) are written with `findFirstEmptyRow()` on column A. Other tabs use `appendRow`. Don't switch a pre-filled tab to `appendRow`, or rows will land below the formulas.
- `ARRIVAL_ITEMS` and `WALK_SPACE_LABELS` must match the checklist labels in `index.html` exactly. Changing one without the other breaks the column mapping.
- `handleBingo` / `getBingoData` and the `bingo` endpoints are still in the script, even though Bingo has been removed from the app. They serve the Ops AI Bingo archive page until its results are frozen into the file. After that, they can be removed.
- Custodial checklist detail is stored as JSON in column G because the item set varies by walk type and campus.
- The script's header comment holds the full change log (notes 1–16). Read it before editing.

---

## 7. Known issues

1. **"Email me a copy" doesn't send.** The app posts `flow: <name>_email`, and the script has no handler for that. Staff still see "Sent — check your inbox."
2. **Technology (DOT) readiness submissions aren't saved.** This is intentional for now (see script note 6).
3. **The bus pilot is shelved, but its code is kept for future use.** Before bringing it back, fix the mismatch between app and script. The app sends `bustriplog`, `monitor-handoff`, and `bustriphandoff`. The script listens for `bus-trip`, `bus-handoff`, `bus-delay`, and `bus-liaison`. Field names differ too (for example `trip_id` vs. `tripId`, `boarded` vs. `ridersBoarded`). As written, bus submissions wouldn't be saved. The tiles also still show "Live" even though the pilot is shelved.
4. **Ops AI Bingo was retired from the app on October 1, 2026.** The contest ran September 1–21. The final cards and a reusable template for other teams live in the separate `ai-bingo` files (archive page, template, standalone Apps Script, README). The AI Bingo tab in the Ops App Log sheet is still there.

---

## 8. How to update the app

1. In the GitHub repo, open `index.html` and click the pencil icon. To replace the whole file, use **Add file → Upload files**.
2. Click **Commit changes**. The live app updates in about 60 seconds.
3. If you changed a `flow` name, payload field, or checklist label, update the Apps Script to match and deploy a new version (see section 4).

`index.html` is organized with labeled comment banners for each screen (`<!-- ══ DRILL FLOW ══ -->`) and each script section (`// ══ ... ══`).
