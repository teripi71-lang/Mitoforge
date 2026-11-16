/**
 * Phone-sized check of watch import, the overview, and a backpacking trip.
 * Every number here is made up for the test.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";
const id = "t1";

function sets(pairs) {
  return pairs.map((p, i) => ({ id: i + 1, weight: String(p[0]), reps: String(p[1]) }));
}
function lift(date, name, pairs) {
  return {
    id: "s-" + date + "-" + name,
    type: "strength",
    date,
    exercise: "Strength Circuit",
    circuitItems: [{ exercise: name, sets: sets(pairs), equipType: "weight", trackingMode: "reps" }],
    sets: [],
    isZ2: false
  };
}
const days = [
  { id: "2026-11-10", date: "2026-11-10", sleepMin: 400, deepMin: 60, lightMin: 220, remMin: 80, awakeMin: 40, bed: "22:40", wake: "05:20", restHR: 56, hrv: 42, hrvLow: 40, hrvHigh: 55, sleepScore: 74, vo2max: 40 },
  { id: "2026-11-11", date: "2026-11-11", sleepMin: 420, deepMin: 70, lightMin: 220, remMin: 90, awakeMin: 30, bed: "22:20", wake: "05:20", restHR: 54, hrv: 45, hrvLow: 40, hrvHigh: 55, sleepScore: 79, vo2max: 40 },
  { id: "2026-11-12", date: "2026-11-12", sleepMin: 440, deepMin: 80, lightMin: 230, remMin: 95, awakeMin: 25, bed: "22:10", wake: "05:30", restHR: 53, hrv: 48, hrvLow: 40, hrvHigh: 55, sleepScore: 84, vo2max: 41 }
];
const log = [
  lift("2026-10-28", "Zercher Squat", [[95, 6], [95, 6], [95, 5]]),
  lift("2026-11-04", "Zercher Squat", [[100, 6], [100, 6], [100, 6]]),
  lift("2026-11-11", "Zercher Squat", [[105, 8], [105, 8], [105, 8]]),
  lift("2026-10-28", "Barbell RDL", [[135, 6], [135, 6]]),
  lift("2026-11-11", "Barbell RDL", [[145, 6], [145, 6]]),
  lift("2026-11-11", "Split Squat", [[40, 8], [40, 8]]),
  {
    id: 501,
    type: "cardio",
    date: "2026-11-12",
    exercise: "Pack Walk",
    duration: 50,
    verticalFt: 400,
    distance: "2.5",
    distanceUnit: "mi",
    avgHR: "122",
    isZ2: true,
    notes: "Felt good on the hills",
    sets: [],
    watch: { labelId: "walk-a", sportName: "Pack Walk", durSec: 3000, avgHR: 122, start: "07:00", end: "07:50" }
  },
  {
    id: "watch:walk-a",
    type: "cardio",
    date: "2026-11-12",
    exercise: "Pack Walk",
    duration: 99,
    notes: "Added from your watch.",
    fromWatch: true,
    isZ2: true,
    sets: [],
    watch: { labelId: "walk-a", sportName: "Pack Walk", durSec: 5940, avgHR: 130 }
  },
  { id: 502, type: "cardio", date: "2026-11-17", exercise: "Recumbent Bike", duration: 40, avgHR: "120", isZ2: true, sets: [] },
  { id: 503, type: "hiit", date: "2026-11-17", exercise: "Rowing Machine", intervals: [{ peakHR: "160", recovHR: "130" }], isZ2: false, sets: [] }
];
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 40, goal: "longevity", glp1: "no", avoid: "left arm: no curls" }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_schedule_${id}`]: JSON.stringify({ __fromPlan: 2 }),
  [`mf_${id}_log`]: JSON.stringify(log),
  [`mf_${id}_watch_days`]: JSON.stringify(days),
  [`mf_${id}_watch_acts`]: JSON.stringify([
    { id: "walk-a", labelId: "walk-a", date: "2026-11-12", kind: "cardio", sportName: "Pack Walk", durSec: 3000, avgHR: 122 },
    { id: "hike-b", labelId: "hike-b", date: "2026-11-12", kind: "cardio", sportName: "Incline Walk", durSec: 2400, avgHR: 128, verticalFt: 300 }
  ]),
  [`mf_${id}_nutri_settings`]: JSON.stringify({ goalWeight: "175", proteinMultiplier: 1, goalMode: "recomp", netCarbCap: "40", setupComplete: true }),
  [`mf_${id}_nutri_log`]: JSON.stringify([
    { id: 1, date: "2026-11-16", time: "12:00", name: "Test Chicken", protein: 40, fat: 8, netCarbs: 6, calories: 280 },
    { id: 2, date: "2026-11-17", time: "18:00", name: "Test Fish", protein: 35, fat: 10, netCarbs: 8, calories: 300 },
    { id: 3, date: "2026-11-18", time: "08:00", name: "Test Eggs", protein: 20, fat: 12, netCarbs: 2, calories: 200 }
  ]),
  [`mf_${id}_body_entries`]: JSON.stringify([
    { date: "2026-11-01", weight: "190", waist: "38" },
    { date: "2026-11-08", weight: "188", waist: "37.5" }
  ])
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.clock.install({ time: new Date("2026-11-18T10:00:00") });
await page.addInitScript(data => {
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
}, seed);
await mkdir(OUT, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByTestId("watch-fresh").waitFor({ timeout: 15000 });
const fresh = await page.getByTestId("watch-fresh").innerText();
assert(/Nov 12/.test(fresh), "watch line should name the last night, got: " + fresh);
await page.getByTestId("watch-stale").waitFor();
await page.getByTestId("weigh-prompt").waitFor();
const kept = await page.evaluate(() => {
  const log = JSON.parse(localStorage.getItem("mf_t1_log"));
  const walks = log.filter(e => e.watch && e.watch.labelId === "walk-a");
  const hikes = log.filter(e => e.watch && e.watch.labelId === "hike-b");
  const again = window.mfAbsorbWatchInbox("t1");
  const log2 = JSON.parse(localStorage.getItem("mf_t1_log"));
  const daily = JSON.parse(localStorage.getItem("mf_t1_watch_daily"));
  return {
    walks: walks.length,
    notes: walks[0] && walks[0].notes,
    duration: walks[0] && walks[0].duration,
    hikes: hikes.length,
    hikeFromWatch: hikes[0] && hikes[0].fromWatch,
    second: again.changed,
    hikes2: log2.filter(e => e.watch && e.watch.labelId === "hike-b").length,
    sleep: daily["2026-11-12"] && daily["2026-11-12"].sleepMin,
    deepPct: daily["2026-11-12"] && daily["2026-11-12"].deepPct,
    hrv: daily["2026-11-12"] && daily["2026-11-12"].hrv
  };
});
assert(kept.walks === 1, "same labelId should not duplicate, got " + kept.walks);
assert(kept.notes === "Felt good on the hills", "manual notes were overwritten: " + kept.notes);
assert(kept.duration === 50, "manual duration was overwritten: " + kept.duration);
assert(kept.hikes === 1 && kept.hikeFromWatch, "unmatched watch session should be added once");
assert(kept.second === false && kept.hikes2 === 1, "second import should not add another hike");
assert(kept.sleep === 440 && kept.hrv === 48, "watch day did not land in watch_daily");
assert(kept.deepPct > 0, "deep percent should be filled from stage minutes");
await page.screenshot({ path: path.join(OUT, "b2-01-today-watch.png"), fullPage: false });

await page.getByRole("button", { name: /Insights/i }).click();
await page.getByTestId("nav-overview").click();
await page.getByTestId("progress-overview").waitFor();
await page.getByTestId("longevity-snapshot").waitFor();
await page.getByTestId("z2-week").waitFor();
await page.getByText("Zercher Squat").first().waitFor();
await page.screenshot({ path: path.join(OUT, "b2-02-overview.png"), fullPage: true });

await page.getByTestId("trip-add").click();
await page.getByTestId("trip-name").fill("Sample Ridge");
await page.getByTestId("trip-date").fill("2026-12-20");
await page.getByTestId("trip-pack").fill("30");
await page.getByTestId("trip-miles").fill("8");
await page.getByTestId("trip-elev").fill("1800");
await page.getByTestId("trip-alt").fill("8000");
await page.getByTestId("trip-save").click();
await page.getByTestId("trip-card").waitFor();
const trip = await page.getByTestId("trip-card").innerText();
assert(/Sample Ridge/.test(trip), trip);
assert(/5 lb/.test(trip) && /15 minutes/.test(trip), "build-up line missing: " + trip);
assert(!/≤ 5%|keep incline/i.test(trip), "incline warning leaked into the trip card");
await page.getByTestId("trip-card").scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(OUT, "b2-03-trip.png"), fullPage: false });

const avoid = await page.evaluate(() => JSON.parse(localStorage.getItem("mf_profiles"))[0].avoid);
assert(avoid === "left arm: no curls", avoid);
if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("batch2 mobile checks passed");
