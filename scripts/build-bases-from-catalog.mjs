import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { createGoogleAuthStore } from "../lib/google-auth.mjs";
import { validateRegistry } from "../lib/base-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [catalogPath, outputPath = path.join(root, "outputs", `dairyfarm-bases-from-catalog-${new Date().toISOString().slice(0, 10)}.json`)] = process.argv.slice(2);
if (!catalogPath) throw new Error("Передайте путь к выгруженному каталогу .xlsx");

const reportLinkPattern = /ссылка\s+на\s+отч[её]т\s+(?:из|в)\s+арк/iu;
const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function hyperlink(cell) {
  const value = cell?.value;
  return value && typeof value === "object" && typeof value.hyperlink === "string" ? value.hyperlink.trim() : "";
}

function normalized(value) {
  return String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function spreadsheetId(url) {
  return String(url || "").match(/\/spreadsheets\/d\/([^/]+)/)?.[1] || "";
}

function farmIdFromLink(url) {
  const value = String(url || "").match(/dairyfarm\.dev\/(\d+)\//i)?.[1];
  return value ? Number(value) : null;
}

function sourceIdFor({ sheet, cell, url }) {
  const name = normalized(sheet);
  const address = String(cell || "").toUpperCase();
  if (/^1\s*-?\s*е\s+ио$/iu.test(name)) return "first-insemination";
  if (/^2\s*-?\s*е\s+ио$/iu.test(name)) return "second-insemination";
  if (name.includes("пропущ") && name.includes("запуск")) return "missed-dry-off";
  if (name.includes("пропущ") && /с\s+у(?:зи)?$/iu.test(name)) return "missed-ultrasound";
  if (name.includes("пропущ") && /с\s+и(?:о)?$/iu.test(name)) return "missed-insemination";
  if (name.includes("результат отела")) return "calving-result";
  if (name.includes("телят до 6 месяцев")) return "calf-retirement-6-months";
  if (name.includes("до 60") && name.includes("за год")) return "retirement-60-days-year";
  if (name.includes("до 60") && name.includes("доени")) return "retirement-60-days-milking";
  if (name.includes("сохранность молодняка")) return "youngstock-survival";
  if (/\/analytics\/monitor\/?(?:\?|$)/i.test(url)) return "monitor";
  if (/\/analytics\/reproduction\/hdr-and-pr\//i.test(url)) return "hdr-pr";
  if (/\/analytics\/events\/calvings\//i.test(url)) return "calving-result";
  if (/\/analytics\/milking\/by-herd\//i.test(url) || name.includes("отклонения надоя")) return "milk-deviation";
  if (/\/analytics\/custom-reports\//i.test(url)) return "youngstock-survival";
  if (/\/analytics\/livestock-forecast/i.test(url)) {
    if (name.includes("поголовье и вал")) return "livestock-forecast-herd";
    return "livestock-forecast-milk";
  }
  if (/\/blueprint\//i.test(url)) {
    return null;
  }
  if (/\/analytics\/events\/events\//i.test(url)) {
    if (name === "лист1") return "weekly-events";
    if (name === "лист2") return Number(address.match(/\d+/)?.[0] || 0) < 30 ? "sheet2-events-5303" : "sheet2-events-5304";
  }
  return null;
}

async function workbookFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

async function readCatalog(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets.find((item) => normalized(item.name) === "еженедельные отчеты");
  if (!sheet) throw new Error("В каталоге не найден лист «Еженедельные отчеты»");
  const headers = new Map();
  sheet.getRow(1).eachCell((cell, column) => headers.set(normalized(cell.value?.text || cell.value), column));
  const nameColumn = headers.get("название хозяйства");
  const finishedColumn = headers.get("окончены") || headers.get("окончено");
  const reportColumn = headers.get("ссылка на отчет");
  if (!nameColumn || !finishedColumn || !reportColumn) throw new Error("В каталоге не найдены требуемые столбцы");
  const selected = [];
  const withoutReport = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const name = String(sheet.getCell(row, nameColumn).text || "").trim();
    if (!name) continue;
    const finished = String(sheet.getCell(row, finishedColumn).text || "").trim();
    if (finished === "1") continue;
    const reportUrl = hyperlink(sheet.getCell(row, reportColumn));
    if (!reportUrl) withoutReport.push({ row, name, reason: "в каталоге отсутствует ссылка на отчёт" });
    else selected.push({ row, name, reportUrl, spreadsheetId: spreadsheetId(reportUrl) });
  }
  return { selected, withoutReport };
}

async function googleExport(accessToken, fileId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(xlsxMime)}`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    const data = await response.json().catch(() => ({}));
    lastError = new Error(data?.error?.message || `Google Drive API: HTTP ${response.status}`);
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 700));
  }
  throw lastError;
}

function linksFromReport(workbook) {
  const candidates = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => {
      const value = cell.value;
      const text = value && typeof value === "object" ? value.text : null;
      const url = hyperlink(cell);
      if (url && /dairyfarm\.dev/i.test(url) && (reportLinkPattern.test(String(text || "")) || /ссылка\s+на\s+отч[её]т/iu.test(String(text || "")))) {
        candidates.push({ sheet: sheet.name, cell: cell.address, url });
      }
    }));
  }
  const links = {};
  const warnings = [];
  for (const candidate of candidates) {
    const sourceId = sourceIdFor(candidate);
    if (!sourceId) {
      warnings.push(`Не сопоставлена ссылка ${candidate.sheet}!${candidate.cell}: ${candidate.url}`);
      continue;
    }
    if (links[sourceId] && links[sourceId] !== candidate.url) {
      warnings.push(`Для ${sourceId} найдены разные ссылки; сохранена первая`);
      continue;
    }
    links[sourceId] = candidate.url;
  }
  if (links["livestock-forecast-milk"] && !links["livestock-forecast-herd"]) links["livestock-forecast-herd"] = links["livestock-forecast-milk"];
  if (links["livestock-forecast-herd"] && !links["livestock-forecast-milk"]) links["livestock-forecast-milk"] = links["livestock-forecast-herd"];
  return { links, warnings, candidates };
}

function nameKey(value) {
  return normalized(value).replace(/[^a-zа-я0-9]+/giu, "");
}

function preferredFarmId(links) {
  const monitorId = farmIdFromLink(links.monitor);
  if (monitorId) return monitorId;
  const counts = new Map();
  for (const id of Object.values(links).map(farmIdFromLink).filter(Boolean)) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

async function main() {
  const template = JSON.parse(await fs.readFile(path.join(root, "config", "1369.json"), "utf8"));
  const sourceIds = template.sources.map((item) => item.id);
  const existingRegistry = JSON.parse(await fs.readFile(path.join(root, "config", "bases.json"), "utf8"));
  const existingNames = new Map((existingRegistry.bases || []).map((base) => [Number(base.id), nameKey(base.name)]));
  const catalog = await readCatalog(path.resolve(catalogPath));
  const accessToken = await createGoogleAuthStore(root, { port: Number(process.env.DAIRYFARM_REPORT_PORT || 8787) }).accessToken();
  const results = new Array(catalog.selected.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= catalog.selected.length) return;
      const item = catalog.selected[index];
      try {
        if (!item.spreadsheetId) throw new Error("некорректная ссылка Google Sheets");
        const workbook = await workbookFromBuffer(await googleExport(accessToken, item.spreadsheetId));
        const extracted = linksFromReport(workbook);
        const farmId = preferredFarmId(extracted.links);
        if (!farmId) throw new Error("в отчёте не найден ID базы DairyFarm");
        const foreign = [];
        const links = Object.fromEntries(sourceIds.map((sourceId) => {
          const link = extracted.links[sourceId] || "";
          const linkFarmId = farmIdFromLink(link);
          if (link && linkFarmId && linkFarmId !== farmId) {
            foreign.push(`${sourceId} → ID ${linkFarmId}`);
            return [sourceId, ""];
          }
          return [sourceId, link];
        }));
        const missing = sourceIds.filter((sourceId) => !links[sourceId]);
        const warnings = [...extracted.warnings];
        if (foreign.length) warnings.push(`Очищены ссылки на чужие базы: ${foreign.join(", ")}`);
        results[index] = { ok: true, row: item.row, base: { id: farmId, name: item.name, enabled: true, links }, missing, warnings };
      } catch (error) {
        results[index] = { ok: false, row: item.row, name: item.name, reportUrl: item.reportUrl, error: error.message };
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const grouped = new Map();
  for (const item of results.filter((value) => value?.ok)) {
    const group = grouped.get(item.base.id) || [];
    group.push(item);
    grouped.set(item.base.id, group);
  }
  const duplicates = [];
  const uniqueBases = [];
  for (const [id, group] of grouped) {
    const knownName = existingNames.get(id);
    const selected = knownName ? group.find((item) => nameKey(item.base.name) === knownName) || group[0] : group[0];
    uniqueBases.push(selected.base);
    for (const item of group) if (item !== selected) duplicates.push(`${item.base.name} → ID ${id}; сохранено «${selected.base.name}»`);
  }
  const registry = validateRegistry({ version: 1, bases: uniqueBases }, sourceIds);
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  const logPath = path.resolve(outputPath).replace(/\.json$/i, "-проверка.txt");
  const lines = [
    `Каталог: ${path.resolve(catalogPath)}`,
    `Незавершённых строк: ${catalog.selected.length + catalog.withoutReport.length}`,
    `Ссылок на отчёты: ${catalog.selected.length}`,
    `Баз добавлено в JSON: ${registry.bases.length}`,
    `Без ссылки на отчёт: ${catalog.withoutReport.length}`,
    `Ошибок чтения: ${results.filter((item) => item && !item.ok).length}`,
    `Баз с неполным набором ссылок: ${results.filter((item) => item?.ok && item.missing.length).length}`,
    "",
    ...catalog.withoutReport.map((item) => `[КАТАЛОГ, строка ${item.row}] ${item.name}: ${item.reason}`),
    ...results.filter((item) => item && !item.ok).map((item) => `[ОШИБКА, строка ${item.row}] ${item.name}: ${item.error}`),
    ...results.filter((item) => item?.ok && item.missing.length).map((item) => `[НЕПОЛНО, строка ${item.row}] ${item.base.name} (ID ${item.base.id}): ${item.missing.join(", ")}`),
    ...results.flatMap((item) => item?.ok ? item.warnings.map((warning) => `[ПРЕДУПРЕЖДЕНИЕ, строка ${item.row}] ${item.base.name}: ${warning}`) : []),
    ...(duplicates.length ? [`[ДУБЛИКАТЫ ID] ${duplicates.join("; ")}`] : [])
  ];
  await fs.writeFile(logPath, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  console.log(JSON.stringify({ outputPath: path.resolve(outputPath), logPath, bases: registry.bases.length, withoutReport: catalog.withoutReport.length, failed: results.filter((item) => item && !item.ok).length, incomplete: results.filter((item) => item?.ok && item.missing.length).length }, null, 2));
}

await main();
