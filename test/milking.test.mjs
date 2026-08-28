import test from "node:test";
import assert from "node:assert/strict";
import { extractEvents } from "../lib/collector.mjs";

test("milking report transposes 12 dates and fills empty metric values with zero", () => {
  const dates = Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(2, "0")}.08.2026`);
  const snapshot = {
    text: "",
    tables: [[
      ["Показатели", "Дата", ...Array(11).fill("")],
      [...dates, ""],
      ["Среднее из Надой на голову, кг", "30,8", "", "31,4", ...Array(9).fill("32,0")],
      ["", "2 188", "", "2 330", ...Array(9).fill("3 600")]
    ]]
  };

  const result = extractEvents(snapshot, "transpose-milking-daily");

  assert.equal(result.rows.length, 12);
  assert.deepEqual(result.rows[0], ["01.08.2026", 2188, 30.8]);
  assert.deepEqual(result.rows[1], ["02.08.2026", 0, 0]);
  assert.deepEqual(result.rows.at(-1), ["12.08.2026", 3600, 32]);
});
