import test from "node:test";
import assert from "node:assert/strict";
import { periodLabel, sanitizeReportName, sourceRows, splitInHalf } from "../lib/workbook-data.mjs";

test("служебный период записывается в привычном русском формате", () => {
  assert.equal(periodLabel("2026-08-10", "2026-08-16"), "10.08.2026-16.08.2026");
});

test("название отчёта очищается только от запрещённых в имени файла символов", () => {
  assert.equal(sanitizeReportName("  Отчёт: ферма/1  "), "Отчёт- ферма-1");
});

test("показатели монитора сохраняют проценты как в шаблоне", () => {
  const mapping = { sourceId: "monitor", fields: ["Коров", "% Стельных"] };
  const structured = { metrics: {
    "Коров": { value: 4442, calculationMethod: "TOTAL" },
    "% Стельных": { value: 50, calculationMethod: "PERCENT" },
  } };
  assert.deepEqual(sourceRows(mapping, structured), [[4442], ["50 %"]]);
});

test("HDR/PR переводит проценты в числовые доли Excel", () => {
  const rows = sourceRows({ sourceId: "hdr-pr" }, { rows: [["01.01.2026 – 22.01.2026", "100", "60", "60 %", "90", "20", "22 %", "37 %", "1"]] });
  assert.deepEqual(rows[0].slice(1), [100, 60, 0.6, 90, 20, 0.22, 0.37, 1]);
});

test("нечётный список делится пополам с лишней строкой в первом блоке", () => {
  assert.deepEqual(splitInHalf([[1], [2], [3]]), [[[1], [2]], [[3]]]);
});

test("репро-статус пропущенных с ИО сокращается до «Новотельное»", () => {
  const mapping = {
    sourceId: "missed-insemination",
    columnMapping: [
      { sourceKind: "COW_IDENTIFIER" },
      { sourceKind: "DAYS_IN_MILK" },
      { sourceKind: "CURRENT_LACTATION" },
      { sourceKind: "COW_STATE" }
    ]
  };
  const structured = {
    table: {
      columns: [
        { kind: "COW_IDENTIFIER" },
        { kind: "DAYS_IN_MILK" },
        { kind: "CURRENT_LACTATION" },
        { kind: "COW_STATE" }
      ],
      rows: [
        ["17734", "74", "3", "Новотельное животное"],
        ["70681", "75", "8", "Стельное животное"]
      ]
    }
  };

  assert.deepEqual(sourceRows(mapping, structured), [
    [17734, 74, 3, "Новотельное"],
    [70681, 75, 8, "Стельное животное"]
  ]);
});
