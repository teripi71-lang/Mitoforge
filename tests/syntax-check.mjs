/**
 * Fast safety check, no browser needed.
 * Fails if index.html or sw.js has a JavaScript syntax error, if the build
 * label is missing, or if the manifest is not valid JSON. A syntax error in
 * index.html would blank the app on a phone, so this catches the worst case.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); }
  catch (e) { failed++; console.log("FAIL  " + name + " -> " + e.message); }
}

const html = readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(m => !/src\s*=/.test(m[1]) && !/type\s*=\s*["'](?!text\/javascript|module)/.test(m[1]));

check("index.html has inline scripts", () => { if (scripts.length < 3) throw new Error("found " + scripts.length); });
scripts.forEach((m, i) => {
  check("index.html script " + (i + 1) + " compiles (" + m[2].length + " chars)", () => { new vm.Script(m[2], { filename: "index.html#" + (i + 1) }); });
});
check("build label present", () => { if (!/MF_BUILD_LABEL\s*=\s*"Build [^"]+"/.test(html)) throw new Error("MF_BUILD_LABEL not found"); });
check("sw.js compiles", () => { new vm.Script(readFileSync("sw.js", "utf8"), { filename: "sw.js" }); });
check("drive-sync/sync-client.js compiles", () => { new vm.Script(readFileSync("drive-sync/sync-client.js", "utf8"), { filename: "sync-client.js" }); });
check("manifest is valid JSON", () => { JSON.parse(readFileSync("manifest.webmanifest", "utf8")); });

console.log(failed ? "\n" + failed + " check(s) failed" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
