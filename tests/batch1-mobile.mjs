/**
 * Phone-sized check of the gym, food, and plan changes.
 * Sample data is invented for this test only. It is not a real person's log.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts";
const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/index.html";

function sets(pairs) {
  return pairs.map((p, i) => ({ id: i + 1, weight: String(p[0]), reps: String(p[1]) }));
}
function lift(name, pairs) {
  return { exercise: name, sets: sets(pairs), equipType: "weight", trackingMode: "reps", armMode: "double" };
}
function session(date, items) {
  return {
    id: Number(date.replace(/-/g, "")),
    type: "strength",
    date,
    exercise: "Strength Circuit",
    circuitItems: items,
    sets: [],
    isZ2: false
  };
}

const id = "t1";
const oldWeek = {
  0: { type: "rest", label: "Rest Day", sub: "Recovery is training.", tab: null, icon: "😴" },
  1: { type: "cardio", label: "Zone 2", sub: "65 min incline treadmill · Target HR 118-125", tab: "cardio", icon: "🫀" },
  2: { type: "strength", label: "Strength", sub: "Press · Quads", tab: "strength", icon: "💪" },
  3: { type: "hiit", label: "HIIT Rowing", sub: "18 min", tab: "hiit", icon: "🚣" },
  4: { type: "kb", label: "Functional KB", sub: "35 min ABC", tab: "kb", icon: "🏋️" },
  5: { type: "cardio", label: "Zone 2", sub: "65 min incline treadmill · Target HR 118-125", tab: "cardio", icon: "🫀" },
  6: { type: "strength", label: "LFT", sub: "Full body", tab: "strength", icon: "💪" }
};

const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{
    id,
    name: "Alex",
    age: 40,
    goal: "strength",
    glp1: "no",
    avoid: "left arm: no curls; inner hip: avoid incline treadmill"
  }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_${id}_sched_v2`]: "1",
  [`mf_schedule_${id}`]: JSON.stringify(oldWeek),
  [`mf_${id}_log`]: JSON.stringify([
    session("2026-11-09", [
      lift("Zercher Squat", [[100, 8], [100, 8], [100, 8], [100, 8]]),
      lift("Split Squat", [[40, 8], [40, 8], [40, 7]]),
      lift("Spanish Squat", [[50, 8], [50, 8]])
    ]),
    session("2026-11-02", [
      lift("Zercher Squat", [[95, 8], [95, 8], [95, 8], [95, 6]]),
      lift("Spanish Squat", [[50, 10], [50, 10]])
    ]),
    session("2026-10-26", [
      lift("Spanish Squat", [[50, 12], [50, 12]])
    ])
  ]),
  [`mf_${id}_nutri_settings`]: JSON.stringify({
    goalWeight: "180",
    proteinMultiplier: 1,
    goalMode: "recomp",
    netCarbCap: "40",
    setupComplete: true
  }),
  [`mf_${id}_nutri_log`]: JSON.stringify([
    { id: 1, date: "2026-11-16", time: "12:00", name: "Test Chicken", serving: 1, protein: 30, fat: 3, carbs: 0, fiber: 0, netCarbs: 0, calories: 150 },
    { id: 2, date: "2026-11-15", time: "08:00", name: "Test Eggs", serving: 1, protein: 18, fat: 10, carbs: 1, fiber: 0, netCarbs: 1, calories: 170 },
    { id: 3, date: "2026-11-15", time: "19:00", name: "Test Steak", serving: 1, protein: 40, fat: 20, carbs: 0, fiber: 0, netCarbs: 0, calories: 350 }
  ])
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.clock.install({ time: new Date("2026-11-16T19:30:00") });
await page.addInitScript(data => {
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
}, seed);
await mkdir(OUT, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByTestId("plan-update").waitFor({ timeout: 15000 });
const body1 = await page.locator("body").innerText();
assert(!/keep incline|≤ 5%|<= 5%/i.test(body1), "incline cap warning is still on screen");
await page.screenshot({ path: path.join(OUT, "01-plan-prompt.png"), fullPage: true });

await page.getByTestId("plan-use-new").click();
await page.getByText("Lower A").first().waitFor();
await page.getByTestId("macro-meter").waitFor();
await page.getByTestId("protein-nudge").waitFor();
const nudge = await page.getByTestId("protein-nudge").innerText();
assert(/150 g/.test(nudge), "evening nudge should say about 150 g of protein left, got: " + nudge);
const meter = await page.getByTestId("macro-meter").innerText();
assert(/30\s*\/\s*180/.test(meter), "protein meter should show 30 / 180, got: " + meter);
assert(/0\s*\/\s*40/.test(meter), "carb meter should show 0 / 40, got: " + meter);
await page.screenshot({ path: path.join(OUT, "02-today-meter.png"), fullPage: false });

await page.getByRole("button", { name: /Start Session/i }).click();
await page.getByText("Zercher Squat").first().waitFor();
await page.getByText("Split Squat").first().waitFor();
const cues = await page.getByTestId("gym-cue").allInnerTexts();
assert(cues.some(t => /Add 5 lb/.test(t)), "Zercher should suggest +5 lb, got: " + cues.join(" | "));
assert(cues.some(t => /Keep 40 lb and aim for 8/.test(t)), "Split squat should keep the weight, got: " + cues.join(" | "));
await page.getByTestId("regress-note").first().waitFor();
const box = await page.getByTestId("w-plus").first().boundingBox();
assert(box && box.width >= 48 && box.height >= 48, "weight plus button is smaller than 48px: " + JSON.stringify(box));
const saveBox = await page.getByTestId("save-set").first().boundingBox();
assert(saveBox && saveBox.height >= 48, "save set is shorter than 48px");
await page.getByTestId("rest-90").first().waitFor();
await page.getByTestId("gym-cue").first().scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(OUT, "03-gym-lifts.png"), fullPage: false });
await page.getByRole("button", { name: "Personal records" }).click();
await page.getByText(/est\. 1RM/).first().waitFor();
await page.getByTestId("pr-list").screenshot({ path: path.join(OUT, "05b-pr-list.png") });
await page.getByPlaceholder("Search or type new exercise...").fill("Bicep Curl");
await page.getByText('Add "Bicep Curl" to list').click();
await page.getByText("On your avoid list: curls").first().waitFor();

await page.getByTestId("weight-input").nth(4).fill("40");
await page.getByTestId("save-set").nth(4).click();
await page.getByTestId("set-warn").waitFor();
await page.screenshot({ path: path.join(OUT, "04-reps-prompt.png"), fullPage: false });

await page.getByTestId("weight-input").first().fill("105");
await page.getByTestId("reps-input").first().fill("8");
await page.getByTestId("save-set").first().click();
await page.getByTestId("pr-badge").first().waitFor();
await page.getByTestId("rest-dock").waitFor();
const rest = await page.getByTestId("rest-readout").innerText();
assert(/01:/.test(rest) || /02:/.test(rest), "rest timer should be running, got " + rest);
await page.screenshot({ path: path.join(OUT, "05-pr-and-rest.png"), fullPage: false });

await page.getByRole("button", { name: /^Nutrition$/i }).click();
await page.getByTestId("macro-meter").waitFor();
await page.getByTestId("repeat-morning").click();
await page.getByText("Test Eggs").first().waitFor();
const foodMeter = await page.getByTestId("macro-meter").innerText();
assert(/48\s*\/\s*180/.test(foodMeter), "meter should update after repeating breakfast, got: " + foodMeter);
await page.screenshot({ path: path.join(OUT, "06-food-repeat.png"), fullPage: false });

await page.route("**/api.nal.usda.gov/**", route => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    foods: [{
      description: "Test Yogurt",
      brandName: "Demo",
      gtinUpc: "012345678905",
      fdcId: 99,
      householdServingFullText: "1 container",
      servingSize: 150,
      servingSizeUnit: "g",
      foodNutrients: [
        { nutrientId: 1008, value: 80 },
        { nutrientId: 1003, value: 10 },
        { nutrientId: 1004, value: 2 },
        { nutrientId: 1005, value: 8 },
        { nutrientId: 1079, value: 0 }
      ]
    }]
  })
}));
await page.getByRole("button", { name: /Log Food/i }).click();
await page.getByRole("button", { name: /Scan barcode/i }).click();
await page.getByPlaceholder("Or type barcode number").fill("012345678905");
await page.getByRole("button", { name: /^Look up$/i }).click();
await page.getByTestId("serving-desc").waitFor();
const desc = await page.getByTestId("serving-desc").innerText();
assert(/1 container/.test(desc) && /150 g/.test(desc), "serving description missing: " + desc);
const preview = await page.locator("text=Preview:").innerText();
assert(/P:\s*15g/.test(preview), "one package serving should be 15 g protein, not 10 g per 100 g. Got: " + preview);
await page.screenshot({ path: path.join(OUT, "07-serving-size.png"), fullPage: false });

await page.getByRole("button", { name: /Workout/i }).click();
await page.getByRole("button", { name: /HIIT/i }).first().click();
await page.getByTestId("hiit-peak").fill("150");
await page.getByTestId("hiit-recov").fill("170");
await page.getByTestId("hiit-distance").fill("1");
await page.getByTestId("hiit-minutes").fill("0");
await page.getByRole("button", { name: /Log HIIT/i }).click();
const hiitErr = await page.getByTestId("hiit-error").innerText();
assert(/higher than the peak/.test(hiitErr), "missing peak/recovery prompt: " + hiitErr);
assert(/under 60/.test(hiitErr) === false || /higher than the peak/.test(hiitErr));
assert(/total time is 0/.test(hiitErr), "missing zero-time prompt: " + hiitErr);
await page.screenshot({ path: path.join(OUT, "08-hiit-check.png"), fullPage: false });

const avoid = await page.evaluate(() => JSON.parse(localStorage.getItem("mf_profiles"))[0].avoid);
assert(avoid === "left arm: no curls", "old default avoid text was not softened, got: " + avoid);
assert(!/incline/.test(avoid), "avoid text still mentions incline");

if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
await browser.close();
console.log("batch1 mobile checks passed");
