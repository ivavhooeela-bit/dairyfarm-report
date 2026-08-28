import assert from "node:assert/strict";
import test from "node:test";
import { buildChartDefinitions, createGooglePresentation, fitChartDefinitionsToPlaceholders, slide12Values, survivalFillHex } from "../lib/google-presentations.mjs";
import { chartSpec, REDESIGN_PALETTE } from "../lib/google-chart-workspace.mjs";

const objectIds = {
  cover: { title: "cover-title", subtitle: "cover-subtitle" },
  kpi: {
    period: "period",
    values: {
      dnb: "dnb", milk: "milk", cows: "cows", heifers: "heifers", pregnant: "pregnant",
      cr: "cr", hdr: "hdr", pr: "pr", earlyCull: "early", youngstockSurvival: "young", cullRate: "cull", dim: "dim"
    }
  }
};

const report = {
  metrics: {
    "Кол-во коров в стаде": { value: 4444 }, "% Стельных": { value: 49 }, "% Первотелок": { value: 35 },
    "Кол-во БРАК коровы": { value: 395 }, "Средний надой ДЗ": { value: 32 },
    "Средние дни в доении (без сух.)": { value: 190.4 }, "% Брака коровы": { value: 9 }
  },
  structured: {
    "hdr-pr": { selected: ["period", "848", "486", "57%", "834", "157", "19%", "34%", "0"] },
    "retirement-60-days-year": { rows: [["авг", "100", "2", "1", "7"]] },
    "youngstock-survival": { pivotTableData: { rows: [["2026.08", 98, 2, 100]] } }
  }
};

test("builds values for KPI slide from collected DairyFarm data", () => {
  const values = slide12Values(report, { reportName: "Рогожино", baseName: "Рогожино", start: "2026-08-17", end: "2026-08-23" });
  assert.equal(values.cows, "4 444");
  assert.equal(values.milk, "32");
  assert.equal(values.hdr, "57%");
  assert.equal(values.earlyCull, "10%");
  assert.equal(values.youngstockSurvival, "98%");
  assert.equal(values.period, "17.08.2026-23.08.2026");
});

test("copies the source deck before updating only the copied presentation", async () => {
  const calls = [];
  const text = (content) => ({ shape: { text: { textElements: [{ textRun: { content: `${content}\n` } }] } } });
  const elements = [
    { objectId: "cover-title", ...text("ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ARKA") },
    { objectId: "cover-subtitle", ...text("Показатели и комментарии\nАлан Татарстан") },
    { objectId: "period", ...text("ЕЖЕНЕДЕЛЬНЫЙ ОТЧЕТ\n26.07.2026-01.08.2026") },
    ...Object.entries(objectIds.kpi.values).map(([key, objectId]) => ({ objectId, ...text(`0\n${key}`) }))
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    if (url.includes("/copy?")) return { ok: true, json: async () => ({ id: "copy-id", name: "copy", webViewLink: "https://example/copy" }) };
    if (url.endsWith(":batchUpdate")) return { ok: true, json: async () => ({ replies: [] }) };
    return { ok: true, json: async () => ({ slides: [{ objectId: "p1", pageElements: elements }] }) };
  };
  const result = await createGooglePresentation({
    accessToken: "token",
    mapping: { template: { presentationId: "source-id" }, nativeGoogleSlides: { controlSlides: objectIds } },
    report,
    reportName: "Рогожино",
    baseName: "Рогожино",
    farmId: 1369,
    start: "2026-08-17",
    end: "2026-08-23",
    fetchImpl
  });
  assert.equal(result.presentationId, "copy-id");
  assert.match(calls[0].url, /source-id\/copy/);
  assert.ok(calls.at(-1).url.includes("copy-id:batchUpdate"));
  assert.equal(calls.some((call) => call.url.includes("source-id:batchUpdate")), false);
  assert.ok(calls.at(-1).body.requests.length > 20);
});

test("Google charts use the redesign palette, labels and top legend", () => {
  const spec = chartSpec({
    title: "Сохранность телок",
    type: "COMBO",
    headers: ["Месяц", "Рождено", "Живых", "% Сохранности"],
    values: [["Месяц", "Рождено", "Живых", "% Сохранности"], ["авг.26", 49, 47, 96]],
    colors: [REDESIGN_PALETTE.navy, REDESIGN_PALETTE.green, REDESIGN_PALETTE.yellow],
    labelColors: [REDESIGN_PALETTE.white, REDESIGN_PALETTE.white, REDESIGN_PALETTE.black],
    labelPlacements: ["INSIDE_BASE", "INSIDE_BASE", "ABOVE"],
    seriesTypes: ["COLUMN", "COLUMN", "LINE"],
    secondary: [3],
    rightMin: 90,
    rightMax: 100
  }, 1000);
  assert.equal(spec.fontName, "Arial");
  assert.equal(spec.titleTextPosition.horizontalAlignment, "CENTER");
  assert.equal(spec.basicChart.legendPosition, "TOP_LEGEND");
  assert.equal(spec.basicChart.series[0].dataLabel.placement, "INSIDE_BASE");
  assert.equal(spec.basicChart.series[2].type, "LINE");
  assert.equal(spec.basicChart.series[2].pointStyle.shape, "CIRCLE");
  assert.equal(spec.basicChart.axis[2].viewWindowOptions.viewWindowMin, 90);
});

test("ultrasound pie labels contain percentages and the user period start", () => {
  const definitions = buildChartDefinitions({
    period: { start: "2026-08-17", end: "2026-08-23" },
    structured: { "sheet2-events-5303": { rows: [[32, 35, 65]] } }
  });
  const ultrasound = definitions.find((item) => item.key === "s4_ultrasound");
  assert.equal(ultrasound.title, "Проверка УЗИ с: 17.08.26");
  assert.deepEqual(ultrasound.values.slice(1), [["Стельные\n65%", 65], ["Холостые\n35%", 35]]);
  const spec = chartSpec(ultrasound, 1000);
  assert.equal(spec.pieChart.legendPosition, "LABELED_LEGEND");
});

test("survival table fill uses the 90 and 80 percent thresholds", () => {
  assert.equal(survivalFillHex(95), "#DAE0FF");
  assert.equal(survivalFillHex(90), "#DAE0FF");
  assert.equal(survivalFillHex(89), "#FCC51E");
  assert.equal(survivalFillHex(80), "#FCC51E");
  assert.equal(survivalFillHex(79), "#D26868");
});

test("cow survival matches event columns by name when DairyFarm changes their order", () => {
  const definitions = buildChartDefinitions({
    structured: {
      "retirement-60-days-year": {
        columns: [
          { name: "Период" },
          { name: "Падёж" },
          { name: "Продажа" },
          { name: "Отёл" },
          { name: "Аборт" }
        ],
        rows: [["2026-09-01", 1, 2, 41, 1]]
      }
    }
  });
  const chart = definitions.find((item) => item.key === "s5_cow_survival");
  assert.deepEqual(chart.values[1], ["сент. 26", 41, 4, 90]);
});

test("youngstock survival uses category 1 as alive instead of the larger category", () => {
  const source = {
    pivotTableData: {
      columns: [{ name: "Месяц" }, { name: "0" }, { name: "1" }, { name: "Итого" }],
      rows: [["2026.08", 8, 2, 10]]
    }
  };
  const values = slide12Values({
    metrics: {},
    structured: { "youngstock-survival": source }
  }, { baseName: "Тест", start: "2026-08-15", end: "2026-08-21" });
  assert.equal(values.youngstockSurvival, "20%");

  const chart = buildChartDefinitions({ structured: { "youngstock-survival": source } })
    .find((item) => item.key === "s6_youngstock");
  assert.deepEqual(chart.values[1], ["авг. 26", 10, 2, 20]);
});

test("insemination chart stays scatter but gets redesign markers and labels", () => {
  const spec = chartSpec({
    title: "1-е осеменение",
    type: "SCATTER",
    headers: ["Дата", "DIMFB"],
    values: [["Дата", "DIMFB"], ["2026-08-14", 75]],
    colors: [REDESIGN_PALETTE.navy],
    pointSizes: [9],
    legendPosition: "NO_LEGEND"
  }, 1001);
  assert.equal(spec.basicChart.chartType, "SCATTER");
  assert.equal(spec.basicChart.series[0].lineStyle.type, "INVISIBLE");
  assert.equal(spec.basicChart.series[0].pointStyle.size, 9);
  assert.equal(spec.basicChart.series[0].dataLabel.placement, "ABOVE");
});

test("column labels can be hidden per series while line labels stay visible", () => {
  const spec = chartSpec({
    title: "Mixed chart",
    type: "COMBO",
    headers: ["Month", "Heads", "Survival"],
    values: [["Month", "Heads", "Survival"], ["Aug", 27, 100]],
    seriesTypes: ["COLUMN", "LINE"],
    seriesDataLabels: [false, true],
    secondary: [2],
    rightMax: 100
  }, 1002);
  assert.equal(spec.basicChart.series[0].dataLabel.type, "NONE");
  assert.equal(spec.basicChart.series[1].dataLabel.type, "DATA");
  assert.equal(spec.basicChart.axis[2].viewWindowOptions.viewWindowMax, 100);
});

test("chart workspace dimensions follow each slide placeholder aspect ratio", () => {
  const definitions = [
    { key: "square", type: "COLUMN" },
    { key: "io", type: "SCATTER" }
  ];
  const fullDeck = { charts: {
    square: { placeholderObjectId: "square-frame" },
    io: { placeholderObjectId: "io-frame" }
  } };
  const element = (width, height) => ({
    size: { width: { magnitude: width, unit: "PT" }, height: { magnitude: height, unit: "PT" } },
    transform: { unit: "PT", scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }
  });
  const fitted = fitChartDefinitionsToPlaceholders(definitions, fullDeck, new Map([
    ["square-frame", element(300, 300)],
    ["io-frame", element(360, 240)]
  ]));
  assert.equal(fitted[0].widthPixels, fitted[0].heightPixels);
  assert.equal(fitted[1].widthPixels / fitted[1].heightPixels, 1.5);
  assert.equal(fitted[1].type, "SCATTER");
});
