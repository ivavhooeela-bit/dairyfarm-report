import fs from "node:fs/promises";
import path from "node:path";
import { sourcePeriod } from "./dates.mjs";

const BASE_URL = "https://www.dairyfarm.dev";

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100);
}

function isoToDmy(value) {
  const [year, month, day] = String(value || "").split("-");
  return year && month && day ? `${day}.${month}.${year}` : "";
}

export function dateRangeTextMatches(text, start, end) {
  const normalized = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ");
  const compact = normalized.replace(/\s/g, "");
  return compact.includes(`${isoToDmy(start)}-${isoToDmy(end)}`);
}

async function gotoWithRetry(page, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await page.waitForTimeout(1000 * attempt);
    }
  }
  throw lastError;
}

async function trySetDates(page, start, end) {
  const visibleText = await page.locator("body").innerText().catch(() => "");
  if (dateRangeTextMatches(visibleText, start, end)) {
    return { applied: true, method: "visible-date-range" };
  }
  const readField = async (field) => {
    const tagName = await field.evaluate((element) => element.tagName);
    const value = tagName === "INPUT" ? await field.inputValue() : await field.textContent();
    return String(value || "").trim();
  };
  const fillInput = async (field, value) => {
    await field.fill(value);
    await field.evaluate((element) => element.blur()).catch(() => {});
  };
  const fillSegment = async (field, value) => {
    // Playwright fill reliably triggers the input event used by the segmented
    // DairyFarm date control. Keep a keyboard fallback for browser variants
    // where the segment is not directly fillable.
    await field.fill(value).catch(async () => {
      await field.click();
      await field.press("Control+A");
      await field.pressSequentially(value);
    });
    await field.press("Tab").catch(() => {});
    const actual = (await readField(field)).padStart(value.length, "0");
    if (actual !== value) {
      await field.click();
      await field.press("Control+A");
      await field.pressSequentially(value);
      await field.press("Tab").catch(() => {});
    }
  };

  const dateInputs = page.locator('input[type="date"]');
  const count = await dateInputs.count();
  if (count >= 2) {
    await fillInput(dateInputs.nth(0), start);
    await fillInput(dateInputs.nth(1), end);
    const actual = [await dateInputs.nth(0).inputValue(), await dateInputs.nth(1).inputValue()];
    return { applied: actual[0] === start && actual[1] === end, method: "date-inputs", actual };
  }

  const inputs = page.locator("input");
  const inputCount = await inputs.count();
  const candidates = [];
  for (let index = 0; index < inputCount; index += 1) {
    const input = inputs.nth(index);
    const placeholder = (await input.getAttribute("placeholder")) || "";
    if (/дат|date|дд|мм|гг/i.test(placeholder)) candidates.push(input);
  }
  if (candidates.length >= 2) {
    await fillInput(candidates[0], start);
    await fillInput(candidates[1], end);
    const actual = [await candidates[0].inputValue(), await candidates[1].inputValue()];
    return { applied: actual[0] === start && actual[1] === end, method: "placeholder-inputs", actual };
  }

  const labelledDateFields = page.locator(
    '[role="spinbutton"][aria-label*="Дата начала"], [role="spinbutton"][aria-label*="Дата окончания"]'
  );
  await labelledDateFields.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const spinbuttons = page.getByRole("spinbutton");
  if (await spinbuttons.count() >= 6) {
    const [startYear, startMonth, startDay] = start.split("-");
    const [endYear, endMonth, endDay] = end.split("-");
    const count = await spinbuttons.count();
    let labelled = 0;
    const labelledFields = [];
    for (let index = 0; index < count; index += 1) {
      const field = spinbuttons.nth(index);
      const label = (await field.getAttribute("aria-label")) || "";
      const isStart = /дата\s+(с|начала)/i.test(label);
      const isEnd = /дата\s+(по|окончания)/i.test(label);
      if (!isStart && !isEnd) continue;
      const parts = isStart
        ? { day: startDay, month: startMonth, year: startYear }
        : { day: endDay, month: endMonth, year: endYear };
      const value = /день/i.test(label) ? parts.day : /месяц/i.test(label) ? parts.month : /год/i.test(label) ? parts.year : null;
      if (value) labelledFields.push({ field, value, isEnd });
    }
    // DairyFarm may preserve the old interval length when its end changes.
    // Enter the end first and the start last so the start cannot be shifted.
    labelledFields.sort((left, right) => Number(right.isEnd) - Number(left.isEnd));
    for (const { field, value } of labelledFields) {
      const current = (await readField(field)).padStart(value.length, "0");
      if (current !== value) await fillSegment(field, value);
      labelled += 1;
    }
    if (labelled >= 6) {
      const mismatches = [];
      for (const { field, value } of labelledFields) {
        const actual = (await readField(field)).padStart(value.length, "0");
        if (actual !== value) mismatches.push({ expected: value, actual });
      }
      return {
        applied: mismatches.length === 0,
        method: "labelled-segmented-spinbuttons",
        ...(mismatches.length ? { mismatches } : {})
      };
    }

    const fallbackValues = [endDay, endMonth, endYear, startDay, startMonth, startYear];
    for (let index = 0; index < 6; index += 1) {
      await fillSegment(spinbuttons.nth(index), fallbackValues[index]);
    }
    const actual = [];
    for (let index = 0; index < 6; index += 1) actual.push(await readField(spinbuttons.nth(index)));
    return {
      applied: actual.every((value, index) => value.padStart(fallbackValues[index].length, "0") === fallbackValues[index]),
      method: "segmented-spinbuttons",
      actual
    };
  }
  return { applied: false, method: "not-found" };
}

async function clickReportAction(page, sourceType) {
  const patterns = sourceType === "monitor"
    ? [/рассчитать/i]
    : sourceType === "custom-report"
      ? [/обновить отч[её]т/i]
      : [/завершить и сохранить/i, /обновить отч[её]т/i, /рассчитать/i, /показать/i, /сформировать/i, /применить/i];
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).first();
    if (await button.count() && await button.isVisible()) {
      await button.click();
      await page.waitForTimeout(3000);
      return { clicked: true, label: pattern.source };
    }
  }
  return { clicked: false, label: null };
}

export function shouldUseExistingTable(source, dateSelection) {
  return Boolean(dateSelection?.fallbackUsed && dateSelection?.fallback === "current-table");
}

async function selectMissingGroupingField(page, fieldName) {
  const input = page.locator('input[name$="groupingParams.sourceFieldID_input"]').first();
  if (!await input.count() || !await input.isVisible().catch(() => false)) return false;
  await input.click();
  await input.fill(fieldName).catch(() => {});
  const normalizedFieldName = String(fieldName).trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const namePattern = new RegExp(`^\\s*${normalizedFieldName}\\s*$`, "i");
  const candidates = [
    page.getByRole("option", { name: namePattern }).last(),
    page.locator('[role="option"],li,button').filter({ hasText: namePattern }).last(),
    page.getByText(namePattern).last()
  ];
  for (const candidate of candidates) {
    await candidate.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    if (await candidate.count().catch(() => 0) && await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function configureReportPeriod(page, period, source, jsonResponses = []) {
  if (!period) return { applied: false, method: "not-required" };
  const sourceType = source.type;
  const settingsArea = source.settingsArea;
  const tableSettingsTypes = new Set(["events-report", "calving-report", "milking-report"]);
  const useTableSettings = settingsArea === "table" || tableSettingsTypes.has(sourceType);
  if (!useTableSettings) return trySetDates(page, period.start, period.end);

  const settingsEditor = page.getByText(/Настройки (?:графика и таблицы|таблицы)/i).first();
  const settingsAlreadyOpen = Boolean(await settingsEditor.count()
    && await settingsEditor.isVisible().catch(() => false));
  if (!settingsAlreadyOpen) {
    const tableHeading = page.getByText("Таблица", { exact: true }).first();
    let container = tableHeading;
    let tableSettings = null;
    if (await tableHeading.count()) {
      for (let depth = 0; depth < 6; depth += 1) {
        const candidate = container.getByRole("button", { name: /настройки/i }).first();
        if (await candidate.count() && await candidate.isVisible()) {
          tableSettings = candidate;
          break;
        }
        container = container.locator("xpath=..");
      }
    }
    if (!tableSettings) {
      const settingsButtons = page.locator("button").filter({ hasText: /^\s*Настройки\s*$/ });
      if (await settingsButtons.count() >= 1) tableSettings = settingsButtons.last();
    }
    if (!tableSettings) return { applied: false, method: "table-settings-not-found" };

    await tableSettings.click();
  }
  await page.locator(
    'input[type="date"], [role="spinbutton"][aria-label*="Дата начала"], [role="spinbutton"][aria-label*="Дата окончания"]'
  ).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  let groupingRepair = null;
  if (sourceType === "events-report" && source.requiredGroupingField
    && eventsReportGroupingFieldMissing(jsonResponses, source)) {
    groupingRepair = {
      field: source.requiredGroupingField,
      applied: await selectMissingGroupingField(page, source.requiredGroupingField)
    };
  }
  let selection;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    selection = await trySetDates(page, period.start, period.end);
    if (selection.applied) break;
    await page.waitForTimeout(400);
  }
  if (!selection.applied) {
    return { ...selection, settingsSaved: false, error: "Поля периода в настройках таблицы не заполнены." };
  }
  const firstDateField = page.locator(
    'input[type="date"], [role="spinbutton"][aria-label*="Дата начала"], [role="spinbutton"][aria-label*="Дата окончания"]'
  ).first();
  const settingsForm = firstDateField.locator("xpath=ancestor::form[1]");
  for (const pattern of [/^\s*сохранить\s*$/i, /^\s*применить\s*$/i, /^\s*готово\s*$/i]) {
    const scopedButton = settingsForm.getByRole("button", { name: pattern }).last();
    const button = await settingsForm.count() && await scopedButton.count()
      ? scopedButton
      : page.getByRole("button", { name: pattern }).last();
    if (await button.count() && await button.isVisible()) {
      await button.click();
      await firstDateField.waitFor({ state: "hidden", timeout: 12000 }).catch(() => {});
      const settingsSaved = !await firstDateField.isVisible().catch(() => false);
      return {
        ...selection,
        settingsSaved,
        ...(groupingRepair ? { groupingRepair } : {}),
        ...(settingsSaved ? {} : { error: "Настройки таблицы не закрылись после нажатия «Сохранить»." })
      };
    }
  }
  return { ...selection, settingsSaved: false };
}

async function closeTableSettings(page) {
  const button = page.getByRole("button", { name: /^\s*отмена\s*$/i }).last();
  if (!await button.count() || !await button.isVisible()) return false;
  await button.click();
  const dateField = page.locator(
    'input[type="date"], [role="spinbutton"][aria-label*="Дата начала"], [role="spinbutton"][aria-label*="Дата окончания"]'
  ).first();
  await dateField.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  return !await dateField.isVisible().catch(() => false);
}

async function visibleSnapshot(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")].map((table) =>
      [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("th,td")].map((cell) => cell.innerText.trim())
      )
    );
    return {
      title: document.title,
      text: document.body?.innerText?.slice(0, 200000) || "",
      tables,
      controls: [...document.querySelectorAll("input,button,[role=button],[contenteditable=true]")].map((element) => ({
        tag: element.tagName,
        type: element.getAttribute("type"),
        role: element.getAttribute("role"),
        name: element.getAttribute("name"),
        placeholder: element.getAttribute("placeholder"),
        ariaLabel: element.getAttribute("aria-label"),
        value: "value" in element ? element.value : null,
        text: element.innerText?.trim()?.slice(0, 200) || ""
      }))
    };
  });
}

function findMetric(snapshot, metricName) {
  const wantedNames = metricSearchNames(metricName);
  const wantedDisplayNames = metricAliases(metricName).map(normalizeMetricDisplayName);
  for (const table of snapshot.tables) {
    for (const row of table) {
      let index = row.findIndex((cell) => wantedDisplayNames.includes(normalizeMetricDisplayName(cell)));
      if (index < 0) index = row.findIndex((cell) => {
        const normalizedCell = normalizeMetricName(cell);
        return wantedNames.some((wanted) => normalizedCell.includes(wanted));
      });
      if (index >= 0) {
        const values = row.slice(index + 1).filter(Boolean);
        return { label: row[index], value: values.at(-1) ?? null, row };
      }
    }
  }
  const lines = snapshot.text.split(/\r?\n/);
  const line = lines.find((item) => wantedDisplayNames.includes(normalizeMetricDisplayName(item)))
    || lines.find((item) => {
    const normalizedLine = normalizeMetricName(item);
    return wantedNames.some((wanted) => normalizedLine.includes(wanted));
  });
  return line ? { label: metricName, value: line, row: [line] } : null;
}

function responseItems(jsonResponses, operationName) {
  const found = [];
  for (const response of jsonResponses) {
    const requests = Array.isArray(response.request?.postData) ? response.request.postData : [response.request?.postData];
    const bodies = Array.isArray(response.body) ? response.body : [response.body];
    requests.forEach((request, index) => {
      if (request?.operationName === operationName) found.push(bodies[index] ?? bodies[0]);
    });
  }
  return found;
}

function hasResponseOperation(jsonResponses, operationName) {
  return responseItems(jsonResponses, operationName).length > 0;
}

function reportIdFromSource(source) {
  const match = String(source?.url || "").match(/([a-z]+Report_\d+)/i);
  return match?.[1] || null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function openCustomReportFromCatalog(page, source, jsonResponses = [], timeout = 15000) {
  const reportId = reportIdFromSource(source);
  const normalizedNamePattern = String(source?.name || "")
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  const candidates = [
    ...(reportId ? [page.locator(`a[href*="${reportId}"]`).first()] : []),
    page.locator('a,button,[role="link"],[role="button"]').filter({
      hasText: new RegExp(normalizedNamePattern, "i")
    }).first(),
    page.getByText(new RegExp(`^\\s*${normalizedNamePattern}\\s*$`, "i")).first()
  ];
  const started = Date.now();
  let selected = null;
  while (!selected && Date.now() - started < timeout) {
    for (const candidate of candidates) {
      if (await candidate.count().catch(() => 0) && await candidate.isVisible().catch(() => false)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) await page.waitForTimeout(350);
  }
  if (!selected) {
    throw new Error(`Отчёт «${source.name}» не появился в каталоге. Проверьте ссылку или права доступа.`);
  }

  await selected.click();
  const navigationStarted = Date.now();
  while (Date.now() - navigationStarted < timeout) {
    const pathname = new URL(page.url()).pathname;
    if (!/\/custom-reports\/?$/.test(pathname) || hasResponseOperation(jsonResponses, "launchCustomReport")) return;
    await page.waitForTimeout(350);
  }
  throw new Error(`Карточка отчёта «${source.name}» найдена, но отчёт не открылся.`);
}

function detailedReportNode(jsonResponses, operationName, connectionName, source) {
  const nodes = responseItems(jsonResponses, operationName)
    .flatMap((body) => body?.data?.[connectionName]?.edges || [])
    .map((edge) => edge?.node)
    .filter((node) => node?.calculatedReport);
  const reportId = reportIdFromSource(source);
  return (reportId ? nodes.filter((node) => node.id === reportId).at(-1) : null) || nodes.at(-1) || null;
}

export function eventsReportGroupingFieldMissing(jsonResponses, source) {
  const node = detailedReportNode(jsonResponses, "customEventsReportsDetailed", "customEventsReports", source);
  const actual = node?.settings?.grouping?.actualGrouping;
  return actual?.groupingKind === "SOURCE_FIELD" && !actual?.groupingParams?.sourceField;
}

function calculatedMutationNode(jsonResponses, operationName, fieldName) {
  const value = responseItems(jsonResponses, operationName)
    .map((body) => body?.data?.[fieldName])
    .filter(Boolean)
    .at(-1);
  if (!value) return null;
  if (value.calculatedReport) return value;
  if (value.groupingColumnValues && value.columns) return { calculatedReport: value };
  if (value.xAxisLabels || /(?:Data|Chart)Empty$/i.test(value.__typename || "")) {
    return { calculatedReport: value };
  }
  return null;
}

export function settingsMutationConfirmsPeriod(jsonResponses, sourceType, period) {
  const operationName = {
    "events-report": "setCustomEventsReportSettings",
    "calving-report": "setCalvingEventsReportSettings",
    "milking-report": "setCustomMilkingReportSettings"
  }[sourceType];
  if (!operationName || !period) return false;
  return responseItems(jsonResponses, operationName).some((body) => {
    const interval = body?.data?.[operationName]?.settings?.period?.interval;
    return interval?.since === period.start && interval?.till === period.end;
  });
}

export function settingsMutationError(jsonResponses, sourceType) {
  const operationName = {
    "events-report": "setCustomEventsReportSettings",
    "calving-report": "setCalvingEventsReportSettings",
    "milking-report": "setCustomMilkingReportSettings"
  }[sourceType];
  if (!operationName) return null;
  return responseItems(jsonResponses, operationName)
    .flatMap((body) => body?.errors || [])
    .map((error) => error?.extensions?.title
      ? `${error.extensions.title}: ${error.extensions.message || error.message || "неизвестная ошибка"}`
      : error?.message)
    .filter(Boolean)
    .at(-1) || null;
}

async function waitForResponseOperation(page, jsonResponses, operationName, timeout = 15000) {
  const started = Date.now();
  while (!hasResponseOperation(jsonResponses, operationName) && Date.now() - started < timeout) {
    await page.waitForTimeout(400);
  }
  return hasResponseOperation(jsonResponses, operationName);
}

function normalizeMetricName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9%]+/giu, "");
}

function normalizeMetricDisplayName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9%]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metricAliases(metricName) {
  const normalized = normalizeMetricName(metricName);
  const aliases = {
    [normalizeMetricName("Кол-во коров в стаде")]: ["Количество коров в стаде"],
    [normalizeMetricName("Кол-во БРАК коровы")]: ["Кол-во БРАК", "Количество БРАК", "Кол-во Брака", "Количество Брака"],
    [normalizeMetricName("Средний надой ДЗ")]: ["Средний надой КД"],
    [normalizeMetricName("Средние дни в доении (без сух.)")]: ["Средние дни в доении"],
    [normalizeMetricName("% Брака коровы")]: ["% Брака"]
  };
  return [metricName, ...(aliases[normalized] || [])];
}

function metricSearchNames(metricName) {
  return metricAliases(metricName).map(normalizeMetricName);
}

export function extractMonitor(jsonResponses, metricNames, { start, end, selection = "latest-at-or-before-end" } = {}) {
  const body = responseItems(jsonResponses, "monitor").at(-1);
  const edges = body?.data?.monitor?.edges || [];
  const entries = edges.map((edge) => edge?.node).filter((node) => node?.values);
  return Object.fromEntries(metricNames.map((metricName) => {
    const wantedNames = metricSearchNames(metricName);
    const wantedDisplayNames = metricAliases(metricName).map(normalizeMetricDisplayName);
    const entry = wantedDisplayNames
      .map((wanted) => entries.find((item) => normalizeMetricDisplayName(item.name) === wanted))
      .find(Boolean)
      || wantedNames
      .map((wanted) => entries.find((item) => normalizeMetricName(item.name) === wanted))
      .find(Boolean)
      || wantedNames
        .map((wanted) => entries.find((item) => normalizeMetricName(item.name).includes(wanted)))
        .find(Boolean);
    if (!entry) return [metricName, null];
    const datedValues = entry.values.filter((item) => item.monitorLaunch?.happenedOn);
    const candidates = selection === "latest-available" || !end
      ? datedValues
      : datedValues.filter((item) => item.monitorLaunch.happenedOn <= end);
    const latest = candidates
      .toSorted((a, b) => a.monitorLaunch.happenedOn.localeCompare(b.monitorLaunch.happenedOn))
      .at(-1);
    return [metricName, latest ? {
      name: entry.name,
      value: latest.value,
      date: latest.monitorLaunch.happenedOn,
      calculationMethod: entry.calculationMethod,
      target: entry.target,
      selection
    } : null];
  }));
}

const calvingColumnLabels = {
  CALVING_COUNT: "Число отёлов",
  HEIFERS_BORN_COUNT: "Родилось тёлок",
  BULL_CALVES_BORN_COUNT: "Родилось быков",
  BULLS_BORN_COUNT: "Родилось быков"
};

const dowLabels = {
  MON: "Понедельник",
  TUE: "Вторник",
  WED: "Среда",
  THU: "Четверг",
  FRI: "Пятница",
  SAT: "Суббота",
  SUN: "Воскресенье"
};

function groupingValue(value) {
  if (value === null || value === undefined) return "Всего";
  if (value.dateStart) return value.dateStart;
  if (value.dayStart !== null && value.dayStart !== undefined) {
    return value.dayStart === value.dayEnd ? value.dayStart : `${value.dayStart}-${value.dayEnd}`;
  }
  if (value.dowValue) return dowLabels[value.dowValue] || value.dowValue;
  return scalarValue(value) ?? Object.values(value).find((item) => typeof item === "string" && item !== value.__typename) ?? null;
}

function reportColumnLabel(column) {
  return column.veterinaryActivity?.name || calvingColumnLabels[column.kind] || column.kind || "Итого";
}

export function extractHdrPrFromResponses(jsonResponses, source, userEnd) {
  const node = detailedReportNode(
    jsonResponses,
    "reproductionHdrAndPrReportsDetailed",
    "reproductionHdrAndPrReports",
    source
  );
  const report = node?.calculatedReport;
  if (!report?.rows) return null;
  const rows = report.rows.map((row) => [
    `${isoToDmy(row.since)}\u00a0– ${isoToDmy(row.till)}`,
    row.fitForInsemination,
    row.inseminated,
    row.hdr,
    row.fitForPregnancy,
    row.pregnant,
    row.pr,
    row.cr,
    row.abortions
  ]);
  const complete = report.rows.filter((row) => row.till <= userEnd
    && [row.fitForInsemination, row.inseminated, row.hdr, row.fitForPregnancy, row.pregnant, row.pr, row.cr, row.abortions]
      .every((value) => value !== null && value !== undefined));
  return {
    headers: ["Дата", "Пригодные к осемен.", "Осемен.", "Выявление (HDR)", "Пригодные к стельности", "Стельные", "Стельность (PR)", "Оплодотворяемость (CR)", "Аборты"],
    rows,
    total: report.total || null,
    selected: complete.length ? rows[report.rows.indexOf(complete.at(-1))] : null
  };
}

export function extractEventsFromResponses(jsonResponses, source) {
  const isCalving = source.type === "calving-report";
  const detailedNode = detailedReportNode(
    jsonResponses,
    isCalving ? "calvingEventsReportsDetailed" : "customEventsReportsDetailed",
    isCalving ? "calvingEventsReports" : "customEventsReports",
    source
  );
  const settingsField = isCalving ? "setCalvingEventsReportSettings" : "setCustomEventsReportSettings";
  const calculateField = isCalving ? "calculateCalvingEventsReport" : "calculateCustomEventsReport";
  const settingsNode = calculatedMutationNode(jsonResponses, settingsField, settingsField);
  const calculatedNode = calculatedMutationNode(jsonResponses, calculateField, calculateField);
  const mutationNode = settingsNode || calculatedNode;
  const node = mutationNode
    ? { ...mutationNode, settings: mutationNode.settings || detailedNode?.settings }
    : detailedNode;
  const report = node?.calculatedReport;
  if (/DataEmpty$/i.test(report?.__typename || "")) {
    return { columns: [], rows: [], emptyConfirmed: true };
  }
  if (!report?.columns || !report?.groupingColumnValues) return null;
  const groups = report.groupingColumnValues.map(groupingValue);
  const columns = report.columns;
  const valuesFor = (column) => column.valuesAndTotal || column.values || [];
  let headers;
  let rows;
  if (node.settings?.isTransposed) {
    let groupIndexes = groups.map((_, index) => index);
    if (source.transfer === "all-columns-except-last" && groupIndexes.length) groupIndexes = groupIndexes.slice(0, -1);
    headers = ["Показатель", ...groupIndexes.map((index) => groups[index])];
    rows = columns.map((column) => [reportColumnLabel(column), ...groupIndexes.map((index) => valuesFor(column)[index] ?? null)]);
  } else {
    let groupIndexes = groups.map((_, index) => index);
    if (source.transfer === "all-rows-except-total") groupIndexes = groupIndexes.filter((index) => groups[index] !== "Всего");
    headers = ["Период", ...columns.map(reportColumnLabel)];
    rows = groupIndexes.map((index) => [groups[index], ...columns.map((column) => valuesFor(column)[index] ?? null)]);
  }
  if (source.rowSelection === "latest" && Number.isInteger(source.rowLimit) && source.rowLimit >= 0) {
    rows = rows.slice(-source.rowLimit);
  }
  return { columns: headers.map((name) => ({ name })), rows };
}

function zeroMilkingRows(period) {
  if (!period?.start || !period?.end) return [];
  const rows = [];
  const current = new Date(`${period.start}T00:00:00Z`);
  const last = new Date(`${period.end}T00:00:00Z`);
  while (current <= last) {
    rows.push([current.toISOString().slice(0, 10), 0, 0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return rows;
}

export function extractMilkingFromResponses(jsonResponses, source, period = null) {
  const detailedNode = detailedReportNode(
    jsonResponses,
    "customMilkingReportsDetailed",
    "customMilkingReports",
    source
  );
  const settingsNode = calculatedMutationNode(
    jsonResponses,
    "setCustomMilkingReportSettings",
    "setCustomMilkingReportSettings"
  );
  const calculatedNode = calculatedMutationNode(
    jsonResponses,
    "calculateCustomMilkingReport",
    "calculateCustomMilkingReport"
  );
  const node = settingsNode || calculatedNode || detailedNode;
  const report = node?.calculatedReport;
  if (/(?:Data|Chart)Empty$/i.test(report?.__typename || "")) {
    return {
      columns: [{ name: "Дата" }, { name: "Голов" }, { name: "Надой" }],
      rows: zeroMilkingRows(period),
      emptyConfirmed: true
    };
  }
  const dates = report?.xAxisLabels?.xAxisDateLabels;
  if (!dates?.length) return null;
  const milk = report.yAxisDatasets?.[0] || [];
  const heads = report.yAxisCowCounts?.[0] || [];
  return {
    columns: [{ name: "Дата" }, { name: "Голов" }, { name: "Надой" }],
    rows: dates.map((date, index) => [
      date,
      heads[index] ?? 0,
      milk[index] == null ? 0 : Math.round(milk[index] * 10) / 10
    ])
  };
}

function scalarValue(value) {
  if (!value) return null;
  for (const key of ["intValue", "floatValue", "strValue", "dateValue"]) {
    if (value[key] !== null && value[key] !== undefined) return value[key];
  }
  return null;
}

export function tabulatePivotTable(pivotTable, { excludeTotal = true, rowSelection = null, rowLimit = null } = {}) {
  if (!pivotTable) return null;
  const rowFieldName = pivotTable.columns?.[0]?.blueprintSourceField?.name || "Строка";
  const valueHeaders = pivotTable.columns?.[1]?.blueprintSourceFieldValues || [];
  const columns = [
    { name: rowFieldName },
    ...valueHeaders.map((value, index) => ({ name: value == null ? "Итого" : String(scalarValue(value) ?? `Значение ${index + 1}`) }))
  ];
  let rows = (pivotTable.rows || []).map((row) => [
    scalarValue(row.blueprintSourceFieldValue),
    ...(row.values || []).map(scalarValue)
  ]);
  if (excludeTotal) rows = rows.filter((row) => row[0] !== null && row[0] !== "");
  if (rowSelection === "latest" && Number.isInteger(rowLimit) && rowLimit >= 0) rows = rows.slice(-rowLimit);
  return { columns, rows };
}

function extractCustomReport(jsonResponses, source = {}) {
  const body = responseItems(jsonResponses, "launchCustomReport")
    .filter((item) => item?.data?.launchCustomReport)
    .at(-1);
  const launch = body?.data?.launchCustomReport;
  if (!launch) return null;
  const raw = launch.blueprintLaunchResult;
  return {
    hashID: launch.hashID,
    columns: (raw?.columnSourceFields || []).map((column) => ({ id: column.id, name: column.name, kind: column.kind, valueKind: column.returnValueKind })),
    rows: (raw?.rows || []).map((row) => row.values.map(scalarValue)),
    pivotTable: launch.pivotTable,
    pivotTableData: tabulatePivotTable(launch.pivotTable, {
      excludeTotal: source.transfer === "pivot-rows-except-total",
      rowSelection: source.rowSelection,
      rowLimit: source.rowLimit
    }),
    charts: launch.charts
  };
}

export function extractLivestockForecast(jsonResponses, source, userEnd) {
  const body = responseItems(jsonResponses, "livestockForecastMonths")
    .filter((item) => item?.data?.livestockForecastMonths)
    .at(-1);
  const months = body?.data?.livestockForecastMonths || [];
  const mappings = Object.entries(source.fields || {});
  if (source.transfer === "mapped-12-months") {
    const selectedMonths = months.slice(0, source.rowLimit || 12);
    const rows = selectedMonths.map((item) => {
      const values = {
        "Дойные, всего": item.livestockCows?.allLactationsTotal
          ?? ((item.livestockCows?.firstLactation?.milking || 0) + (item.livestockCows?.otherLactations?.milking || 0)),
        "Надой на голову, кг": item.milkPerHead ?? null,
        "Коровы": item.livestockCows?.total ?? null
      };
      return mappings.map(([origin]) => values[origin] ?? null);
    });
    return {
      forecastDates: selectedMonths.map((item) => item.forecastAt),
      columns: mappings.map(([, target]) => ({ name: target })),
      rows
    };
  }
  const requestedMonth = userEnd.slice(0, 7);
  const month = months.find((item) => item.forecastAt?.slice(0, 7) === requestedMonth) || months[0];
  if (!month) return null;

  const values = {
    "Дойные, всего": (month.livestockCows?.firstLactation?.milking || 0) + (month.livestockCows?.otherLactations?.milking || 0),
    "Вал молока, т": month.milk?.total == null ? null : Math.round(month.milk.total / 1000 * 100) / 100,
    "Поголовье": month.livestockTotal ?? null
  };
  return {
    forecastAt: month.forecastAt,
    columns: mappings.map(([, target]) => ({ name: target })),
    rows: [mappings.map(([origin]) => values[origin] ?? null)],
    sourceValues: Object.fromEntries(mappings.map(([origin]) => [origin, values[origin] ?? null]))
  };
}

export function tabulateBlueprint(blueprint) {
  if (!blueprint) return null;
  const names = blueprint.dataRowColumns || [];
  const kinds = blueprint.dataRowColumnKinds || [];
  const columns = names.map((name, index) => ({ name, kind: kinds[index] || null }));
  const rows = (blueprint.rows || []).map((item) => {
    let data = {};
    try { data = JSON.parse(item.row || "{}"); } catch { data = {}; }
    return names.map((name) => data[name] ?? null);
  });
  return { columns, rows };
}

export function splitRowsInHalf(rows) {
  const midpoint = Math.ceil((rows || []).length / 2);
  return {
    first: (rows || []).slice(0, midpoint),
    second: (rows || []).slice(midpoint)
  };
}

function extractBlueprint(jsonResponses, source = {}) {
  const candidates = jsonResponses.flatMap((response) => Array.isArray(response.body) ? response.body : [response.body]);
  const body = candidates.filter((item) => item?.data?.launchBlueprint).at(-1);
  const blueprint = body?.data?.launchBlueprint || null;
  if (!blueprint) return null;
  const table = tabulateBlueprint(blueprint);
  return {
    ...blueprint,
    table,
    ...(source.transfer === "full-table-split-halves" ? { splitTable: splitRowsInHalf(table.rows) } : {})
  };
}

function nonEmptyTables(snapshot) {
  return snapshot.tables
    .map((table) => table.map((row) => row.map((cell) => cell.trim())).filter((row) => row.some(Boolean)))
    .filter((table) => table.length);
}

export function extractHdrPr(snapshot, userEnd) {
  const tables = nonEmptyTables(snapshot);
  const table = tables.find((candidate) => candidate.some((row) => {
    const labels = row.map(normalizeMetricName);
    return labels.includes("дата")
      && labels.some((label) => label.startsWith("выявлениеhdr"))
      && labels.some((label) => label.startsWith("стельностьpr"));
  })) || tables[0];
  if (!table?.length) return null;
  const headerIndex = table.findIndex((row) => row.some((cell) => normalizeMetricName(cell) === "дата"));
  if (headerIndex < 0) return null;
  const dateColumnIndex = table[headerIndex].findIndex((cell) => normalizeMetricName(cell) === "дата");
  const headers = table[headerIndex].slice(dateColumnIndex, dateColumnIndex + 9);
  const periodPattern = /^\d{2}\.\d{2}\.\d{4}\s*[–-]\s*\d{2}\.\d{2}\.\d{4}$/;
  const parsedRows = table.slice(headerIndex + 1).map((row) => {
    const startIndex = row.findIndex((cell) => periodPattern.test(cell) || /^всего$/i.test(cell));
    return startIndex >= 0 ? row.slice(startIndex, startIndex + 9) : [];
  }).filter((row) => row.length === 9);
  const total = parsedRows.find((row) => /^всего$/i.test(row[0])) || null;
  const rows = parsedRows.filter((row) => !/^всего$/i.test(row[0]));
  const parseEnd = (period) => {
    const match = period?.match(/\d{2}\.\d{2}\.\d{4}\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  };
  const complete = rows.filter((row) => {
    const end = parseEnd(row[0]);
    return end && end <= userEnd && row.length >= 9 && row.slice(1, 9).every((value) => value !== "");
  });
  return { headers, rows, total, selected: complete.at(-1) || null };
}

export function extractEvents(snapshot, transfer, { rowSelection = null, rowLimit = null } = {}) {
  const tables = nonEmptyTables(snapshot);
  const table = tables.find((candidate) => {
    const headerWidth = candidate[0]?.filter(Boolean).length || 0;
    return headerWidth >= 8 && candidate.length > 1;
  }) || tables[0];
  if (!table?.length) return null;
  // Some DairyFarm tables use a short, grouped header while their data rows
  // contain many date columns. Determine the width from the entire table so
  // those cells are not accidentally truncated to the header width.
  const width = Math.max(...table.map((row) => {
    let last = row.length - 1;
    while (last >= 0 && row[last] === "") last -= 1;
    return last + 1;
  }));
  let headers = Array.from({ length: width }, (_, index) => table[0][index] || "");
  let rows = table.slice(1).map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
  if (transfer === "transpose-milking-daily") {
    const datePattern = /^\d{2}\.\d{2}\.\d{4}$/;
    const dateRow = rows.find((row) => row.some((cell) => datePattern.test(cell)));
    if (!dateRow) return { columns: [{ name: "Дата" }, { name: "Голов" }, { name: "Надой" }], rows: [] };
    const dates = dateRow.filter((cell) => datePattern.test(cell));
    const metricRows = rows.filter((row) => row !== dateRow);
    const numericValue = (value) => {
      const parsed = Number(String(value || "").replace(/[\s  ]/g, "").replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const magnitude = (row) => {
      const values = row.slice(-dates.length).map(numericValue).filter((value) => value !== null);
      return values.length ? values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length : Number.POSITIVE_INFINITY;
    };
    const labelledMilk = metricRows.find((row) => /надой/i.test(row[0] || ""));
    const milkRow = labelledMilk || metricRows.toSorted((left, right) => magnitude(left) - magnitude(right))[0] || [];
    const headsRow = metricRows.find((row) => row !== milkRow) || [];
    const milkValues = milkRow.slice(-dates.length);
    const headsValues = headsRow.slice(-dates.length);
    return {
      columns: [{ name: "Дата" }, { name: "Голов" }, { name: "Надой" }],
      rows: dates.map((date, index) => [
        date,
        numericValue(headsValues[index]) ?? 0,
        numericValue(milkValues[index]) ?? 0
      ])
    };
  }
  if (transfer === "all-columns-except-last" && width > 0) {
    headers = headers.slice(0, -1);
    rows = rows.map((row) => row.slice(0, -1));
  }
  if (transfer === "all-columns-except-total") {
    const totalIndex = headers.findIndex((cell) => /^всего$/i.test(cell));
    if (totalIndex >= 0) {
      headers.splice(totalIndex, 1);
      rows = rows.map((row) => row.filter((_, index) => index !== totalIndex));
    }
  }
  if (transfer === "all-rows-except-total") rows = rows.filter((row) => !/^всего$/i.test(row[0] || ""));
  if (rowSelection === "latest" && Number.isInteger(rowLimit) && rowLimit >= 0) {
    rows = rows.slice(-rowLimit);
  }
  return { columns: headers.map((name, index) => ({ name: name || `Колонка ${index + 1}` })), rows };
}

export async function collectReport({ context, config, start, end, outputDir, onProgress = () => {}, signal = null }) {
  const runId = `${config.farmId}-${start}-${end}-${Date.now()}`;
  const runDir = path.join(outputDir, safeName(runId));
  await fs.mkdir(runDir, { recursive: true });
  const result = {
    runId,
    farmId: config.farmId,
    start,
    end,
    createdAt: new Date().toISOString(),
    sources: [],
    warnings: [],
    errors: [...(config.configurationErrors || [])],
    cancelled: false
  };
  for (const item of config.configurationErrors || []) {
    onProgress({ source: item.source, status: "skipped", message: item.message });
  }

  for (const source of config.sources) {
    if (signal?.aborted) {
      result.cancelled = true;
      break;
    }
    onProgress({ source: source.id, status: "loading" });
    const page = await context.newPage();
    if (signal?.aborted) {
      result.cancelled = true;
      await page.close().catch(() => {});
      break;
    }
    const closeOnAbort = () => page.close().catch(() => {});
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    const jsonResponses = [];
    page.on("response", async (response) => {
      try {
        const contentType = response.headers()["content-type"] || "";
        if (!contentType.includes("json") || !/^(https:\/\/(www|gateway)\.dairyfarm\.dev)/.test(response.url())) return;
        const request = response.request();
        let postData = null;
        try { postData = request.postDataJSON(); } catch { postData = request.postData(); }
        const body = await response.json();
        jsonResponses.push({
          url: response.url(),
          status: response.status(),
          request: { method: request.method(), postData },
          body
        });
      } catch {
        // Некоторые ответы нельзя прочитать повторно; это не останавливает сбор.
      }
    });

    try {
      await gotoWithRetry(page, `${BASE_URL}${source.url}`);
      await page.waitForTimeout(2500);
      if (new URL(page.url()).pathname === "/login") {
        throw new Error("Требуется вход в DairyFarm. Нажмите «Открыть вход» и авторизуйтесь.");
      }
      const initialPageText = await page.locator("body").innerText().catch(() => "");
      if (/Страница не найдена/i.test(initialPageText) && /Ошибка\s*404/i.test(initialPageText)) {
        throw new Error("Страница отчёта не найдена (404). Проверьте ссылку в настройках базы.");
      }
      if (source.type === "monitor" && !hasResponseOperation(jsonResponses, "monitor")) {
        if (hasResponseOperation(jsonResponses, "refreshAuthToken")) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
        }
        await waitForResponseOperation(page, jsonResponses, "monitor");
      }
      if (source.type === "custom-report" && /\/custom-reports\/?$/.test(new URL(page.url()).pathname)) {
        await openCustomReportFromCatalog(page, source, jsonResponses);
      }
      const effectivePeriod = sourcePeriod(source.period, start, end);
      const settingsTypes = new Set(["analytics-report", "events-report", "calving-report", "milking-report"]);
      let dateSelection = settingsTypes.has(source.type)
        ? await configureReportPeriod(page, effectivePeriod, source, jsonResponses)
        : effectivePeriod && source.type !== "monitor"
          ? await trySetDates(page, effectivePeriod.start, effectivePeriod.end)
          : { applied: false, method: "not-required" };
      if (dateSelection.applied && !dateSelection.settingsSaved
        && settingsMutationConfirmsPeriod(jsonResponses, source.type, effectivePeriod)) {
        const { error: _ignoredError, ...confirmedSelection } = dateSelection;
        dateSelection = { ...confirmedSelection, settingsSaved: true, networkConfirmed: true };
      }
      const tablePeriodRequired = Boolean(effectivePeriod) && (
        source.settingsArea === "table" || ["events-report", "calving-report", "milking-report"].includes(source.type)
      );
      if (tablePeriodRequired && (!dateSelection.applied || !dateSelection.settingsSaved)) {
        if (source.periodFailurePolicy === "use-current-table" && await closeTableSettings(page)) {
          const message = `Период ${effectivePeriod.start}–${effectivePeriod.end} не применён; использована текущая рассчитанная таблица.`;
          result.warnings.push({ source: source.id, message });
          dateSelection = { ...dateSelection, fallbackUsed: true, fallback: "current-table", warning: message };
        } else {
          const siteError = settingsMutationError(jsonResponses, source.type);
          throw new Error(
            `Не удалось применить период ${effectivePeriod.start}–${effectivePeriod.end} в настройках таблицы: `
            + `${siteError || dateSelection.error || dateSelection.method || "неизвестная ошибка"}`
            + `${dateSelection.mismatches ? `; ${JSON.stringify(dateSelection.mismatches)}` : ""}`
          );
        }
      }
      const action = source.action === "none" || source.type === "monitor"
        ? { clicked: false, label: "not-required" }
        : shouldUseExistingTable(source, dateSelection)
          ? { clicked: false, label: "current-table-fallback" }
        : dateSelection.settingsSaved && !source.refreshAfterSettings
        ? { clicked: true, label: "table-settings-saved" }
        : await clickReportAction(page, source.type);
      if (dateSelection.settingsSaved && source.waitAfterSettingsMs) {
        await page.waitForTimeout(source.waitAfterSettingsMs);
      }
      const expectedOperation = source.type === "custom-report"
        ? "launchCustomReport"
        : source.type === "blueprint"
          ? "launchBlueprint"
          : source.type === "livestock-forecast"
            ? "livestockForecastMonths"
            : source.type === "analytics-report"
              ? "reproductionHdrAndPrReportsDetailed"
              : source.type === "events-report"
                ? "customEventsReportsDetailed"
                : source.type === "calving-report"
                  ? "calvingEventsReportsDetailed"
                  : source.type === "milking-report"
                    ? "customMilkingReportsDetailed"
                    : null;
      if (expectedOperation) await waitForResponseOperation(page, jsonResponses, expectedOperation);
      if (["analytics-report", "events-report", "calving-report", "milking-report"].includes(source.type)) {
        await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      }
      const snapshot = await visibleSnapshot(page);
      const visibleMetrics = Object.fromEntries((source.metrics || []).map((name) => [name, findMetric(snapshot, name)]));
      let extractionMethod = "graphql";
      let structured = source.type === "monitor"
        ? { metrics: extractMonitor(jsonResponses, source.metrics || [], {
            start,
            end,
            selection: source.metricSelection
          }) }
        : source.type === "custom-report"
          ? extractCustomReport(jsonResponses, source)
          : source.type === "blueprint"
            ? extractBlueprint(jsonResponses, source)
            : source.type === "livestock-forecast"
            ? extractLivestockForecast(jsonResponses, source, end)
            : source.type === "analytics-report"
              ? extractHdrPrFromResponses(jsonResponses, source, end)
              : source.type === "milking-report"
                ? extractMilkingFromResponses(jsonResponses, source, effectivePeriod)
                : source.type === "events-report" || source.type === "calving-report"
                  ? extractEventsFromResponses(jsonResponses, source)
                  : null;
      if (!structured && source.type === "analytics-report") {
        extractionMethod = "dom-fallback";
        structured = extractHdrPr(snapshot, end);
      }
      if (!structured && (source.type === "events-report" || source.type === "calving-report")) {
        extractionMethod = "dom-fallback";
        structured = extractEvents(snapshot, source.transfer, {
          rowSelection: source.rowSelection,
          rowLimit: source.rowLimit
        });
      }
      if (!structured && source.type === "milking-report") {
        extractionMethod = "dom-fallback";
        structured = extractEvents(snapshot, source.transfer, {
                    rowSelection: source.rowSelection,
                    rowLimit: source.rowLimit
        });
      }
      if (["events-report", "calving-report", "milking-report"].includes(source.type) && !structured) {
        throw new Error("Таблица данных не получена после обновления отчёта.");
      }
      const metrics = structured?.metrics || visibleMetrics;
      const sourceResult = {
        id: source.id,
        type: source.type,
        requestedUrl: source.url,
        finalUrl: page.url(),
        effectivePeriod,
        dateSelection,
        action,
        extractionMethod,
        metrics,
        structuredSummary: structured ? {
          rowCount: structured.rows?.length ?? structured.rowsCount ?? null,
          columnCount: structured.columns?.length ?? structured.dataRowColumns?.length ?? null,
          hashID: structured.hashID ?? null,
          selected: structured.selected ?? null
        } : null,
        tableCount: snapshot.tables.length,
        jsonResponseCount: jsonResponses.length,
        snapshotFile: `${source.id}.json`
      };
      await fs.writeFile(path.join(runDir, `${safeName(source.id)}.json`), JSON.stringify({ source: sourceResult, structured, snapshot, jsonResponses }, null, 2), "utf8");
      result.sources.push(sourceResult);
      onProgress({ source: source.id, status: "done" });
    } catch (error) {
      if (signal?.aborted) {
        result.cancelled = true;
        onProgress({ source: source.id, status: "cancelled" });
        break;
      }
      const diagnosticFile = `${safeName(source.id)}-error.json`;
      let snapshot = null;
      try {
        snapshot = await visibleSnapshot(page);
      } catch {
        // Страница могла закрыться из-за сетевой ошибки; ответы GraphQL всё равно сохраняем.
      }
      await fs.writeFile(path.join(runDir, diagnosticFile), JSON.stringify({
        source: {
          id: source.id,
          type: source.type,
          requestedUrl: source.url,
          finalUrl: page.url(),
          error: error.message
        },
        snapshot,
        jsonResponses
      }, null, 2), "utf8").catch(() => {});
      const item = { source: source.id, message: error.message, diagnosticFile };
      result.errors.push(item);
      onProgress({ source: source.id, status: "error", message: error.message });
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
      await page.close().catch(() => {});
    }
  }

  if (signal?.aborted) result.cancelled = true;

  const reportData = {
    farmId: result.farmId,
    period: { start: result.start, end: result.end },
    generatedAt: result.createdAt,
    cancelled: result.cancelled,
    metrics: Object.assign({}, ...result.sources.map((source) => source.metrics || {})),
    sources: result.sources.map((source) => ({
      id: source.id,
      type: source.type,
      rowCount: source.structuredSummary?.rowCount ?? null,
      columnCount: source.structuredSummary?.columnCount ?? null,
      file: source.snapshotFile
    })),
    errors: result.errors
  };
  await fs.writeFile(path.join(runDir, "report-data.json"), JSON.stringify(reportData, null, 2), "utf8");
  await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(result, null, 2), "utf8");
  return { ...result, outputDirectory: runDir };
}
