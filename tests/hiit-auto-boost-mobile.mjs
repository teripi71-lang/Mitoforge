/**
 * Phone-sized check of the HIIT boost timer with a connected heart-rate strap.
 * No real strap and no personal data. Heart-rate readings are simulated in the page.
 *
 * What it proves:
 *  1. Tapping "Start boost" waits. The hold timer does NOT start at the tap.
 *  2. The hold starts the moment the heart rate reaches the boost target (150).
 *  3. After the hold, recovery time stops when the heart rate reaches the recovery
 *     target (130), even if the next boost starts much later.
 *  4. When recovery is reached, the next boost arms by itself and starts at 150.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const id = "t1";
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_${id}_hr_settings`]: JSON.stringify({ restHR: 60, z2Low: 122, z2High: 132, boostStart: 150, recoverMode: "under", recoverUnder: 130, holdSec: 2, boosts: 3 })
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.addInitScript(data => { for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); }, seed);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(".nav-btn").filter({ hasText: /Workout|Training|Cardio|HIIT/ }).click();
await page.locator(".workout-sub-btn", { hasText: "HIIT" }).click();
await page.getByTestId("hiit-start").waitFor({ timeout: 15000 });

// Hold = 2 s for the test. A connected strap reading 125.
await page.locator("label", { hasText: "Boost Hold (sec)" }).locator("xpath=following-sibling::input").fill("2");
const hr = bpm => page.evaluate(b => window.mfHrDebug({ supported: true, status: "live", name: "Test strap", bpm: b, message: "" }), bpm);
await hr(125);

// 1. Tap: it waits, no hold timer yet.
await page.getByTestId("hiit-start").click();
await page.getByTestId("hiit-waiting").waitFor({ timeout: 4000 });
assert(await page.getByTestId("hiit-hold").count() === 0, "hold timer must not start at the tap");
await sleep(1200);
await hr(140);
await sleep(600);
assert(await page.getByTestId("hiit-hold").count() === 0, "hold timer must not start below 150");
assert(await page.evaluate(() => !!window.mfHr.armed), "should still be armed below 150");

// 2. Reaching 150 starts the hold.
await hr(151);
await page.getByTestId("hiit-hold").waitFor({ timeout: 3000 });
const t0 = await page.evaluate(() => window.mfHr.openBoost && window.mfHr.openBoost.t0);
assert(t0, "boost should be open at the crossing");
await hr(158);

// Hold ends by itself after 2 s.
await page.getByTestId("hiit-ready-top").waitFor({ timeout: 6000 });
const restT0 = await page.evaluate(() => window.mfHr.resting.restT0);
assert(Math.abs((restT0 - t0) - 2000) < 900, "hold should last about 2 s from the crossing, got " + (restT0 - t0));

// 3. Heart rate falls. Reaches 130 after about 3 s. Then the athlete waits 3 more seconds before climbing.
await sleep(1500);
await hr(140);
await sleep(1500);
await hr(129);
const readyAt = await page.evaluate(() => window.mfHr.resting.readyAt);
assert(readyAt, "ready time should be stamped when 130 is reached");
await page.getByText(/Ready . timer starts at 150 bpm/).waitFor({ timeout: 3000 });
assert(await page.evaluate(() => !!window.mfHr.armed), "next boost should arm by itself when ready");
await sleep(3000);

// 4. Reaching 150 again starts boost 2 by itself and closes boost 1 with the right recovery time.
await hr(152);
await page.getByTestId("hiit-hold").waitFor({ timeout: 3000 });
const row = await page.evaluate(() => window.mfHr.boostRows[0]);
assert(row, "boost 1 row should be recorded");
assert(row.restEndHr === 129, "recovery HR should be the reading at 130, got " + row.restEndHr);
const expected = Math.round((readyAt - restT0) / 1000);
assert(row.restSec === expected, "recovery time should stop at 130: expected " + expected + " got " + row.restSec);
assert(row.restSec <= 4, "recovery time must not include the 3 s wait or the climb back, got " + row.restSec);
assert(row.peak >= 158, "peak should be kept, got " + row.peak);

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("hiit auto boost checks passed");
