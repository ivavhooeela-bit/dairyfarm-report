import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { extractEvents } from "../lib/collector.mjs";

test("weekly events copies changing labels and excludes the last aggregate column by position", () => {
  const snapshot = {
    text: "",
    tables: [[
      ["Категория", "День 1", "День 2", "День 3", "День 4", "День 5", "День 6", "День 7", "Сумма"],
      ["Новое название события", "1", "2", "3", "4", "5", "6", "7", "28"],
      ["Итоговая строка с другим текстом", "10", "20", "30", "40", "50", "60", "70", "280"]
    ]]
  };

  const result = extractEvents(snapshot, "all-columns-except-last");

  assert.equal(result.columns.length, 8);
  assert.deepEqual(result.rows, [
    ["Новое название события", "1", "2", "3", "4", "5", "6", "7"],
    ["Итоговая строка с другим текстом", "10", "20", "30", "40", "50", "60", "70"]
  ]);
});

test("event table excludes only the total row and preserves three source columns", () => {
  const snapshot = {
    text: "",
    tables: [[
      ["День с осеменения", "Нестельная", "Стельная"],
      ["32", "73", "47"],
      ["228", "0", "28"],
      ["Всего", "116", "214"]
    ]]
  };

  const result = extractEvents(snapshot, "all-rows-except-total");

  assert.equal(result.columns.length, 3);
  assert.deepEqual(result.rows, [
    ["32", "73", "47"],
    ["228", "0", "28"]
  ]);
});

test("monthly event table keeps the latest 16 periods when boundary months add extra rows", () => {
  const periods = Array.from({ length: 18 }, (_, index) => [
    `Месяц ${index + 1}`,
    String(index + 100),
    "0",
    "0",
    "0"
  ]);
  const snapshot = {
    text: "",
    tables: [[
      ["Дата начала тек.лакт", "Отел", "Падёж", "Аборт", "Продажа"],
      ...periods,
      ["Всего", "999", "0", "0", "0"]
    ]]
  };

  const result = extractEvents(snapshot, "all-rows-except-total", {
    rowSelection: "latest",
    rowLimit: 16
  });

  assert.equal(result.rows.length, 16);
  assert.equal(result.rows[0][0], "Месяц 3");
  assert.equal(result.rows.at(-1)[0], "Месяц 18");
});

test("report 5306 saves table settings and reads the table without a separate refresh", async () => {
  const farmConfig = JSON.parse(await fs.readFile(new URL("../config/1369.json", import.meta.url), "utf8"));
  const workbookMapping = JSON.parse(await fs.readFile(new URL("../config/workbook-mapping.json", import.meta.url), "utf8"));
  const source = farmConfig.sources.find((item) => item.id === "retirement-60-days-year");
  const mapping = workbookMapping.mappings.find((item) => item.sourceId === "retirement-60-days-year");

  assert.equal(source.period, "365-days-ending-user-end");
  assert.equal(source.settingsArea, "table");
  assert.equal(source.refreshAfterSettings, false);
  assert.equal(source.waitAfterSettingsMs, 8000);
  assert.equal(source.periodFailurePolicy, "use-current-table");
  assert.equal(source.rowLimit, 16);
  assert.equal(mapping.range, "A126:E141");
  assert.equal(mapping.maximumRows, 16);
});
