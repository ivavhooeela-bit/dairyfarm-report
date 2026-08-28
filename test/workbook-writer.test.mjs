import test from "node:test";
import assert from "node:assert/strict";
import { fitRows } from "../.artifact-work/workbook-writer.mjs";

test("переполнение диапазона обрезается и записывается в лог, а не останавливает отчёт", () => {
  const issues = [];
  const rows = Array.from({ length: 8 }, (_, index) => [index + 1, 10, 20, 30]);
  const fitted = fitRows(rows, "A79:D85", "calving-result", issues);

  assert.equal(fitted.length, 7);
  assert.deepEqual(fitted.at(-1), [7, 10, 20, 30]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "range-overflow");
  assert.deepEqual(issues[0].omittedRows, [[8, 10, 20, 30]]);
});
