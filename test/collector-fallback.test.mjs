import test from "node:test";
import assert from "node:assert/strict";

import {
  dateRangeTextMatches,
  eventsReportGroupingFieldMissing,
  settingsMutationConfirmsPeriod,
  settingsMutationError,
  shouldUseExistingTable
} from "../lib/collector.mjs";

test("visible table-settings period is accepted with different dash characters", () => {
  assert.equal(dateRangeTextMatches(
    "Период 23.08.2025 – 22.08.2026",
    "2025-08-23",
    "2026-08-22"
  ), true);
  assert.equal(dateRangeTextMatches(
    "Период 23.08.2025 - 21.08.2026",
    "2025-08-23",
    "2026-08-22"
  ), false);
});

test("current-table fallback does not refresh the report", () => {
  assert.equal(shouldUseExistingTable(
    { refreshAfterSettings: true },
    { fallbackUsed: true, fallback: "current-table", settingsSaved: false }
  ), true);
});

test("normal date selection can still refresh the report", () => {
  assert.equal(shouldUseExistingTable(
    { refreshAfterSettings: true },
    { fallbackUsed: false, settingsSaved: true }
  ), false);
});

test("a successful settings mutation confirms the period even when the dialog stays open", () => {
  const responses = [{
    request: { postData: [{ operationName: "setCustomEventsReportSettings" }] },
    body: [{
      data: {
        setCustomEventsReportSettings: {
          settings: { period: { interval: { since: "2025-08-22", till: "2026-08-21" } } }
        }
      }
    }]
  }];
  assert.equal(settingsMutationConfirmsPeriod(
    responses,
    "events-report",
    { start: "2025-08-22", end: "2026-08-21" }
  ), true);
  assert.equal(settingsMutationConfirmsPeriod(
    responses,
    "events-report",
    { start: "2025-08-23", end: "2026-08-21" }
  ), false);
});

test("an events report with an empty source-field grouping is detected", () => {
  const responses = [{
    request: { postData: [{ operationName: "customEventsReportsDetailed" }] },
    body: [{
      data: {
        customEventsReports: {
          edges: [{
            node: {
              id: "customEventsReport_7726",
              calculatedReport: { __typename: "CustomEventsReportDataEmpty" },
              settings: {
                grouping: {
                  actualGrouping: {
                    groupingKind: "SOURCE_FIELD",
                    groupingParams: { sourceField: null }
                  }
                }
              }
            }
          }]
        }
      }
    }]
  }];

  assert.equal(eventsReportGroupingFieldMissing(
    responses,
    { url: "/1563/customEventsReport_7726" }
  ), true);
});

test("a settings GraphQL error is reported with the site message", () => {
  const responses = [{
    request: { postData: [{ operationName: "setCustomEventsReportSettings" }] },
    body: [{
      errors: [{
        message: "Обратитесь в службу поддержки",
        extensions: { title: "Произошла ошибка сервера", message: "Обратитесь в службу поддержки" }
      }]
    }]
  }];

  assert.equal(
    settingsMutationError(responses, "events-report"),
    "Произошла ошибка сервера: Обратитесь в службу поддержки"
  );
});
