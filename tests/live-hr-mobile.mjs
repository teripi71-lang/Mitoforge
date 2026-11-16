/**
 * Phone-sized check of the live heart-rate card.
 * No real strap and no personal data. Bluetooth is simulated in the page.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const id = "t1";
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "left arm: no curls" }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_${id}_hr_settings`]: JSON.stringify({ restHR: 60, z2Low: 115, z2High: 132 })
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.addInitScript(data => {
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
}, seed);
await mkdir(OUT, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Workout/i }).click();
await page.getByRole("button", { name: /Training/i }).click();
await page.getByTestId("hr-unsupported").waitFor({ timeout: 15000 });
const note = await page.getByTestId("hr-unsupported").innerText();
assert(/Chrome/.test(note), note);
assert(await page.getByTestId("hr-connect").count() === 0, "connect button should be hidden without Bluetooth");

const parsed = await page.evaluate(() => {
  const u8 = v => window.mfParseHeartRate(new DataView(new Uint8Array(v).buffer));
  const live = {
    id: 1,
    type: "cardio",
    date: "2026-11-16",
    exercise: "Bike",
    duration: 30,
    notes: "easy spin",
    sets: [],
    avgHR: "122",
    isZ2: true,
    liveHr: { startedAt: Date.parse("2026-11-16T14:00:00"), endedAt: Date.parse("2026-11-16T14:30:00"), avg: 122 }
  };
  const watch = {
    id: "watch:abc",
    type: "cardio",
    date: "2026-11-16",
    exercise: "Bike",
    duration: 32,
    fromWatch: true,
    notes: "Added from your watch.",
    sets: [],
    avgHR: "124",
    peakHR: "140",
    watch: { labelId: "abc", startTs: Date.parse("2026-11-16T14:05:00"), endTs: Date.parse("2026-11-16T14:32:00"), avgHR: 124, maxHR: 140 }
  };
  const merged = window.mfCollapseOverlappingCardio([live, watch]);
  return {
    bit8: u8([0x00, 128]),
    bit16: u8([0x01, 144, 0x00]),
    flag: u8([0x00, 10]),
    high: u8([0x01, 0x2c, 0x01]),
    n: merged.log.length,
    notes: merged.log[0].notes,
    label: merged.log[0].watch && merged.log[0].watch.labelId,
    avg: merged.log[0].avgHR,
    peak: merged.log[0].peakHR,
    sets: merged.log[0].sets.length
  };
});
assert(parsed.bit8 === 128, "8-bit parse " + parsed.bit8);
assert(parsed.bit16 === 144, "16-bit parse " + parsed.bit16);
assert(parsed.flag === null, "implausible bpm should be ignored");
assert(parsed.high === null, "16-bit value over 240 should be ignored");
assert(parsed.n === 1, "overlapping watch import should merge, got " + parsed.n);
assert(parsed.notes === "easy spin", "manual notes lost");
assert(parsed.label === "abc" && parsed.peak === "140" && parsed.avg === "122", JSON.stringify(parsed));

await page.evaluate(() => {
  window.mfHrDebug({
    supported: true,
    status: "live",
    name: "Myzone MZ-3",
    bpm: 122,
    message: "",
    startedAt: Date.now()
  });
});
await page.getByTestId("hr-card").waitFor();
await page.getByTestId("hr-bpm").waitFor();
const bpm = await page.getByTestId("hr-bpm").innerText();
const zone = await page.getByTestId("hr-zone").innerText();
const device = await page.getByTestId("hr-device").innerText();
assert(bpm.trim() === "122", bpm);
assert(/Zone 2/.test(zone), zone);
assert(/Myzone MZ-3/.test(device), device);
await page.getByTestId("hr-card").screenshot({ path: path.join(OUT, "hr-01-live.png") });
await page.screenshot({ path: path.join(OUT, "hr-02-strength.png"), fullPage: false });
await page.evaluate(() => window.mfHrDebug({ status: "off", bpm: null, message: "", name: "" }));
await page.getByTestId("hr-help").waitFor();
await page.getByTestId("hr-connect").waitFor();
await page.getByTestId("hr-card").screenshot({ path: path.join(OUT, "hr-03-connect.png") });

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("live hr checks passed");
