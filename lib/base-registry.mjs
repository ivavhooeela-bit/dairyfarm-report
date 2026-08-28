import fs from "node:fs/promises";
import path from "node:path";

export const SOURCE_LABELS = {
  monitor: "Показатели (monitor)",
  "hdr-pr": "HDR и PR",
  "weekly-events": "События по дням недели",
  "sheet2-events-5303": "Стельность / дни с осеменения",
  "sheet2-events-5304": "Сухостой / дни с осеменения",
  "first-insemination": "1-е ИО",
  "second-insemination": "2-е ИО",
  "calving-result": "Результат отёла",
  "calf-retirement-6-months": "Выбытие телят до 6 месяцев",
  "retirement-60-days-year": "Выбытие до 60 дней за год",
  "retirement-60-days-milking": "Выбытие до 60 дней в доении",
  "milk-deviation": "Отклонение от надоев",
  "youngstock-survival": "Сохранность молодняка",
  "livestock-forecast-milk": "Дойные коровы и надой",
  "livestock-forecast-herd": "Поголовье",
  "missed-insemination": "Пропущенные животные с ИО",
  "missed-ultrasound": "Пропущенные животные с УЗИ",
  "missed-dry-off": "Пропущенные на запуск"
};

function registryPath(rootDir) {
  return path.join(rootDir, "config", "bases.json");
}

export function normalizeDairyFarmLink(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new URL(text, "https://www.dairyfarm.dev");
  if (!/^(www\.)?dairyfarm\.dev$/i.test(parsed.hostname)) {
    throw new Error(`Ссылка должна вести на dairyfarm.dev: ${text}`);
  }
  return `https://www.dairyfarm.dev${parsed.pathname}${parsed.search}`;
}

export function collectorPathFromLink(value) {
  const normalized = normalizeDairyFarmLink(value);
  if (!normalized) return "";
  const parsed = new URL(normalized);
  return `${parsed.pathname}${parsed.search}`;
}

export function normalizeBase(base, sourceIds) {
  const id = Number(base?.id ?? base?.farmId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Некорректный ID базы");
  const name = String(base?.name || "").trim();
  if (!name) throw new Error(`Не указано название базы ${id}`);
  if (name.length > 100) throw new Error(`Название базы ${id} длиннее 100 символов`);
  const inputLinks = base?.links && typeof base.links === "object" ? base.links : {};
  const links = Object.fromEntries(sourceIds.map((sourceId) => [
    sourceId,
    normalizeDairyFarmLink(inputLinks[sourceId])
  ]));
  return { id, name, enabled: base?.enabled !== false, links };
}

export function validateRegistry(value, sourceIds) {
  const bases = Array.isArray(value) ? value : value?.bases;
  if (!Array.isArray(bases)) throw new Error("В конфигурации отсутствует массив bases");
  const normalized = bases.map((base) => normalizeBase(base, sourceIds));
  const ids = new Set();
  for (const base of normalized) {
    if (ids.has(base.id)) throw new Error(`ID базы ${base.id} повторяется`);
    ids.add(base.id);
  }
  return { version: 1, bases: normalized };
}

export function missingLinks(base, sourceIds) {
  return sourceIds.filter((sourceId) => !base?.links?.[sourceId]);
}

export async function readRegistry(rootDir, sourceIds) {
  const text = await fs.readFile(registryPath(rootDir), "utf8");
  return validateRegistry(JSON.parse(text), sourceIds);
}

export async function writeRegistry(rootDir, value, sourceIds, { backup = false } = {}) {
  const normalized = validateRegistry(value, sourceIds);
  const target = registryPath(rootDir);
  if (backup) {
    try {
      const current = await fs.readFile(target);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.writeFile(path.join(path.dirname(target), `bases.backup-${stamp}.json`), current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.writeFile(target, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function configForBase(template, base) {
  const sourceIds = template.sources.map((source) => source.id);
  const missing = missingLinks(base, sourceIds);
  return {
    ...template,
    farmId: base.id,
    name: base.name,
    sources: template.sources
      .filter((source) => base.links[source.id])
      .map((source) => ({
        ...source,
        url: collectorPathFromLink(base.links[source.id])
      })),
    configurationErrors: missing.map((sourceId) => ({
      source: sourceId,
      message: `Не заполнена ссылка «${SOURCE_LABELS[sourceId] || sourceId}». Источник пропущен.`
    }))
  };
}

export function registryForClient(registry, sourceIds) {
  return {
    ...registry,
    sources: sourceIds.map((id) => ({ id, label: SOURCE_LABELS[id] || id })),
    bases: registry.bases.map((base) => ({
      ...base,
      missingLinks: missingLinks(base, sourceIds)
    }))
  };
}
