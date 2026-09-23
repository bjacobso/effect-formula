import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { emptyFunctions, evaluate, memory, parseSync } from "../dist/index.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../conformance/${name}`, import.meta.url), "utf8"));
const inventory = read("openformula-1.4-inventory.json");
const corpus = read("openformula-cases.json");
const audits = read("audits.json");
const selected = process.argv.includes("--group") ? process.argv[process.argv.indexOf("--group") + 1] : "small";
const json = process.argv.includes("--json");
const order = ["small", "medium", "large"];
if (!order.includes(selected)) throw new Error(`Unknown group: ${selected}`);
const groups = inventory.groups.slice(0, order.indexOf(selected) + 1);
const obligations = groups.flatMap((group) => [
  ...group.requirements.map((item) => ({ ...item, group: group.name })),
  ...group.functions.map((item) => ({ id: `function.${item.name}`, section: item.section, group: group.name })),
]);
const obligationIds = new Set(inventory.groups.flatMap((group) => [
  ...group.requirements.map((item) => item.id),
  ...group.functions.map((item) => `function.${item.name}`),
]));
if (new Set(audits.verified).size !== audits.verified.length || audits.verified.some((id) => !obligationIds.has(id)))
  throw new Error("Audit list contains duplicate or unknown requirement IDs");
const cases = new Map();
for (const sample of corpus.cases) {
  const list = cases.get(sample.id) ?? [];
  list.push(sample);
  cases.set(sample.id, list);
}
const results = [];
for (const item of obligations) {
  const samples = cases.get(item.id) ?? [];
  if (!samples.length) {
    let state = "uncovered";
    if (item.id.startsWith("function.")) {
      const name = item.id.slice("function.".length);
      try {
        const actual = await Effect.runPromise(evaluate(parseSync(`=${name}()`)).pipe(Effect.provide(Layer.merge(memory(new Map()), emptyFunctions))));
        if (actual._tag === "Error" && actual.code === "#NAME?") state = "missing";
      } catch {
        // Presence probes do not establish semantic support.
      }
    }
    results.push({ ...item, state, cases: 0 });
    continue;
  }
  const failures = [];
  for (const sample of samples) {
    try {
      const ast = parseSync(sample.formula);
      const values = new Map(Object.entries({ ...corpus.presets?.[sample.preset ?? ""], ...sample.bindings }));
      const actual = await Effect.runPromise(evaluate(ast, { ...(sample.clock ? { clock: () => new Date(sample.clock) } : {}), ...(sample.grid ? { grid: sample.grid } : {}) }).pipe(Effect.provide(Layer.merge(memory(values), emptyFunctions))));
      const close = sample.tolerance !== undefined && actual._tag === "Number" && sample.expected._tag === "Number" && Math.abs(actual.value - sample.expected.value) <= sample.tolerance;
      if (!close && JSON.stringify(actual) !== JSON.stringify(sample.expected)) failures.push({ name: sample.name, expected: sample.expected, actual });
    } catch (cause) {
      failures.push({ name: sample.name, error: String(cause) });
    }
  }
  const state = failures.length ? "failing" : audits.verified.includes(item.id) ? "verified" : "sampled";
  results.push({ ...item, state, cases: samples.length, ...(failures.length ? { failures } : {}) });
}
const counts = Object.fromEntries(["verified", "sampled", "failing", "missing", "uncovered"].map((state) => [state, results.filter((item) => item.state === state).length]));
const report = { standard: inventory.standard, target: selected, total: results.length, counts, results };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${inventory.standard} ${selected} group: ${results.length} obligations`);
  console.log(Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" | "));
  for (const item of results.filter((item) => item.state === "failing" || item.state === "missing").slice(0, 20)) {
    console.log(`${item.state === "missing" ? "MISSING" : "FAIL"} ${item.id} (${item.section})${item.failures ? `: ${item.failures.map((failure) => failure.name).join(", ")}` : ""}`);
  }
  if (results.some((item) => item.state === "uncovered")) console.log("Run with --json for every uncovered obligation.");
}
if (counts.verified !== results.length && !process.argv.includes("--report")) process.exitCode = 1;
