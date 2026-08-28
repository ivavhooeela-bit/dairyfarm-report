import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { writeWorkbook } from "../.artifact-work/workbook-writer.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("portable Excel writer creates a two-sheet workbook without Codex runtime", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "dairyfarm-workbook-"));
  try {
    const result = await writeWorkbook({
      rootDir,
      runDir,
      reportName: "Переносимый тест",
      farmId: 1369,
      start: "2026-08-13",
      end: "2026-08-19",
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.outputPath);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
      "Заполняет конвертор НЕ ТРОГАТЬ!",
      "HDR и PR",
    ]);
    const converter = workbook.getWorksheet("Заполняет конвертор НЕ ТРОГАТЬ!");
    assert.equal(converter.getCell("Z1").value, "13.08.2026-19.08.2026");
    assert.equal(converter.getCell("Z2").value, "Переносимый тест");
    assert.equal(converter.getCell("Z3").numFmt, "dd.mm.yyyy");
    assert.equal(workbook.getWorksheet("HDR и PR").getCell("D3").numFmt, "0%");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
