import assert from "node:assert/strict";
import test from "node:test";
import {
  extractEventsFromResponses,
  extractHdrPrFromResponses,
  extractMilkingFromResponses
} from "../lib/collector.mjs";

function response(operationName, connectionName, node) {
  return [{
    request: { postData: [{ operationName }] },
    body: [{ data: { [connectionName]: { edges: [{ node }] } } }]
  }];
}

test("HDR/PR is extracted from the intercepted GraphQL response", () => {
  const node = {
    id: "reproductionHdrPrReport_2204",
    calculatedReport: { rows: [{ since: "2026-07-01", till: "2026-07-22", fitForInsemination: 877, inseminated: 504, hdr: 57, fitForPregnancy: 868, pregnant: 171, pr: 20, cr: 35, abortions: 0 }] }
  };
  const result = extractHdrPrFromResponses(
    response("reproductionHdrAndPrReportsDetailed", "reproductionHdrAndPrReports", node),
    { url: "/1369/user/analytics/reproduction/hdr-and-pr/reproductionHdrPrReport_2204" },
    "2026-08-19"
  );
  assert.deepEqual(result.rows[0], ["01.07.2026 – 22.07.2026", 877, 504, 57, 868, 171, 20, 35, 0]);
});

test("non-transposed event report becomes period rows and excludes total", () => {
  const node = {
    id: "customEventsReport_5303",
    settings: { isTransposed: false },
    calculatedReport: {
      groupingColumnValues: [{ dayStart: 32, dayEnd: 32 }, { dayStart: 38, dayEnd: 38 }, null],
      columns: [
        { veterinaryActivity: { name: "Нестельная" }, valuesAndTotal: [73, 30, 103] },
        { veterinaryActivity: { name: "Стельная" }, valuesAndTotal: [47, 17, 64] }
      ]
    }
  };
  const result = extractEventsFromResponses(
    response("customEventsReportsDetailed", "customEventsReports", node),
    { type: "events-report", url: "/1369/customEventsReport_5303", transfer: "all-rows-except-total" }
  );
  assert.deepEqual(result.rows, [[32, 73, 47], [38, 30, 17]]);
});

test("event extraction prefers the recalculated table returned after saving settings", () => {
  const staleNode = {
    id: "customEventsReport_7139",
    settings: { isTransposed: false },
    calculatedReport: {
      groupingColumnValues: [{ dateStart: "2026-08-01" }, null],
      columns: [{ veterinaryActivity: { name: "Отел" }, valuesAndTotal: [41, 41] }]
    }
  };
  const savedNode = {
    id: "customEventsReport_7139",
    settings: { isTransposed: false },
    calculatedReport: {
      groupingColumnValues: [{ dateStart: "2026-08-15" }, null],
      columns: [{ veterinaryActivity: { name: "Отел" }, valuesAndTotal: [9, 9] }]
    }
  };
  const responses = [
    ...response("customEventsReportsDetailed", "customEventsReports", staleNode),
    {
      request: { postData: [{ operationName: "setCustomEventsReportSettings" }] },
      body: [{ data: { setCustomEventsReportSettings: savedNode } }]
    }
  ];
  const result = extractEventsFromResponses(responses, {
    type: "events-report",
    url: "/1520/customEventsReport_7139",
    transfer: "all-rows-except-total"
  });
  assert.deepEqual(result.rows, [["2026-08-15", 9]]);
});

test("event extraction treats a recalculated empty report as a valid zero-row result", () => {
  const staleNode = {
    id: "customEventsReport_8094",
    settings: { isTransposed: false },
    calculatedReport: {
      groupingColumnValues: [{ dayStart: 32, dayEnd: 32 }, null],
      columns: [{ veterinaryActivity: { name: "Стельная" }, valuesAndTotal: [4, 4] }]
    }
  };
  const savedNode = {
    id: "customEventsReport_8094",
    settings: { isTransposed: false },
    calculatedReport: { __typename: "CustomEventsReportDataEmpty" }
  };
  const responses = [
    ...response("customEventsReportsDetailed", "customEventsReports", staleNode),
    {
      request: { postData: [{ operationName: "setCustomEventsReportSettings" }] },
      body: [{ data: { setCustomEventsReportSettings: savedNode } }]
    }
  ];
  const result = extractEventsFromResponses(responses, {
    type: "events-report",
    url: "/836/customEventsReport_8094",
    transfer: "all-rows-except-total"
  });
  assert.deepEqual(result, { columns: [], rows: [], emptyConfirmed: true });
});

test("transposed weekly event report keeps source labels and drops aggregate column", () => {
  const node = {
    id: "customEventsReport_7118",
    settings: { isTransposed: true },
    calculatedReport: {
      groupingColumnValues: [{ dowValue: "MON" }, { dowValue: "TUE" }, null],
      columns: [{ veterinaryActivity: { name: "Отел" }, valuesAndTotal: [14, 15, 29] }]
    }
  };
  const result = extractEventsFromResponses(
    response("customEventsReportsDetailed", "customEventsReports", node),
    { type: "events-report", url: "/1369/customEventsReport_7118", transfer: "all-columns-except-last" }
  );
  assert.deepEqual(result.rows, [["Отел", 14, 15]]);
});

test("milking report uses intercepted dates, heads and milk values", () => {
  const node = {
    id: "customMilkingReport_4019",
    calculatedReport: {
      xAxisLabels: { xAxisDateLabels: ["2026-08-18", "2026-08-19"] },
      yAxisDatasets: [[32.8, null]],
      yAxisCowCounts: [[3492, null]]
    }
  };
  const result = extractMilkingFromResponses(
    response("customMilkingReportsDetailed", "customMilkingReports", node),
    { url: "/1369/customMilkingReport_4019" }
  );
  assert.deepEqual(result.rows, [["2026-08-18", 3492, 32.8], ["2026-08-19", 0, 0]]);
});

test("empty recalculated milking report produces requested dates with zero values", () => {
  const staleNode = {
    id: "customMilkingReport_4426",
    calculatedReport: {
      xAxisLabels: { xAxisDateLabels: ["2026-08-09"] },
      yAxisDatasets: [[99]],
      yAxisCowCounts: [[999]]
    }
  };
  const savedNode = {
    id: "customMilkingReport_4426",
    calculatedReport: { __typename: "CustomMilkingReportChartEmpty" }
  };
  const responses = [
    ...response("customMilkingReportsDetailed", "customMilkingReports", staleNode),
    {
      request: { postData: [{ operationName: "setCustomMilkingReportSettings" }] },
      body: [{ data: { setCustomMilkingReportSettings: savedNode } }]
    }
  ];
  const result = extractMilkingFromResponses(
    responses,
    { url: "/836/customMilkingReport_4426" },
    { start: "2026-08-10", end: "2026-08-12" }
  );
  assert.deepEqual(result.rows, [
    ["2026-08-10", 0, 0],
    ["2026-08-11", 0, 0],
    ["2026-08-12", 0, 0]
  ]);
  assert.equal(result.emptyConfirmed, true);
});
