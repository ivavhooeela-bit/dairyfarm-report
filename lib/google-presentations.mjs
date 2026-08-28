import fs from "node:fs/promises";
import path from "node:path";
import { createChartWorkspace, REDESIGN_PALETTE, trashChartWorkspace } from "./google-chart-workspace.mjs";

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[\s\u00a0\u202f%]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

const SURVIVAL_FILL = Object.freeze({
  normal: "#DAE0FF",
  warning: "#FCC51E",
  danger: "#D26868"
});

export function survivalFillHex(value) {
  const parsed = number(value);
  if (parsed !== null && parsed < 80) return SURVIVAL_FILL.danger;
  if (parsed !== null && parsed < 90) return SURVIVAL_FILL.warning;
  return SURVIVAL_FILL.normal;
}

function rgbColor(hex) {
  const value = hex.replace("#", "");
  return {
    red: parseInt(value.slice(0, 2), 16) / 255,
    green: parseInt(value.slice(2, 4), 16) / 255,
    blue: parseInt(value.slice(4, 6), 16) / 255
  };
}

function integer(value) {
  const parsed = number(value);
  return parsed === null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(parsed));
}

function decimal(value) {
  const parsed = number(value);
  return parsed === null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(parsed);
}

function percent(value) {
  const parsed = number(value);
  return parsed === null ? "—" : `${Math.round(parsed)}%`;
}

function metric(report, name) {
  return report.metrics?.[name]?.value ?? null;
}

function source(report, id) {
  return report.structured?.[id] || null;
}

function rows(report, id) {
  return source(report, id)?.rows || [];
}

function normalizeColumnName(value) {
  return String(value?.name ?? value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, "");
}

function eventColumnIndex(structured, aliases, fallbackIndex) {
  if (!Array.isArray(structured?.columns) || !structured.columns.length) return fallbackIndex;
  const wanted = aliases.map(normalizeColumnName);
  return structured.columns.findIndex((column) => {
    const actual = normalizeColumnName(column);
    return wanted.some((alias) => actual === alias || actual.includes(alias));
  });
}

function cowSurvivalColumnIndexes(structured) {
  const hasNamedColumns = Array.isArray(structured?.columns) && structured.columns.length > 0;
  const calvings = eventColumnIndex(structured, ["Отёл", "Число отёлов"], 1);
  const aggregateRetirement = eventColumnIndex(structured, ["Выбытие", "Выбыло"], -1);
  const retired = aggregateRetirement >= 0
    ? [aggregateRetirement]
    : [
        eventColumnIndex(structured, ["Падёж"], hasNamedColumns ? -1 : 2),
        eventColumnIndex(structured, ["Аборт"], hasNamedColumns ? -1 : 3),
        eventColumnIndex(structured, ["Продажа"], hasNamedColumns ? -1 : 4)
      ].filter((index) => index >= 0);
  return { calvings, retired: [...new Set(retired.filter((index) => index !== calvings))] };
}

function cowSurvivalValues(structured, row) {
  const indexes = cowSurvivalColumnIndexes(structured);
  const calvings = indexes.calvings >= 0 ? number(row[indexes.calvings]) || 0 : 0;
  const retired = indexes.retired.reduce((sum, index) => sum + (number(row[index]) || 0), 0);
  return { calvings, retired };
}

function blueprintRows(report, id, count) {
  return (source(report, id)?.table?.rows || []).map((row) => row.slice(0, count));
}

function retirementRate(structured) {
  let calvings = 0;
  let retired = 0;
  for (const row of structured?.rows || []) {
    const values = cowSurvivalValues(structured, row);
    calvings += values.calvings;
    retired += values.retired;
  }
  return calvings > 0 ? retired / calvings * 100 : null;
}

function youngstockColumnIndexes(structured) {
  const columns = structured?.pivotTableData?.columns || [];
  const names = columns.map(normalizeColumnName);
  const alive = names.indexOf("1");
  const total = names.indexOf(normalizeColumnName("Итого"));
  return {
    alive: alive >= 0 ? alive : null,
    total: total >= 0 ? total : null
  };
}

function youngstockRowValues(structured, row) {
  const indexes = youngstockColumnIndexes(structured);
  const alive = indexes.alive === null
    ? Math.max(number(row[1]) || 0, number(row[2]) || 0)
    : number(row[indexes.alive]) || 0;
  const total = indexes.total === null ? number(row.at(-1)) || 0 : number(row[indexes.total]) || 0;
  return { alive, total };
}

function youngstockSurvival(structured) {
  let alive = 0;
  let total = 0;
  for (const row of structured?.pivotTableData?.rows || []) {
    const values = youngstockRowValues(structured, row);
    alive += values.alive;
    total += values.total;
  }
  return total > 0 ? alive / total * 100 : null;
}

function isoPeriod(start, end) {
  const format = (value) => String(value).split("-").reverse().join(".");
  return `${format(start)}-${format(end)}`;
}

function normalizeStatus(value) {
  return typeof value === "string" && /новотельн/iu.test(value) ? "Новотельное" : value;
}

function dateLabel(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value ?? "");
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))))
    .replace(".", "");
}

function shortNumericDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1].slice(-2)}` : "";
}

function monthLabel(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})[.-](\d{2})/);
  if (!match) return text;
  return new Intl.DateTimeFormat("ru-RU", { month: "short", year: "2-digit" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)))
    .replace(/\s*г\.?$/u, "");
}

function shortHdrPeriod(value) {
  const matches = String(value || "").match(/(\d{2})\.(\d{2})\.\d{4}/g) || [];
  return matches.map((item) => item.slice(0, 5)).join("–") || String(value || "");
}

export function slide12Values(report, { baseName, start, end }) {
  const selected = source(report, "hdr-pr")?.selected || [];
  return {
    coverTitle: `ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ARKA ${baseName}`,
    period: isoPeriod(start, end),
    cows: integer(metric(report, "Кол-во коров в стаде")),
    pregnant: percent(metric(report, "% Стельных")),
    heifers: percent(metric(report, "% Первотелок")),
    dnb: integer(metric(report, "Кол-во БРАК коровы")),
    milk: decimal(metric(report, "Средний надой ДЗ")),
    dim: integer(metric(report, "Средние дни в доении (без сух.)")),
    hdr: percent(selected[3]),
    pr: percent(selected[6]),
    cr: percent(selected[7]),
    earlyCull: percent(retirementRate(source(report, "retirement-60-days-year"))),
    youngstockSurvival: percent(youngstockSurvival(source(report, "youngstock-survival"))),
    cullRate: percent(metric(report, "% Брака коровы"))
  };
}

export async function loadCollectedReport(runDir) {
  const report = JSON.parse(await fs.readFile(path.join(runDir, "report-data.json"), "utf8"));
  report.structured = {};
  for (const item of report.sources || []) {
    if (!item.file) continue;
    try {
      const snapshot = JSON.parse(await fs.readFile(path.join(runDir, item.file), "utf8"));
      report.structured[item.id] = snapshot.structured || null;
    } catch {
      report.structured[item.id] = null;
    }
  }
  return report;
}

function visibleText(text) {
  return String(text || "").endsWith("\n") ? String(text).slice(0, -1) : String(text || "");
}

function styleFields(style) {
  const allowed = ["bold", "italic", "underline", "strikethrough", "smallCaps", "fontFamily", "fontSize", "foregroundColor", "backgroundColor", "baselineOffset", "weightedFontFamily"];
  return allowed.filter((key) => style?.[key] !== undefined);
}

function updateStyleRequest(objectId, startIndex, endIndex, style) {
  const fields = styleFields(style);
  if (!fields.length || endIndex <= startIndex) return null;
  return {
    updateTextStyle: {
      objectId,
      textRange: { type: "FIXED_RANGE", startIndex, endIndex },
      style: Object.fromEntries(fields.map((key) => [key, style[key]])),
      fields: fields.join(",")
    }
  };
}

function replaceWholeText(objectId, info, replacement) {
  const length = visibleText(info.text).length;
  const requests = [];
  if (length) requests.push({ deleteText: { objectId, textRange: { type: "FIXED_RANGE", startIndex: 0, endIndex: length } } });
  requests.push({ insertText: { objectId, insertionIndex: 0, text: replacement } });
  const styleRequest = updateStyleRequest(objectId, 0, replacement.length, info.firstStyle);
  if (styleRequest) requests.push(styleRequest);
  return requests;
}

function replaceLine(objectId, info, lineIndex, replacement) {
  const text = visibleText(info.text);
  const lines = text.split("\n");
  if (lineIndex >= lines.length) throw new Error(`В объекте ${objectId} отсутствует строка ${lineIndex + 1}`);
  const start = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0);
  const end = start + lines[lineIndex].length;
  const requests = [];
  if (end > start) requests.push({ deleteText: { objectId, textRange: { type: "FIXED_RANGE", startIndex: start, endIndex: end } } });
  requests.push({ insertText: { objectId, insertionIndex: start, text: replacement } });
  const styleRequest = updateStyleRequest(objectId, start, start + replacement.length, info.styleAt(start));
  if (styleRequest) requests.push(styleRequest);
  return requests;
}

function appendAfterTemplateText(objectId, info, templateText, suffix) {
  const current = visibleText(info.text);
  const replacement = `${templateText} ${suffix}`.trim();
  if (current === replacement) return [];
  if (current === templateText) return [{ insertText: { objectId, insertionIndex: current.length, text: ` ${suffix}` } }];
  return replaceWholeText(objectId, info, replacement);
}

async function googleJson(fetchImpl, url, accessToken, options = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json();
    if (response.ok) return data;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(data?.error?.message || `Google API вернул ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1) ** 2));
  }
}

function walkElements(elements, visit) {
  for (const element of elements || []) {
    visit(element);
    walkElements(element.elementGroup?.children, visit);
  }
}

function elementIndex(presentation) {
  const result = new Map();
  for (const slide of presentation.slides || []) walkElements(slide.pageElements, (element) => result.set(element.objectId, element));
  return result;
}

function textInfo(element) {
  const elements = element?.shape?.text?.textElements || [];
  const text = elements.map((item) => item.textRun?.content || "").join("");
  const runs = elements.filter((item) => item.textRun).map((item) => ({
    startIndex: item.startIndex ?? 0,
    endIndex: item.endIndex ?? 0,
    style: item.textRun.style || {}
  }));
  return {
    text,
    firstStyle: runs[0]?.style || {},
    styleAt(index) {
      return runs.find((run) => run.startIndex <= index && run.endIndex > index)?.style || runs[0]?.style || {};
    }
  };
}

function cellHasText(table, rowIndex, columnIndex) {
  const textElements = table?.tableRows?.[rowIndex]?.tableCells?.[columnIndex]?.text?.textElements || [];
  return visibleText(textElements.map((item) => item.textRun?.content || "").join("")).length > 0;
}

function tableCellRequests(objectId, table, dataRows, { startRow = 1 } = {}) {
  const requests = [];
  const maxRows = Math.max(0, (table?.rows || 0) - startRow);
  const maxColumns = table?.columns || 0;
  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const values = dataRows[rowIndex] || [];
    for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
      const cellLocation = { rowIndex: startRow + rowIndex, columnIndex };
      if (cellHasText(table, startRow + rowIndex, columnIndex)) {
        requests.push({ deleteText: { objectId, cellLocation, textRange: { type: "ALL" } } });
      }
      const value = values[columnIndex];
      if (value !== null && value !== undefined && value !== "") {
        requests.push({ insertText: { objectId, cellLocation, insertionIndex: 0, text: String(value) } });
      }
    }
  }
  return requests;
}

function replaceTableHeaderRequests(objectId, table, headers) {
  const requests = [];
  for (let columnIndex = 0; columnIndex < Math.min(headers.length, table?.columns || 0); columnIndex += 1) {
    const cellLocation = { rowIndex: 0, columnIndex };
    if (cellHasText(table, 0, columnIndex)) requests.push({ deleteText: { objectId, cellLocation, textRange: { type: "ALL" } } });
    requests.push({ insertText: { objectId, cellLocation, insertionIndex: 0, text: String(headers[columnIndex]) } });
  }
  return requests;
}

function survivalFillRequests(objectId, table, dataRows, columnIndex = 3) {
  const requests = [];
  const capacity = Math.max(0, (table?.rows || 0) - 1);
  const monthlyRows = dataRows.slice(0, capacity);
  const fills = [...monthlyRows.map((row) => survivalFillHex(row[columnIndex]))];
  if (monthlyRows.length < capacity) fills.push(SURVIVAL_FILL.normal);
  for (const [offset, fill] of fills.entries()) {
    requests.push({
      updateTableCellProperties: {
        objectId,
        tableRange: {
          location: { rowIndex: offset + 1, columnIndex },
          rowSpan: 1,
          columnSpan: 1
        },
        tableCellProperties: {
          tableCellBackgroundFill: {
            solidFill: { color: { rgbColor: rgbColor(fill) }, alpha: 1 }
          }
        },
        fields: "tableCellBackgroundFill.solidFill"
      }
    });
  }
  return requests;
}

function fillSplitTables(ids, index, inputRows, columns) {
  const requests = [];
  let cursor = 0;
  for (const id of ids) {
    const element = index.get(id);
    if (!element?.table) throw new Error(`В копии шаблона не найдена таблица ${id}`);
    const capacity = Math.max(0, element.table.rows - 1);
    requests.push(...tableCellRequests(id, element.table, inputRows.slice(cursor, cursor + capacity).map((row) => row.slice(0, columns))));
    cursor += capacity;
  }
  return { requests, overflow: Math.max(0, inputRows.length - cursor) };
}

function cowSurvivalData(report) {
  const structured = source(report, "retirement-60-days-year");
  const raw = (structured?.rows || []).slice(-12);
  const data = raw.map((row) => {
    const { calvings, retired } = cowSurvivalValues(structured, row);
    return [monthLabel(row[0]), calvings, retired, calvings > 0 ? Math.max(0, Math.round((calvings - retired) / calvings * 100)) : 0];
  });
  const totals = data.reduce((sum, row) => [sum[0] + row[1], sum[1] + row[2]], [0, 0]);
  const survival = totals[0] > 0 ? Math.max(0, Math.round((totals[0] - totals[1]) / totals[0] * 100)) : 0;
  return { data, total: ["ИТОГО", totals[0], totals[1], `${survival}%`] };
}

function youngstockData(report) {
  const structured = source(report, "youngstock-survival");
  const raw = (structured?.pivotTableData?.rows || []).slice(-6);
  const data = raw.map((row) => {
    const { alive, total } = youngstockRowValues(structured, row);
    return [monthLabel(row[0]), total, alive, total > 0 ? Math.round(alive / total * 100) : 0];
  });
  const totals = data.reduce((sum, row) => [sum[0] + row[1], sum[1] + row[2]], [0, 0]);
  return { data, total: ["ИТОГО", totals[0], totals[1], `${totals[0] > 0 ? Math.round(totals[1] / totals[0] * 100) : 0}%`] };
}

function chartValues(headers, data) {
  return [headers, ...data.map((row) => row.map((value) => value ?? 0))];
}

export function buildChartDefinitions(report, { start = report.period?.start } = {}) {
  const dryOff = rows(report, "sheet2-events-5304");
  const pregnancy = rows(report, "sheet2-events-5303");
  const firstAi = blueprintRows(report, "first-insemination", 3);
  const secondAi = blueprintRows(report, "second-insemination", 3);
  const calving = rows(report, "calving-result");
  const calfRetirement = rows(report, "calf-retirement-6-months");
  const earlyRetirement = rows(report, "retirement-60-days-milking");
  const milk = rows(report, "milk-deviation");
  const averageMilk = milk.length ? milk.reduce((sum, row) => sum + (number(row[2]) || 0), 0) / milk.length : 0;
  const cowSurvival = cowSurvivalData(report);
  const youngstock = youngstockData(report);
  const hdrRows = rows(report, "hdr-pr").filter((row) => number(row[6]) !== null && number(row[7]) !== null && number(row[5]) !== null).slice(-9);
  const milkForecast = rows(report, "livestock-forecast-milk");
  const herdForecast = rows(report, "livestock-forecast-herd");
  const forecastDates = source(report, "livestock-forecast-milk")?.forecastDates || [];
  const ultrasound = pregnancy.reduce((sum, row) => [sum[0] + (number(row[2]) || 0), sum[1] + (number(row[1]) || 0)], [0, 0]);
  const ultrasoundTotal = ultrasound[0] + ultrasound[1];
  const ultrasoundPercent = (value) => ultrasoundTotal > 0 ? Math.round(value / ultrasoundTotal * 100) : 0;
  const ultrasoundStart = shortNumericDate(start);
  const navy = REDESIGN_PALETTE.navy;
  const yellow = REDESIGN_PALETTE.yellow;
  const coral = REDESIGN_PALETTE.coral;
  const green = REDESIGN_PALETTE.green;
  const white = REDESIGN_PALETTE.white;
  const black = REDESIGN_PALETTE.black;
  const youngstockMinimum = youngstock.data.length
    ? Math.max(0, Math.floor((Math.min(...youngstock.data.map((row) => number(row[3]) || 0)) - 3) / 5) * 5)
    : 0;
  return [
    { key: "s3_dry_off", title: "Запуск по дням стельности", type: "COLUMN", headers: ["Дни", "Кол-во"], values: chartValues(["Дни", "Кол-во"], dryOff.map((row) => [row[0], number(row[1]) || 0])), colors: [navy], seriesDataLabels: [false], horizontalTitle: "Дней с осеменения", verticalTitle: "Кол-во", leftMin: 0, legendPosition: "NO_LEGEND" },
    { key: "s3_pregnancy", title: "Стельность", type: "COLUMN", headers: ["Дни", "Стельные", "Холостые"], values: chartValues(["Дни", "Стельные", "Холостые"], pregnancy.map((row) => [row[0], number(row[2]) || 0, number(row[1]) || 0])), colors: [navy, yellow], seriesDataLabels: [false, false], horizontalTitle: "Дни осеменения", verticalTitle: "Кол-во", leftMin: 0, stacked: true },
    { key: "s3_first_ai", title: "1-е осеменение", type: "SCATTER", headers: ["Дата", "DIMFB"], values: chartValues(["Дата", "DIMFB"], firstAi.map((row) => [row[1], number(row[2]) || 0])), colors: [navy], labelColors: [black], labelPlacements: ["ABOVE"], pointSizes: [9], horizontalTitle: "Дата осеменения", verticalTitle: "Дни при 1-ом осеменении", leftMin: 0, legendPosition: "NO_LEGEND" },
    { key: "s3_second_ai", title: "2-е осеменение", type: "SCATTER", headers: ["Дата", "DIMSB"], values: chartValues(["Дата", "DIMSB"], secondAi.map((row) => [row[1], number(row[2]) || 0])), colors: [navy], labelColors: [black], labelPlacements: ["ABOVE"], pointSizes: [9], horizontalTitle: "Дата осеменения", verticalTitle: "Дни при 2-ом осеменении", leftMin: 0, legendPosition: "NO_LEGEND" },
    { key: "s4_calving", title: "Тёлка и Бычок", type: "COLUMN", headers: ["Дата", "Тёлка", "Бычок"], values: chartValues(["Дата", "Тёлка", "Бычок"], calving.map((row) => [dateLabel(row[0]), number(row[2]) || 0, number(row[3]) || 0])), colors: [navy, yellow], seriesDataLabels: [false, false], horizontalTitle: "Дата отёла", verticalTitle: "Кол-во", leftMin: 0, stacked: true },
    { key: "s4_ultrasound", title: ultrasoundStart ? `Проверка УЗИ с: ${ultrasoundStart}` : "Проверка УЗИ", type: "PIE", headers: ["Статус", "Голов"], values: chartValues(["Статус", "Голов"], [[`Стельные\n${ultrasoundPercent(ultrasound[0])}%`, ultrasound[0]], [`Холостые\n${ultrasoundPercent(ultrasound[1])}%`, ultrasound[1]]]), legendPosition: "LABELED_LEGEND" },
    { key: "s4_calf_retirement", title: "Выбытие телят до 6 месяцев", type: "COLUMN", headers: ["Дата", "Продажа", "Падёж"], values: chartValues(["Дата", "Продажа", "Падёж"], calfRetirement.map((row) => [dateLabel(row[0]), number(row[1]) || 0, number(row[2]) || 0])), colors: [navy, yellow], seriesDataLabels: [false, false], horizontalTitle: "Дата выбытия", verticalTitle: "Кол-во", leftMin: 0, stacked: true },
    { key: "s4_milk_deviation", title: "Надой", type: "COMBO", headers: ["Дата", "Надой", "Отклонение %"], values: chartValues(["Дата", "Надой", "Отклонение %"], milk.map((row) => [dateLabel(row[0]), number(row[2]) || 0, averageMilk ? ((number(row[2]) || 0) - averageMilk) / averageMilk * 100 : 0])), colors: [navy, yellow], labelColors: [black, black], labelPlacements: ["BELOW", "ABOVE"], lineWidths: [3, 3], pointSizes: [7, 7], seriesTypes: ["LINE", "LINE"], secondary: [2], secondaryTitle: "%", verticalTitle: "Надой", leftMin: 0, numberFormats: { 2: "0.00" } },
    { key: "s4_early_retirement", title: "Выбытие до 60 дня доения", type: "COLUMN", headers: ["Дата", "Продажа", "Падёж"], values: chartValues(["Дата", "Продажа", "Падёж"], earlyRetirement.map((row) => [dateLabel(row[0]), number(row[1]) || 0, number(row[2]) || 0])), colors: [navy, yellow], seriesDataLabels: [false, false], horizontalTitle: "Дата выбытия", verticalTitle: "Кол-во", leftMin: 0, stacked: true },
    { key: "s5_cow_survival", title: "Отёл и выбытие", type: "COMBO", headers: ["Месяц", "Отёл", "Выбытие", "% Сохранности"], values: chartValues(["Месяц", "Отёл", "Выбытие", "% Сохранности"], cowSurvival.data), colors: [navy, coral, yellow], labelColors: [white, coral, black], labelPlacements: ["INSIDE_END", "ABOVE", "BELOW"], seriesTypes: ["COLUMN", "LINE", "LINE"], pointSizes: [0, 7, 7], secondary: [3], secondaryTitle: "%", verticalTitle: "Голов", leftMin: 0, rightMin: 0, rightMax: 100, numberFormats: { 3: "0\"%\"" } },
    { key: "s6_youngstock", title: "Сохранность телок", type: "COMBO", headers: ["Месяц", "Рождено", "Живых", "% Сохранности"], values: chartValues(["Месяц", "Рождено", "Живых", "% Сохранности"], youngstock.data), colors: [navy, green, yellow], labelColors: [white, white, black], labelPlacements: ["INSIDE_BASE", "INSIDE_BASE", "BELOW"], seriesTypes: ["COLUMN", "COLUMN", "LINE"], pointSizes: [0, 0, 7], secondary: [3], secondaryTitle: "%", verticalTitle: "Голов", leftMin: 0, rightMin: youngstockMinimum, rightMax: 100, numberFormats: { 3: "0\"%\"" } },
    { key: "s7_pregrate", title: "PREGRATE", type: "COMBO", headers: ["Период", "HDR", "PR", "CR"], values: chartValues(["Период", "HDR", "PR", "CR"], hdrRows.map((row) => [shortHdrPeriod(row[0]), number(row[3]) || 0, number(row[6]) || 0, number(row[7]) || 0])), colors: [navy, yellow, coral], labelColors: [black, black, black], labelPlacements: ["OUTSIDE_END", "OUTSIDE_END", "BELOW"], seriesTypes: ["COLUMN", "COLUMN", "LINE"], pointSizes: [0, 0, 7], verticalTitle: "%", leftMin: 0 },
    { key: "s8_milk_forecast", title: "Дойных коров и валовый надой сутки", type: "COMBO", headers: ["Месяц", "Дойных коров", "Валовый надой сутки"], values: chartValues(["Месяц", "Дойных коров", "Валовый надой сутки"], milkForecast.map((row, index) => [monthLabel(forecastDates[index]), number(row[0]) || 0, (number(row[0]) || 0) * (number(row[1]) || 0)])), colors: [navy, yellow], labelColors: [white, black], labelPlacements: ["INSIDE_END", "BELOW"], seriesTypes: ["COLUMN", "LINE"], pointSizes: [0, 7], secondary: [2], secondaryTitle: "кг", verticalTitle: "Голов", leftMin: 0, rightMin: 0 },
    { key: "s8_herd_forecast", title: "Поголовье и Вал", type: "COMBO", headers: ["Месяц", "Поголовье", "Вал"], values: chartValues(["Месяц", "Поголовье", "Вал"], herdForecast.map((row, index) => [monthLabel(forecastDates[index]), number(row[0]) || 0, (number(milkForecast[index]?.[0]) || 0) * (number(milkForecast[index]?.[1]) || 0)])), colors: [navy, yellow], labelColors: [white, black], labelPlacements: ["INSIDE_END", "BELOW"], seriesTypes: ["COLUMN", "LINE"], pointSizes: [0, 7], secondary: [2], secondaryTitle: "кг", verticalTitle: "Голов", leftMin: 0, rightMin: 0 }
  ];
}

function actualRect(element) {
  const dimension = (value) => {
    const magnitude = typeof value === "number" ? value : value?.magnitude;
    if (!Number.isFinite(magnitude)) return null;
    return value?.unit === "PT" ? magnitude : magnitude / 12700;
  };
  const unit = element.transform?.unit || "EMU";
  const translate = (value) => !Number.isFinite(value) ? null : unit === "PT" ? value : value / 12700;
  return {
    x: translate(element.transform?.translateX),
    y: translate(element.transform?.translateY),
    w: dimension(element.size?.width) * (element.transform?.scaleX ?? 1),
    h: dimension(element.size?.height) * (element.transform?.scaleY ?? 1)
  };
}

function elementRect(element) {
  if (element?.elementGroup?.children?.length) {
    const childRects = element.elementGroup.children.map(elementRect).filter((rect) => rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite));
    if (!childRects.length) return null;
    const left = Math.min(...childRects.map((rect) => rect.x));
    const top = Math.min(...childRects.map((rect) => rect.y));
    const right = Math.max(...childRects.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...childRects.map((rect) => rect.y + rect.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
  }
  const rect = actualRect(element);
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ? rect : null;
}

function chartCleanupRequests(fullDeck, presentation, index) {
  const requests = [];
  const deleted = new Set();
  for (const target of Object.values(fullDeck.charts || {})) {
    const placeholder = index.get(target.placeholderObjectId);
    const slide = (presentation.slides || []).find((item) => item.objectId === target.pageObjectId);
    if (!placeholder || !slide) continue;
    if (Array.isArray(target.cleanup) && target.cleanup.length === 2) {
      const [from, to] = target.cleanup;
      for (const element of slide.pageElements || []) {
        const match = element.objectId.match(new RegExp(`^${target.pageObjectId}_i(\\d+)$`));
        const order = match ? Number(match[1]) : null;
        if (order !== null && order >= from && order <= to && !deleted.has(element.objectId)) {
          deleted.add(element.objectId);
          requests.push({ deleteObject: { objectId: element.objectId } });
        }
      }
      continue;
    }
    const targetRect = actualRect(placeholder);
    const margin = 5;
    for (const element of slide.pageElements || []) {
      if (element.objectId === target.placeholderObjectId || deleted.has(element.objectId)) continue;
      const rect = elementRect(element);
      if (!rect) continue;
      const contained = rect.x >= targetRect.x - margin
        && rect.y >= targetRect.y - margin
        && rect.x + rect.w <= targetRect.x + targetRect.w + margin
        && rect.y + rect.h <= targetRect.y + targetRect.h + margin;
      if (contained) {
        deleted.add(element.objectId);
        requests.push({ deleteObject: { objectId: element.objectId } });
      }
    }
  }
  return requests;
}

function chartPlacementRequests(fullDeck, index, workspace, farmId) {
  const requests = [];
  let counter = 0;
  for (const [key, target] of Object.entries(fullDeck.charts || {})) {
    const chartId = workspace.chartIds[key];
    const placeholder = index.get(target.placeholderObjectId);
    if (!chartId || !placeholder) continue;
    const rect = actualRect(placeholder);
    requests.push({
      createSheetsChart: {
        objectId: `df_${farmId}_${counter++}_${Date.now()}`.slice(0, 48),
        spreadsheetId: workspace.spreadsheetId,
        chartId,
        linkingMode: "NOT_LINKED_IMAGE",
        elementProperties: {
          pageObjectId: target.pageObjectId,
          size: { width: { magnitude: rect.w, unit: "PT" }, height: { magnitude: rect.h, unit: "PT" } },
          transform: { scaleX: 1, scaleY: 1, translateX: rect.x, translateY: rect.y, unit: "PT" }
        }
      }
    });
  }
  return requests;
}

export function fitChartDefinitionsToPlaceholders(definitions, fullDeck, index) {
  const density = 1.5;
  const maxWidth = 1200;
  const maxHeight = 720;
  return definitions.map((definition) => {
    const target = fullDeck.charts?.[definition.key];
    const placeholder = target && index.get(target.placeholderObjectId);
    const rect = placeholder && actualRect(placeholder);
    if (!rect || !Number.isFinite(rect.w) || !Number.isFinite(rect.h) || rect.w <= 0 || rect.h <= 0) return definition;
    let widthPixels = Math.max(320, Math.round(rect.w * density));
    let heightPixels = Math.max(260, Math.round(rect.h * density));
    const scale = Math.min(1, maxWidth / widthPixels, maxHeight / heightPixels);
    widthPixels = Math.max(320, Math.round(widthPixels * scale));
    heightPixels = Math.max(260, Math.round(heightPixels * scale));
    return { ...definition, widthPixels, heightPixels };
  });
}

function tableCapacity(index, ids) {
  return (ids || []).reduce((sum, id) => sum + Math.max(0, (index.get(id)?.table?.rows || 1) - 1), 0);
}

async function extendListSlides({ accessToken, presentationId, presentation, fullDeck, report, farmId, fetchImpl }) {
  if (!fullDeck.pagination) return { fullDeck, presentation };
  const runtime = structuredClone(fullDeck);
  const index = elementIndex(presentation);
  const specs = [
    {
      key: "missedInsemination",
      rowCount: blueprintRows(report, "missed-insemination", 4).length,
      tableKey: "missedInseminationTables",
      totalKey: "missedInseminationTotal"
    },
    {
      key: "missedUltrasound",
      rowCount: blueprintRows(report, "missed-ultrasound", 5).length,
      tableKey: "missedUltrasoundTables",
      totalKey: "missedUltrasoundTotal"
    },
    {
      key: "missedDryOff",
      rowCount: blueprintRows(report, "missed-dry-off", 5).length,
      tableKey: "missedDryOffTables",
      totalKey: "missedDryOffTotal"
    }
  ];
  const duplicateRequests = [];
  let serial = 0;
  for (const spec of specs) {
    const pagination = runtime.pagination[spec.key];
    const baseCapacity = tableCapacity(index, runtime[spec.tableKey]);
    const pageCapacity = tableCapacity(index, pagination.tableTemplateIds);
    const additionalPages = pageCapacity > 0 ? Math.ceil(Math.max(0, spec.rowCount - baseCapacity) / pageCapacity) : 0;
    runtime[`${spec.key}Totals`] = [runtime[spec.totalKey]];
    for (let page = 0; page < additionalPages; page += 1) {
      const stamp = `${farmId}_${Date.now()}_${serial++}`;
      const objectIds = { [pagination.sourcePageObjectId]: `df_${stamp}_slide` };
      for (const [tableIndex, templateId] of pagination.tableTemplateIds.entries()) {
        objectIds[templateId] = `df_${stamp}_table_${tableIndex}`;
        runtime[spec.tableKey].push(objectIds[templateId]);
      }
      objectIds[pagination.totalTemplateId] = `df_${stamp}_total`;
      runtime[`${spec.key}Totals`].push(objectIds[pagination.totalTemplateId]);
      duplicateRequests.push({ duplicateObject: { objectId: pagination.sourcePageObjectId, objectIds } });
    }
  }
  if (!duplicateRequests.length) return { fullDeck: runtime, presentation };
  await googleJson(fetchImpl, `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: duplicateRequests })
  });
  const updated = await googleJson(fetchImpl, `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`, accessToken);
  return { fullDeck: runtime, presentation: updated };
}

function fullDeckRequests(report, fullDeck, index) {
  const requests = [];
  const weekly = rows(report, "weekly-events").slice(0, 26).map((row) => row.slice(0, 8));
  const weeklyTable = index.get(fullDeck.weeklyTable)?.table;
  if (!weeklyTable) throw new Error(`В копии шаблона не найдена таблица ${fullDeck.weeklyTable}`);
  requests.push(...tableCellRequests(fullDeck.weeklyTable, weeklyTable, weekly));

  const cow = cowSurvivalData(report);
  const cowTable = index.get(fullDeck.cowSurvivalTable)?.table;
  if (!cowTable) throw new Error(`В копии шаблона не найдена таблица ${fullDeck.cowSurvivalTable}`);
  requests.push(...replaceTableHeaderRequests(fullDeck.cowSurvivalTable, cowTable, ["Месяц", "Отел", "Выбытие", "Сохранность"]));
  requests.push(...tableCellRequests(fullDeck.cowSurvivalTable, cowTable, [...cow.data.map((row) => [row[0], row[1], row[2], `${row[3]}%`]), cow.total]));
  requests.push(...survivalFillRequests(fullDeck.cowSurvivalTable, cowTable, cow.data));

  const young = youngstockData(report);
  const youngTable = index.get(fullDeck.youngstockTable)?.table;
  if (!youngTable) throw new Error(`В копии шаблона не найдена таблица ${fullDeck.youngstockTable}`);
  requests.push(...replaceTableHeaderRequests(fullDeck.youngstockTable, youngTable, ["Месяц рождения", "Рождено", "Живых", "Сохранность"]));
  requests.push(...tableCellRequests(fullDeck.youngstockTable, youngTable, [...young.data.map((row) => [row[0], row[1], row[2], `${row[3]}%`]), young.total]));
  requests.push(...survivalFillRequests(fullDeck.youngstockTable, youngTable, young.data));

  const insemination = blueprintRows(report, "missed-insemination", 4).map((row) => row.map((value, column) => column === 3 ? normalizeStatus(value) : value));
  const ultrasound = blueprintRows(report, "missed-ultrasound", 5);
  const dryOff = blueprintRows(report, "missed-dry-off", 5);
  const lists = [
    [fullDeck.missedInseminationTables, fullDeck.missedInseminationTotals || [fullDeck.missedInseminationTotal], insemination, 4],
    [fullDeck.missedUltrasoundTables, fullDeck.missedUltrasoundTotals || [fullDeck.missedUltrasoundTotal], ultrasound, 5],
    [fullDeck.missedDryOffTables, fullDeck.missedDryOffTotals || [fullDeck.missedDryOffTotal], dryOff, 5]
  ];
  const overflow = [];
  for (const [tableIds, totalIds, data, columns] of lists) {
    const result = fillSplitTables(tableIds, index, data, columns);
    requests.push(...result.requests);
    if (result.overflow) overflow.push(`${totalIds.at(-1)}: не помещается ${result.overflow} строк`);
    for (const totalId of totalIds) {
      const totalElement = index.get(totalId);
      if (totalElement?.shape) requests.push(...replaceWholeText(totalId, textInfo(totalElement), `Всего: ${data.length} животных`));
    }
  }
  return { requests, overflow };
}

export async function createGooglePresentation({ accessToken, mapping, report, reportName, baseName, farmId, start, end, fetchImpl = fetch }) {
  const templateId = mapping.template.presentationId;
  const name = `${reportName || baseName}-${farmId}-${start}-${end}`;
  const copied = await googleJson(fetchImpl, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`, accessToken, { method: "POST", body: JSON.stringify({ name }) });
  const presentationId = copied.id;
  let presentation = await googleJson(fetchImpl, `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`, accessToken);
  const ids = mapping.nativeGoogleSlides?.controlSlides;
  if (!ids) throw new Error("В presentation-mapping.json отсутствует nativeGoogleSlides.controlSlides");
  let fullDeck = ids.fullDeck;
  if (fullDeck) {
    const extended = await extendListSlides({ accessToken, presentationId, presentation, fullDeck, report, farmId, fetchImpl });
    fullDeck = extended.fullDeck;
    presentation = extended.presentation;
  }
  const index = elementIndex(presentation);
  const values = slide12Values(report, { reportName, baseName, start, end });
  const requests = [];
  const requireText = (objectId) => {
    const element = index.get(objectId);
    if (!element?.shape) throw new Error(`В копии шаблона не найден текстовый объект ${objectId}`);
    return textInfo(element);
  };
  requests.push(...appendAfterTemplateText(ids.cover.title, requireText(ids.cover.title), "ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ARKA", baseName));
  requests.push(...replaceLine(ids.kpi.period, requireText(ids.kpi.period), 1, values.period));
  for (const [key, objectId] of Object.entries(ids.kpi.values)) requests.push(...replaceLine(objectId, requireText(objectId), 0, values[key]));

  let workspace = null;
  let overflow = [];
  if (fullDeck) {
    const tableUpdates = fullDeckRequests(report, fullDeck, index);
    requests.push(...tableUpdates.requests);
    overflow = tableUpdates.overflow;
    const chartDefinitions = fitChartDefinitionsToPlaceholders(buildChartDefinitions(report, { start }), fullDeck, index);
    workspace = await createChartWorkspace({ accessToken, title: `DairyFarm charts ${farmId} ${start}-${end}`, definitions: chartDefinitions, fetchImpl });
    requests.push(...chartCleanupRequests(fullDeck, presentation, index));
    requests.push(...chartPlacementRequests(fullDeck, index, workspace, farmId));
  }

  try {
    if (requests.length) await googleJson(fetchImpl, `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, accessToken, { method: "POST", body: JSON.stringify({ requests }) });
  } finally {
    if (workspace && mapping.output?.removeTemporaryChartSheet !== false) await trashChartWorkspace({ accessToken, spreadsheetId: workspace.spreadsheetId, fetchImpl });
  }
  return {
    presentationId,
    name: copied.name || name,
    url: copied.webViewLink || `https://docs.google.com/presentation/d/${presentationId}/edit`,
    filledSlides: fullDeck ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [1, 2],
    warnings: overflow
  };
}
