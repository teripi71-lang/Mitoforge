/**
 * Phone-sized check that one logged workout can be deleted and undone.
 * The sample log is invented. Two matching rides plus one with no id.
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
const ride = (extra) => ({
  type: "cardio",
  date: "2026-11-16",
  exercise: "Recumbent Bike",
  duration: 30,
  sets: [],
  ...extra
});
const seedLog = [ride({ id: 1001, notes: "first" }), ride({ id: 1002, notes: "second" }), ride({ notes: "no id" })];
const seed = {
  mf_onboarding_complete: "complete",
  mf_interface_mode: "advanced",
  mf_profiles: JSON.stringify([{ id, name: "Alex", age: 55, goal: "longevity", glp1: "no", avoid: "" }]),
  mf_active_profile: JSON.stringify(id),
  [`mf_${id}_log`]: JSON.stringify(seedLog)
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

const unit = await page.evaluate(() => {
  const a = { id: 7, exercise: "Recumbent Bike" };
  const b = { id: 7, exercise: "Recumbent Bike" };
  const c = { exercise: "Recumbent Bike" };
  const log = [a, b, c];
  const one = window.mfRemoveOneLogEntry(log, b);
  const none = window.mfRemoveOneLogEntry(log, { exercise: "Recumbent Bike" });
  const byId = window.mfRemoveOneLogEntry([{ id: 3 }, { id: 4 }], { id: 4 });
  return {
    label: window.mfWorkoutDeleteLabel({ exercise: "Recumbent Bike", date: "2026-11-16", duration: 30 }),
    left: one.next.map(e => e.id == null ? "none" : e.id),
    removedId: one.removed.id,
    index: one.index,
    none: none,
    byId: byId.next.map(e => e.id)
  };
});
assert(unit.label === "Recumbent Bike · Nov 16 · 30 min", unit.label);
assert(unit.index === 1 && unit.removedId === 7, JSON.stringify(unit));
assert(unit.left.join(",") === "7,none", "same id must remove only the tapped entry " + unit.left.join(","));
assert(unit.none === null, "a copy with no id must not delete a different object");
assert(unit.byId.join(",") === "3", "id match removes one");

await page.locator(".nav-btn").filter({ hasText: "Insights" }).click();
await page.locator(".workout-sub-btn", { hasText: "Log" }).click();
await page.getByTestId("log-entry").first().waitFor();
assert(await page.getByTestId("log-entry").count() === 3, "expected both rides and the id-less entry");
await page.getByTestId("log-delete").first().scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(OUT, "del-01-log.png") });

await page.getByTestId("log-delete").first().click();
await page.getByTestId("delete-confirm").waitFor();
const label = await page.getByTestId("delete-confirm-label").innerText();
assert(label === "Recumbent Bike · Nov 16 · 30 min", label);
await page.getByTestId("delete-confirm").screenshot({ path: path.join(OUT, "del-02-confirm.png") });
await page.getByTestId("delete-cancel").click();
assert(await page.getByTestId("log-entry").count() === 3, "cancel keeps the workout");

await page.getByTestId("log-delete").first().click();
await page.getByTestId("delete-confirm-yes").click();
await page.getByTestId("undo-delete").waitFor();
await page.waitForTimeout(1500);
assert(await page.getByTestId("undo-delete").count() === 1, "undo stays up well past a short toast");
await page.getByTestId("toast").screenshot({ path: path.join(OUT, "del-03-undo.png") });
const after = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_log`)), id);
assert(after.length === 2, "one entry removed, got " + after.length);
assert(after[0].id === 1002 && after[0].notes === "second", JSON.stringify(after[0]));
assert(after[1].id == null && after[1].notes === "no id", JSON.stringify(after[1]));

await page.getByTestId("undo-delete").click();
await page.getByTestId("log-entry").nth(2).waitFor();
const restored = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_log`)), id);
assert(restored.length === 3, "undo restores the entry");
assert(restored[0].id === 1001 && restored[0].notes === "first", "same id and position " + JSON.stringify(restored.map(e => e.id)));
assert(restored[1].id === 1002 && restored[2].notes === "no id", JSON.stringify(restored));

await page.getByTestId("log-delete").nth(2).click();
await page.getByTestId("delete-confirm-yes").click();
await page.getByTestId("undo-delete").waitFor();
const noIdGone = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_log`)), id);
assert(noIdGone.length === 2 && noIdGone[0].id === 1001 && noIdGone[1].id === 1002, JSON.stringify(noIdGone));
await page.getByTestId("undo-delete").click();

await page.getByTestId("log-entry").first().getByRole("button", { name: "✎ Edit" }).click();
await page.getByTestId("edit-delete").click();
await page.getByTestId("delete-confirm-label").waitFor();
await page.getByTestId("delete-cancel").click();

await page.locator(".nav-btn").filter({ hasText: "Today" }).click();
await page.getByTestId("today-delete").scrollIntoViewIfNeeded();
await page.getByTestId("today-delete").click();
await page.getByTestId("delete-confirm-yes").click();
await page.getByTestId("undo-delete").waitFor();
const fromToday = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_log`)), id);
assert(fromToday.length === 2 && fromToday[0].id === 1002, "today delete removes only the shown workout " + JSON.stringify(fromToday.map(e => e.id)));
await page.getByTestId("undo-delete").click();
const todayBack = await page.evaluate(pid => JSON.parse(localStorage.getItem(`mf_${pid}_log`)), id);
assert(todayBack[0].id === 1001 && todayBack.length === 3, JSON.stringify(todayBack.map(e => e.id)));

if (errors.length) throw new Error(errors.join("\n"));
await browser.close();
console.log("delete workout checks passed");
