import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const presentation = JSON.parse(await fs.readFile(new URL("../config/presentation-mapping.json", import.meta.url), "utf8"));
const dairyfarm = JSON.parse(await fs.readFile(new URL("../config/1369.json", import.meta.url), "utf8"));

test("presentation mapping covers all 13 source slides", () => {
  assert.deepEqual(presentation.slides.map((slide) => slide.slide), Array.from({ length: 13 }, (_, index) => index + 1));
});

test("all mapped DairyFarm sources exist in the collector configuration", () => {
  const configured = new Set(dairyfarm.sources.map((source) => source.id));
  const mapped = new Set(presentation.slides.flatMap((slide) => [
    ...(slide.sources || []),
    ...(slide.elements || []).flatMap((element) => [
      ...(element.source ? [element.source] : []),
      ...(element.sources || []),
    ]),
  ]));
  assert.deepEqual([...mapped].filter((source) => !configured.has(source)), []);
});

test("chart-only slide uses only complete HDR/PR periods", () => {
  const slide = presentation.slides.find((item) => item.slide === 7);
  assert.equal(slide.mode, "chart-only");
  assert.equal(slide.completePeriodsOnly, true);
  assert.deepEqual(slide.elements[0].series, ["HDR", "PR", "CR"]);
});

test("ultrasound chart uses summed pregnant and open cows from pregnancy/dry-off data", () => {
  const slide = presentation.slides.find((item) => item.slide === 4);
  const chart = slide.elements.find((item) => item.tag === "{{ULTRASOUND_CHART}}");
  assert.equal(chart.source, "sheet2-events-5303");
  assert.equal(chart.chart, "pie");
  assert.equal(chart.transform, "pregnancy-status-share");
  assert.deepEqual(chart.categories, [
    { label: "Стельные", sourceColumn: "Стельная", aggregate: "sum" },
    { label: "Холостые", sourceColumn: "Нестельная", aggregate: "sum" },
  ]);
});

test("the source presentation is never mutated", () => {
  assert.equal(presentation.template.copyBeforeFill, true);
  assert.equal(presentation.template.neverMutateSource, true);
});
