import test from "node:test";
import assert from "node:assert/strict";
import { extractLivestockForecast } from "../lib/collector.mjs";

test("livestock forecast maps milking cows and milk per head for 12 months", () => {
  const months = Array.from({ length: 13 }, (_, index) => ({
    forecastAt: index === 0 ? "2026-08-19" : `2026-${String(8 + index).padStart(2, "0")}-01`,
    livestockCows: {
      allLactationsTotal: 4041 - index * 10,
      total: 4446 - index * 9,
      firstLactation: { milking: 1400 },
      otherLactations: { milking: 2600 }
    },
    milkPerHead: 33 + (index % 2)
  }));
  const responses = [{
    request: { postData: { operationName: "livestockForecastMonths" } },
    body: { data: { livestockForecastMonths: months } }
  }];
  const source = {
    transfer: "mapped-12-months",
    rowLimit: 12,
    fields: {
      "Дойные, всего": "Дойные, всего",
      "Надой на голову, кг": "Надой на голову, кг"
    }
  };

  const result = extractLivestockForecast(responses, source, "2026-08-19");

  assert.equal(result.rows.length, 12);
  assert.deepEqual(result.rows[0], [4041, 33]);
  assert.deepEqual(result.rows.at(-1), [3931, 34]);
  assert.equal(result.forecastDates.length, 12);
});

test("livestock forecast maps total cows for 12 months", () => {
  const months = Array.from({ length: 12 }, (_, index) => ({
    forecastAt: `month-${index + 1}`,
    livestockCows: { total: 4446 - index * 9 }
  }));
  const responses = [{
    request: { postData: { operationName: "livestockForecastMonths" } },
    body: { data: { livestockForecastMonths: months } }
  }];
  const source = {
    transfer: "mapped-12-months",
    rowLimit: 12,
    fields: { "Коровы": "Коровы" }
  };

  const result = extractLivestockForecast(responses, source, "2026-08-19");

  assert.equal(result.rows.length, 12);
  assert.deepEqual(result.rows[0], [4446]);
  assert.deepEqual(result.rows.at(-1), [4347]);
});
