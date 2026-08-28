import test from "node:test";
import assert from "node:assert/strict";
import { splitRowsInHalf, tabulateBlueprint } from "../lib/collector.mjs";

test("blueprint keeps ID, event date and DIM in declared source-column order", () => {
  const blueprint = {
    dataRowColumns: [
      "Номер животного",
      "Дата 1 осеменения тек.лакт",
      "Дни доения при 1 осем тек.лакт"
    ],
    dataRowColumnKinds: ["COW_IDENTIFIER", "DATE_OF_EVENT", "DATE_MINUS_DATE"],
    rows: [{
      row: JSON.stringify({
        "Номер животного": 1479,
        "Дата 1 осеменения тек.лакт": "14.08.2026",
        "Дни доения при 1 осем тек.лакт": 75
      })
    }]
  };

  const result = tabulateBlueprint(blueprint);

  assert.deepEqual(result.columns.map(({ kind }) => kind), [
    "COW_IDENTIFIER",
    "DATE_OF_EVENT",
    "DATE_MINUS_DATE"
  ]);
  assert.deepEqual(result.rows, [[1479, "14.08.2026", 75]]);
});

test("blueprint rows split in half and an odd extra row stays in the first block", () => {
  const rows = Array.from({ length: 5 }, (_, index) => [index + 1]);
  const result = splitRowsInHalf(rows);

  assert.deepEqual(result.first, [[1], [2], [3]]);
  assert.deepEqual(result.second, [[4], [5]]);
});

test("an empty blueprint list produces two empty blocks", () => {
  assert.deepEqual(splitRowsInHalf([]), { first: [], second: [] });
});
