import test from "node:test";
import assert from "node:assert/strict";
import { openCustomReportFromCatalog, tabulatePivotTable } from "../lib/collector.mjs";

const value = ({ text = null, integer = null, float = null } = {}) => ({
  intValue: integer,
  floatValue: float,
  strValue: text,
  dateValue: null
});

test("custom-report pivot excludes total and keeps the latest six months", () => {
  const months = ["2026.02", "2026.03", "2026.04", "2026.05", "2026.06", "2026.07", "2026.08"];
  const pivotTable = {
    columns: [
      { blueprintSourceField: { name: "ММГГ даты рождения" } },
      { blueprintSourceFieldValues: [value({ float: 0 }), value({ float: 1 }), null] }
    ],
    rows: [
      ...months.map((month, index) => ({
        blueprintSourceFieldValue: value({ text: month }),
        values: [value({ integer: 200 + index }), value({ integer: index }), value({ integer: 200 + index * 2 })]
      })),
      { blueprintSourceFieldValue: null, values: [value({ integer: 1400 }), value({ integer: 21 }), value({ integer: 1421 })] }
    ]
  };

  const result = tabulatePivotTable(pivotTable, {
    excludeTotal: true,
    rowSelection: "latest",
    rowLimit: 6
  });

  assert.deepEqual(result.columns.map(({ name }) => name), ["ММГГ даты рождения", "0", "1", "Итого"]);
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[0][0], "2026.03");
  assert.equal(result.rows.at(-1)[0], "2026.08");
});

test("a redirected custom report waits for its catalog link and opens it by report ID", async () => {
  const page = {
    ticks: 0,
    currentUrl: "https://www.dairyfarm.dev/617/user/analytics/custom-reports/",
    clicked: null,
    locator(selector) {
      const kind = selector.includes('a[href*=') ? "id-link" : "other";
      return {
        first() { return this; },
        filter() { return this; },
        async count() { return kind === "id-link" && page.ticks >= 2 ? 1 : 0; },
        async isVisible() { return kind === "id-link" && page.ticks >= 2; },
        async click() {
          page.clicked = kind;
          page.currentUrl = "https://www.dairyfarm.dev/617/user/analytics/custom-reports/customReport_31063/new-token";
        }
      };
    },
    getByText() {
      return {
        first() { return this; },
        async count() { return 0; },
        async isVisible() { return false; }
      };
    },
    async waitForTimeout() { this.ticks += 1; },
    url() { return this.currentUrl; }
  };

  await openCustomReportFromCatalog(page, {
    url: "/617/user/analytics/custom-reports/customReport_31063/expired-token",
    name: "Сохранность телок за полгода"
  }, [], 2000);

  assert.equal(page.clicked, "id-link");
  assert.match(page.url(), /customReport_31063\/new-token$/);
});
