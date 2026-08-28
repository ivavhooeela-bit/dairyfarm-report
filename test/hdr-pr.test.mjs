import test from "node:test";
import assert from "node:assert/strict";
import { extractHdrPr } from "../lib/collector.mjs";

test("HDR/PR maps nine columns and excludes the total row", () => {
  const snapshot = {
    text: "",
    tables: [[
      ["", "Дата", "Пригодные к осемен.", "Осемен.", "Выявление (HDR)\nЦель 65 %", "Пригодные к стельности", "Стельные", "Стельность (PR)\nЦель 25 %", "Оплодотворяемость (CR)\nЦель 45 %", "Аборты", ""],
      ["", "06.08.2025 – 27.08.2025", "653", "432", "66 %", "642", "208", "32 %", "49 %", "36", ""],
      ["", "29.07.2026 – 19.08.2026", "677", "527", "78 %", "673", "0", "", "", "0", ""],
      ["", "Всего", "13 035", "8 273", "63 %", "12 800", "3 011", "24 %", "40 %", "282", ""]
    ]]
  };

  const result = extractHdrPr(snapshot, "2026-08-19");

  assert.deepEqual(result.headers.map((header) => header.split("\n")[0]), [
    "Дата",
    "Пригодные к осемен.",
    "Осемен.",
    "Выявление (HDR)",
    "Пригодные к стельности",
    "Стельные",
    "Стельность (PR)",
    "Оплодотворяемость (CR)",
    "Аборты"
  ]);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], ["06.08.2025 – 27.08.2025", "653", "432", "66 %", "642", "208", "32 %", "49 %", "36"]);
  assert.deepEqual(result.total, ["Всего", "13 035", "8 273", "63 %", "12 800", "3 011", "24 %", "40 %", "282"]);
});
