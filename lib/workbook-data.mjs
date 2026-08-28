function parseNumber(value) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value)
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/%$/, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
}

function dateParts(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match) return { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = text.match(/^(\d{4})\.(\d{2})$/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: 1 };
  match = text.toLocaleLowerCase("ru-RU").match(/^([а-яё]+)\.?\s+(\d{4})$/u);
  if (match) {
    const months = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    const month = months.findIndex((name) => match[1].startsWith(name));
    if (month >= 0) return { year: Number(match[2]), month: month + 1, day: 1 };
  }
  return null;
}

export function excelDate(value) {
  if (value instanceof Date) return value;
  const parts = dateParts(value);
  return parts ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day)) : value;
}

export function periodLabel(start, end) {
  const format = (iso) => {
    const [year, month, day] = iso.split("-");
    return `${day}.${month}.${year}`;
  };
  return `${format(start)}-${format(end)}`;
}

function percentNumber(value) {
  const parsed = parseNumber(value);
  return typeof parsed === "number" ? parsed / 100 : parsed;
}

function normalizeReproductionStatus(value) {
  if (typeof value !== "string") return value;
  return /новотельн/iu.test(value) ? "Новотельное" : value;
}

function typedRows(rows, { dateColumns = [], percentColumns = [], numericFrom = 1 } = {}) {
  return (rows || []).map((row) => row.map((value, index) => {
    if (dateColumns.includes(index)) return excelDate(value);
    if (percentColumns.includes(index)) return value === "" || value === null ? null : percentNumber(value);
    return index >= numericFrom ? parseNumber(value) : value;
  }));
}

function selectBlueprintColumns(structured, mapping) {
  const table = structured?.table || { columns: [], rows: [] };
  if (mapping.columnMapping?.mode === "source-order") {
    const count = mapping.columnMapping.sourceColumnCount;
    return table.rows.map((row) => row.slice(0, count));
  }
  const indexes = (mapping.columnMapping || []).map(({ sourceKind }) =>
    table.columns.findIndex((column) => column.kind === sourceKind));
  if (indexes.some((index) => index < 0) && table.rows.length) {
    throw new Error(`${mapping.sourceId}: не найдены все требуемые столбцы blueprint`);
  }
  return table.rows.map((row) => indexes.map((index) => row[index] ?? null));
}

export function sourceRows(mapping, structured) {
  switch (mapping.sourceId) {
    case "monitor":
      return mapping.fields.map((name) => {
        const item = structured?.metrics?.[name];
        if (!item) return [null];
        return [item.calculationMethod === "PERCENT" ? `${item.value} %` : item.value];
      });
    case "hdr-pr":
      return typedRows(structured?.rows, { percentColumns: [3, 6, 7] });
    case "first-insemination":
    case "second-insemination":
      return selectBlueprintColumns(structured, mapping).map((row) => [row[0], excelDate(row[1]), parseNumber(row[2])]);
    case "calving-result":
    case "calf-retirement-6-months":
    case "retirement-60-days-milking":
    case "milk-deviation":
      return typedRows(structured?.rows, { dateColumns: [0] });
    case "sheet2-events-5303":
    case "sheet2-events-5304":
      return typedRows(structured?.rows, { numericFrom: 0 });
    case "retirement-60-days-year":
      return typedRows(structured?.rows, { dateColumns: [0] });
    case "youngstock-survival":
      return typedRows(structured?.pivotTableData?.rows, { dateColumns: [0] });
    case "livestock-forecast-milk":
    case "livestock-forecast-herd":
      return typedRows(structured?.rows, { numericFrom: 0 });
    case "missed-insemination":
      return selectBlueprintColumns(structured, mapping).map((row) =>
        row.map((value, index) => index === 3 ? normalizeReproductionStatus(value) : parseNumber(value)));
    case "missed-ultrasound":
    case "missed-dry-off":
      return selectBlueprintColumns(structured, mapping).map((row) => row.map(parseNumber));
    default:
      return typedRows(structured?.rows);
  }
}

export function splitInHalf(rows) {
  const midpoint = Math.ceil(rows.length / 2);
  return [rows.slice(0, midpoint), rows.slice(midpoint)];
}

export function sanitizeReportName(value) {
  const name = String(value || "").trim();
  if (!name) throw new Error("Введите название отчёта");
  return name.replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 100) || "Отчёт";
}
