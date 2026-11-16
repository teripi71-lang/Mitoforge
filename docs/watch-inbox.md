# Morning watch inbox

Write one JSON file into the Google Drive folder named `Mitoforge` each morning. The phone picks it up the next time Drive Sync downloads.

## File name

```
MitoForge watch YYYY-MM-DD.json
```

`YYYY-MM-DD` is the calendar day the file is about (usually yesterday). Example: `MitoForge watch 2026-11-15.json`.

The same JSON body is also accepted inside the existing `MitoForge inbox.json`. Prefer the dated watch file so a morning drop does not replace some other inbox that is still waiting.

Rewriting the same file name updates that day. It does not create a second copy. After the phone has the entries, the script renames the file to `MitoForge watch done YYYY-MM-DD <time>.json`. That needs the Apps Script in this repo deployed as a **new version** (see [drive-sync/SETUP.md](../drive-sync/SETUP.md)). Until that deploy, put the same JSON in `MitoForge inbox.json`.

## Profile id

Keys look like `mf_<profileId>_watch_days`. The profile id is the `id` on the person in `mf_profiles` inside a backup. The sample file uses `sample`. Replace it with the real id from his backup. Do not invent a second profile.

## JSON shape

```json
{
  "app": "MitoForge",
  "keys": {
    "mf_<profileId>_watch_days": [],
    "mf_<profileId>_watch_acts": [],
    "mf_<profileId>_log": []
  }
}
```

Only keys that start with `mf_` and hold a list are imported. Each object in a list needs an `id`. The same `id` on a later import updates that row. It does not add a second row.

### Daily row — `mf_<profileId>_watch_days`

One object per day. `id` and `date` are the same `YYYY-MM-DD`. The phone copies these into `mf_<profileId>_watch_daily`, which is the object the readiness and Zone 2 cards already read. A later file for the same date fills in new numbers and leaves any number you omit as it was.

| Field | Meaning |
| --- | --- |
| `id`, `date` | Day, `YYYY-MM-DD` |
| `sleepMin` | Total sleep minutes |
| `deepMin`, `lightMin`, `remMin`, `awakeMin` | Stage minutes, when the watch has them |
| `bed`, `wake` | Clock times `HH:MM` (24-hour) |
| `restHR` | Resting heart rate |
| `hrv` | Overnight HRV (ms) |
| `hrvLow`, `hrvHigh` | Optional range the readiness card already uses |
| `sleepScore` | Optional 0–100 |
| `deepPct`, `remPct` | Optional. If you send stage minutes and not these, the phone fills the percents |
| `trainingLoad` | Optional training load for that day |
| `vo2max` | Optional VO2max estimate |

A typed morning check-in is stored separately. Importing a watch day does not erase what he typed.

### Workout row — `mf_<profileId>_watch_acts` and `mf_<profileId>_log`

`labelId` is the watch's own id for that session. Use it as `id` on the activity, and as `watch.labelId` on the log entry. Use `id` `"watch:<labelId>"` on the log entry so a second import updates the same entry.

If he already logged that session himself, the phone attaches the watch block to his entry and does not replace his sets, reps, or notes. A session that came only from the watch can be refreshed. Deleting it on the phone stays deleted until a later file includes that same `labelId` again, so a morning file should only contain the new day.

Activity fields the app already stores on `entry.watch`:

`labelId`, `sport`, `sportName`, `start`, `end`, `durSec`, `distM`, `avgHR`, `maxHR`, `minHR`, `startHR`, `endHR`, `cap`, `overCapSec`, `hrMin`, `cal`.

Also send `date`, `kind` (`cardio` or `strength`), `startTs`, and `endTs` (millisecond timestamps) on the activity. Optional `verticalFt` on the log entry is used for backpacking readiness.

`kind: "cardio"` with an average heart rate at or under his usual Zone 2 cap can set `isZ2: true` on the log entry. Do not invent a cap. If you do not know it, leave `isZ2` false and he can mark Zone 2 himself.

A full example with made-up numbers is in [samples/mitoforge-watch-2026-11-15.json](samples/mitoforge-watch-2026-11-15.json).
