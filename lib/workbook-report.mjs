import fs from "node:fs/promises";
import ExcelJS from "exceljs";

function findSheet(workbook, name) {
  const sheet = workbook.worksheets.find((item) => item.name.trim() === String(name).trim());
  if (!sheet) throw new Error(`В Excel не найден лист «${String(name).trim()}»`);
  return sheet;
}

function cellAddress(value) {
  const match = String(value).match(/^([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`Некорректный адрес ячейки ${value}`);
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function rangeBounds(range) {
  const [start, end = start] = String(range).split(":");
  return { start: cellAddress(start), end: cellAddress(end) };
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return text;
  match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return text;
}

function valueOf(cell) {
  const value = cell?.value;
  if (value instanceof Date) return isoDate(value);
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "result")) return value.result instanceof Date ? isoDate(value.result) : value.result;
    if (Object.hasOwn(value, "text")) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    return null;
  }
  return value ?? null;
}

function blank(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function readRows(sheet, range) {
  const { start, end } = rangeBounds(range);
  const rows = [];
  for (let row = start.row; row <= end.row; row += 1) {
    rows.push(Array.from({ length: end.column - start.column + 1 }, (_, offset) =>
      valueOf(sheet.getCell(row, start.column + offset))));
  }
  while (rows.length && rows.at(-1).every(blank)) rows.pop();
  return rows;
}

function percentPoints(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const points = Math.abs(value) <= 1 ? value * 100 : value;
    return Math.round(points * 1_000_000) / 1_000_000;
  }
  return value;
}

function addMonths(iso, count) {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})/);
  if (!match) return [];
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    return date.toISOString().slice(0, 10);
  });
}

function completeHdrRow(rows) {
  return [...rows].reverse().find((row) => !blank(row[3]) && !blank(row[5]) && !blank(row[6]) && !blank(row[7])) || [];
}

export async function loadWorkbookReport(input, mapping, { farmId = null, fallbackName = "Отчёт" } = {}) {
  const workbook = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) await workbook.xlsx.load(input);
  else await workbook.xlsx.readFile(input);

  for (const name of mapping.allowedSheets || []) findSheet(workbook, name);
  const metadata = mapping.reportMetadata || {};
  const metadataSheet = findSheet(workbook, metadata.sheet || "Заполняет конвертор НЕ ТРОГАТЬ!");
  const start = isoDate(valueOf(metadataSheet.getCell(metadata.startDate || "Z3")));
  const end = isoDate(valueOf(metadataSheet.getCell(metadata.endDate || "Z4")));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("В Excel не заполнены корректные даты периода в служебных ячейках Z3 и Z4");
  }
  const reportName = String(valueOf(metadataSheet.getCell(metadata.reportName || "Z2")) || fallbackName).trim() || fallbackName;
  const report = {
    farmId,
    reportName,
    period: { start, end },
    metrics: {},
    structured: {},
    sources: []
  };

  for (const item of mapping.mappings || []) {
    const sheet = findSheet(workbook, item.sheet);
    const rows = item.ranges
      ? item.ranges.flatMap((range) => readRows(sheet, range))
      : readRows(sheet, item.range);
    report.sources.push({ id: item.sourceId, importedFromWorkbook: true });
    if (item.sourceId === "monitor") {
      (item.fields || []).forEach((name, index) => {
        let value = rows[index]?.[0] ?? null;
        if (name.startsWith("%")) value = percentPoints(value);
        report.metrics[name] = { value };
      });
      report.structured[item.sourceId] = { metrics: report.metrics };
      continue;
    }
    if (item.sourceId === "hdr-pr") {
      for (const row of rows) for (const column of [3, 6, 7]) row[column] = percentPoints(row[column]);
      report.structured[item.sourceId] = { rows, selected: completeHdrRow(rows) };
      continue;
    }
    if (["first-insemination", "second-insemination", "missed-insemination", "missed-ultrasound", "missed-dry-off"].includes(item.sourceId)) {
      report.structured[item.sourceId] = { table: { rows } };
      continue;
    }
    if (item.sourceId === "youngstock-survival") {
      report.structured[item.sourceId] = { pivotTableData: { rows } };
      continue;
    }
    if (item.sourceId === "livestock-forecast-milk") {
      report.structured[item.sourceId] = { rows, forecastDates: addMonths(end, rows.length) };
      continue;
    }
    report.structured[item.sourceId] = { rows };
  }
  const forecastDates = report.structured["livestock-forecast-milk"]?.forecastDates || [];
  if (report.structured["livestock-forecast-herd"]) report.structured["livestock-forecast-herd"].forecastDates = forecastDates;
  return { report, reportName, start, end };
}

export async function validateWorkbookFile(filePath, mapping, options) {
  await fs.access(filePath);
  return loadWorkbookReport(filePath, mapping, options);
}
