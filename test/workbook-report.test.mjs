import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildChartDefinitions } from "../lib/google-presentations.mjs";
import { loadWorkbookReport } from "../lib/workbook-report.mjs";

const mapping = JSON.parse(await fs.readFile(new URL("../config/workbook-mapping.json", import.meta.url), "utf8"));

async function workbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const converter = workbook.addWorksheet("Заполняет конвертор НЕ ТРОГАТЬ!");
  const hdr = workbook.addWorksheet("HDR и PR");
  converter.getCell("Z2").value = "Тестовая ферма";
  converter.getCell("Z3").value = new Date("2026-08-13T00:00:00Z");
  converter.getCell("Z4").value = new Date("2026-08-19T00:00:00Z");
  converter.getCell("B2").value = 4442;
  converter.getCell("B3").value = 0.5;
  converter.getCell("B4").value = "35 %";
  hdr.getCell("A3").value = "15.06.2026 – 06.07.2026";
  hdr.getCell("B3").value = 877;
  hdr.getCell("C3").value = 504;
  hdr.getCell("D3").value = 0.57;
  hdr.getCell("E3").value = 868;
  hdr.getCell("F3").value = 171;
  hdr.getCell("G3").value = 0.2;
  hdr.getCell("H3").value = 0.35;
  hdr.getCell("I3").value = 0;
  converter.getCell("H31").value = 123;
  converter.getCell("I31").value = new Date("2026-08-14T00:00:00Z");
  converter.getCell("J31").value = 75;
  converter.getCell("S68").value = 4041;
  converter.getCell("T68").value = 33;
  converter.getCell("S69").value = 4044;
  converter.getCell("T69").value = 34;
  converter.getCell("X68").value = 4446;
  converter.getCell("A144").value = 100;
  converter.getCell("B144").value = 74;
  converter.getCell("C144").value = 2;
  converter.getCell("D144").value = "Новотельное";
  converter.getCell("E144").value = 200;
  converter.getCell("F144").value = 75;
  converter.getCell("G144").value = 3;
  converter.getCell("H144").value = "Новотельное";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("исправленный Excel восстанавливает данные презентации и служебный период", async () => {
  const imported = await loadWorkbookReport(await workbookBuffer(), mapping, { farmId: 1369 });
  assert.equal(imported.reportName, "Тестовая ферма");
  assert.equal(imported.start, "2026-08-13");
  assert.equal(imported.end, "2026-08-19");
  assert.equal(imported.report.metrics["Кол-во коров в стаде"].value, 4442);
  assert.equal(imported.report.metrics["% Стельных"].value, 50);
  assert.equal(imported.report.structured["hdr-pr"].selected[3], 57);
  assert.equal(imported.report.structured["hdr-pr"].selected[6], 20);
  assert.equal(imported.report.structured["first-insemination"].table.rows[0][1], "2026-08-14");
  assert.deepEqual(imported.report.structured["livestock-forecast-milk"].forecastDates.slice(0, 2), ["2026-08-01", "2026-09-01"]);
  assert.equal(imported.report.structured["missed-insemination"].table.rows.length, 2);
  assert.equal(buildChartDefinitions(imported.report, { start: imported.start }).length, 14);
});

test("Excel без служебных дат отклоняется до создания презентации", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Заполняет конвертор НЕ ТРОГАТЬ!");
  workbook.addWorksheet("HDR и PR");
  await assert.rejects(
    loadWorkbookReport(Buffer.from(await workbook.xlsx.writeBuffer()), mapping),
    /Z3 и Z4/
  );
});
