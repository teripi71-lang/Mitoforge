/**
 * Phone-sized check that a barcode food's label values can be corrected,
 * reused on the next lookup, and edited or deleted on the food log.
 * The product is invented.
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
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_${id}_nutri_settings`]: JSON.stringify({ goalWeight: 180, proteinMultiplier: 0.9, goalMode: "recomp", setupComplete: true })
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
await page.route("**/api.nal.usda.gov/**", route => route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({
    foods: [{
      description: "Test Yogurt",
      brandName: "Acme",
      gtinUpc: "012345678905",
      householdServingFullText: "1 container",
      servingSize: 150,
      servingSizeUnit: "g",
      foodNutrients: [
        { nutrientId: 1003, value: 10 },
        { nutrientId: 1004, value: 0 },
        { nutrientId: 1005, value: 12 },
        { nutrientId: 1079, value: 0 },
        { nutrientId: 1008, value: 80 }
      ]
    }]
  })
}));
await page.route("**/openfoodfacts.org/**", route => route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({ status: 0 })
}));
await page.addInitScript(data => {
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
}, seed);
await mkdir(OUT, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(".nav-btn").filter({ hasText: "Nutrition" }).click();
await page.getByText("Today's Food Log").waitFor();
await page.getByRole("button", { name: /^log food$/i }).click();
await page.getByRole("button", { name: /scan barcode/i }).click();
await page.getByPlaceholder("Or type barcode number").fill("012345678905");
await page.getByTestId("barcode-lookup").click();
await page.getByTestId("macro-protein").waitFor();
const dbProtein = await page.getByTestId("macro-protein").inputValue();
assert(dbProtein === "15", "one 150 g serving of 10 g/100 g is 15, got " + dbProtein);
await page.getByTestId("macro-protein").fill("12");
await page.getByTestId("macro-sugar").fill("2");
await page.getByTestId("macro-carbs").fill("12");
const net = await page.getByTestId("macro-net").innerText();
assert(/Net carbs 10 g/.test(net), net);
await page.getByTestId("serving-input").fill("2");
await page.getByTestId("macro-protein").waitFor();
const doubled = await page.getByTestId("macro-protein").inputValue();
assert(doubled === "24", "two servings should double the corrected protein, got " + doubled);
await page.getByTestId("food-macros-edit").screenshot({ path: path.join(OUT, "food-01-label.png") });
await page.getByRole("button", { name: /add —/i }).click();
await page.getByTestId("food-entry").waitFor();

const saved = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_food_labels`)), id);
const key = Object.keys(saved || {})[0];
assert(key === "bc:12345678905", "label key " + key);
assert(Math.round(saved[key].protein * 10) / 10 === 8, "saved per 100 g " + saved[key].protein);
const logged = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_nutri_log`)), id);
assert(logged.length === 1 && logged[0].protein === 24 && logged[0].netCarbs === 20, JSON.stringify(logged[0]));

await page.getByRole("button", { name: /^log food$/i }).click();
const scanAgain = page.getByRole("button", { name: /scan barcode/i });
if (await scanAgain.count()) await scanAgain.click();
await page.getByPlaceholder("Or type barcode number").fill("012345678905");
await page.getByTestId("barcode-lookup").click();
await page.getByTestId("label-tag").waitFor();
const tag = await page.getByTestId("label-tag").innerText();
assert(/your label values/.test(tag), tag);
const reused = await page.getByTestId("macro-protein").inputValue();
assert(reused === "12", "rescan should use the label protein per serving, got " + reused);
await page.getByTestId("label-tag").screenshot({ path: path.join(OUT, "food-02-saved.png") });
await page.getByTestId("label-revert").click();
const back = await page.getByTestId("macro-protein").inputValue();
assert(back === "15", "revert should restore the database serving, got " + back);
await page.getByRole("button", { name: /^cancel$/i }).click();

await page.getByTestId("food-entry").click();
await page.getByTestId("food-edit-protein").waitFor();
await page.getByTestId("food-edit-protein").fill("30");
const editNet = await page.getByTestId("food-edit-net").innerText();
assert(/Net carbs/.test(editNet), editNet);
await page.getByRole("button", { name: /^save$/i }).click();
await page.getByTestId("food-entry").getByText("P:30g").waitFor();

await page.getByTestId("food-entry").click();
await page.getByRole("button", { name: /^delete$/i }).click();
await page.getByTestId("delete-confirm").waitFor();
const confirm = await page.getByTestId("delete-confirm-label").innerText();
assert(/Test Yogurt/.test(confirm), confirm);
await page.getByTestId("delete-cancel").click();
assert(await page.getByTestId("food-entry").count() === 1, "cancel keeps the food");
await page.getByTestId("food-entry").click();
await page.getByRole("button", { name: /^delete$/i }).click();
await page.getByTestId("delete-confirm-yes").click();
await page.getByTestId("food-undo").waitFor();
const gone = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_nutri_log`)), id);
assert(gone.length === 0, "deleted");
await page.getByTestId("food-undo").click();
const backLog = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_nutri_log`)), id);
assert(backLog.length === 1 && backLog[0].id === logged[0].id && backLog[0].protein === 30, JSON.stringify(backLog[0]));

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("food label checks passed");
