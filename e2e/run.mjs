// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, add a memory on the Memory page with the real MiniLM model, and
// recall it in other words. It writes artifacts/e2e-<date>.json.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, poll, writeArtifact } from "create-foxkit/e2e";

const record = { startedAt: new Date().toISOString(), checks: [], timings: {} };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });

let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const page = await fox.openExtensionPage("memory.html");
  await poll(page, () => document.body.dataset.ready === "1", undefined, 30_000);
  let started = Date.now();
  await page.evaluate(() => {
    document.getElementById("new-text").value = "I take my coffee with oat milk and no sugar.";
    document.getElementById("add").requestSubmit();
  });
  await poll(page, () => document.body.dataset.count === "1", undefined, 180_000);
  record.timings.firstRememberWithModelLoadMs = Date.now() - started;
  const listed = await page.evaluate(() => document.querySelector("#list .text")?.textContent);
  check("the Memory page lists the new memory", listed === "I take my coffee with oat milk and no sugar.", listed);
  started = Date.now();
  await page.evaluate(() => {
    document.getElementById("query").value = "How do I like my coffee?";
    document.getElementById("recall").requestSubmit();
  });
  await poll(page, () => document.getElementById("hits").dataset.done === "1", undefined, 60_000);
  record.timings.recallMs = Date.now() - started;
  const hit = await page.evaluate(() => document.querySelector("#hits li")?.textContent);
  check("recall in other words finds it", /oat milk/.test(hit ?? ""), hit);
} catch (error) {
  record.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await fox?.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}`);
console.log(JSON.stringify(record.timings));
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
