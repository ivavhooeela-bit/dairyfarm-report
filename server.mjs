import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { collectReport } from "./lib/collector.mjs";
import { defaultPeriod, validatePeriod } from "./lib/dates.mjs";
import { sanitizeReportName } from "./lib/workbook-data.mjs";
import {
  configForBase,
  normalizeBase,
  readRegistry,
  registryForClient,
  validateRegistry,
  writeRegistry
} from "./lib/base-registry.mjs";
import { writeWorkbook } from "./.artifact-work/workbook-writer.mjs";
import { createGoogleAuthStore } from "./lib/google-auth.mjs";
import { createGooglePresentation, loadCollectedReport } from "./lib/google-presentations.mjs";
import { createBrowserContextManager } from "./lib/browser-context-manager.mjs";
import { loadWorkbookReport } from "./lib/workbook-report.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.join(root, ".browser-profile");
const outputDir = path.join(root, "outputs");
const editedWorkbookDir = path.join(root, ".local", "edited-workbooks");
const port = Number(process.env.DAIRYFARM_REPORT_PORT || 8787);
const appVersion = "1.9.1";
const googleAuth = createGoogleAuthStore(root, { port });
let activeRun = null;
let lastRun = null;

async function installedBrowserPath() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || programFiles;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData && path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Проверяем следующий установленный браузер.
    }
  }
  throw new Error("Microsoft Edge or Google Chrome was not found.");
}

const browserContexts = createBrowserContextManager(async () =>
  chromium.launchPersistentContext(profileDir, {
      executablePath: await installedBrowserPath(),
      headless: false,
      viewport: { width: 1440, height: 900 }
  })
);

async function context() {
  return browserContexts.get();
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Запрос слишком большой");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function binaryBody(request, limit = 25_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Файл Excel превышает допустимый размер 25 МБ");
    chunks.push(chunk);
  }
  if (!size) throw new Error("Выберите непустой файл Excel");
  return Buffer.concat(chunks);
}

async function templateConfig() {
  return JSON.parse(await fs.readFile(path.join(root, "config", "1369.json"), "utf8"));
}

async function registryContext() {
  const template = await templateConfig();
  const sourceIds = template.sources.map((source) => source.id);
  const registry = await readRegistry(root, sourceIds);
  return { template, sourceIds, registry };
}

async function workbookMappingConfig() {
  return JSON.parse(await fs.readFile(path.join(root, "config", "workbook-mapping.json"), "utf8"));
}

async function presentationMappingConfig() {
  return JSON.parse(await fs.readFile(path.join(root, "config", "presentation-mapping.json"), "utf8"));
}

async function fileInfo(filePath, source) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? { path: filePath, source, updatedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function latestCollectedWorkbook(farmId) {
  let directories = [];
  try {
    directories = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const prefix = `${farmId}-`;
  const candidates = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.startsWith(prefix)) continue;
    const runDir = path.join(outputDir, directory.name);
    let files = [];
    try { files = await fs.readdir(runDir); } catch { continue; }
    for (const file of files) {
      if (!file.toLocaleLowerCase("ru-RU").endsWith("-данные.xlsx")) continue;
      const info = await fileInfo(path.join(runDir, file), "collected");
      if (info) candidates.push(info);
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

async function preferredWorkbook(farmId) {
  const uploaded = await fileInfo(path.join(editedWorkbookDir, `${farmId}.xlsx`), "uploaded");
  const collected = await latestCollectedWorkbook(farmId);
  return [uploaded, collected].filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

async function workbookStatuses(bases) {
  const entries = await Promise.all(bases.map(async (base) => {
    const workbook = await preferredWorkbook(base.id);
    return [base.id, workbook ? {
      available: true,
      source: workbook.source,
      updatedAt: workbook.updatedAt,
      downloadUrl: `/api/base-workbook/download?farmId=${base.id}`
    } : { available: false }];
  }));
  return Object.fromEntries(entries);
}

function publicRunState(run) {
  if (!run) return { active: false, ...(lastRun || {}) };
  return {
    active: true,
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    currentBase: run.currentBase,
    currentSource: run.currentSource,
    completed: run.completed,
    errors: run.errors,
    stopRequested: run.stopRequested
  };
}

function downloadDetails(result, workbook) {
  const run = encodeURIComponent(path.basename(result.outputDirectory));
  return {
    downloadUrl: `/api/download?run=${run}&file=${encodeURIComponent(workbook.fileName)}`,
    logDownloadUrl: `/api/download?run=${run}&file=${encodeURIComponent(workbook.logFileName)}`
  };
}

async function executeSelectedBases({ bases, template, period, controller, run }) {
  const results = [];
  for (const base of bases) {
    if (controller.signal.aborted) break;
    run.currentBase = { id: base.id, name: base.name };
    run.currentSource = null;
    run.status = "collecting";
    try {
      sanitizeReportName(base.name);
      const config = configForBase(template, base);
      const result = await collectReport({
        context: await context(),
        config,
        ...period,
        outputDir,
        signal: controller.signal,
        onProgress: ({ source, status, message }) => {
          run.currentSource = { id: source, status, message: message || null };
          console.log(`[${base.id}] [${status}] ${source}`);
        }
      });
      const cancellationWarnings = result.cancelled
        ? [...result.warnings, { source: "run", message: "Выгрузка остановлена пользователем; сохранены уже собранные данные." }]
        : result.warnings;
      run.status = "writing";
      const workbook = await writeWorkbook({
        rootDir: root,
        runDir: result.outputDirectory,
        reportName: base.name,
        farmId: base.id,
        collectionErrors: result.errors,
        collectionWarnings: cancellationWarnings,
        ...period
      });
      const item = {
        farmId: base.id,
        baseName: base.name,
        ...result,
        ...workbook,
        ...downloadDetails(result, workbook)
      };
      results.push(item);
      run.completed.push({
        farmId: base.id,
        baseName: base.name,
        cancelled: result.cancelled,
        sources: result.sources.length,
        errors: result.errors.length
      });
    } catch (error) {
      const item = { farmId: base.id, baseName: base.name, message: error.message };
      run.errors.push(item);
      if (controller.signal.aborted) break;
    }
  }
  return results;
}

async function executeSelectedPresentations({ bases, template, presentationMapping, period, controller, run }) {
  const results = [];
  for (const base of bases) {
    if (controller.signal.aborted) break;
    run.currentBase = { id: base.id, name: base.name };
    run.currentSource = null;
    run.status = "collecting";
    try {
      sanitizeReportName(base.name);
      const config = configForBase(template, base);
      const collected = await collectReport({
        context: await context(),
        config,
        ...period,
        outputDir,
        signal: controller.signal,
        onProgress: ({ source, status, message }) => {
          run.currentSource = { id: source, status, message: message || null };
          console.log(`[${base.id}] [${status}] ${source}`);
        }
      });
      if (collected.cancelled || controller.signal.aborted) break;
      run.status = "presenting";
      run.currentSource = { id: "google-slides", status: "creating", message: "Создаю копию шаблона" };
      const report = await loadCollectedReport(collected.outputDirectory);
      const presentation = await createGooglePresentation({
        accessToken: await googleAuth.accessToken(),
        mapping: presentationMapping,
        report,
        reportName: base.name,
        baseName: base.name,
        farmId: base.id,
        ...period
      });
      const item = { farmId: base.id, baseName: base.name, ...collected, presentation };
      results.push(item);
      run.completed.push({
        farmId: base.id,
        baseName: base.name,
        sources: collected.sources.length,
        errors: collected.errors.length,
        presentationUrl: presentation.url
      });
    } catch (error) {
      run.errors.push({ farmId: base.id, baseName: base.name, message: error.message });
      if (controller.signal.aborted) break;
    }
  }
  return results;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/defaults") {
      return json(response, 200, { appVersion, ...defaultPeriod() });
    }
    if (request.method === "GET" && url.pathname === "/api/bases") {
      const { registry, sourceIds } = await registryContext();
      return json(response, 200, registryForClient(registry, sourceIds));
    }
    if (request.method === "GET" && url.pathname === "/api/base-workbooks") {
      const { registry } = await registryContext();
      return json(response, 200, { workbooks: await workbookStatuses(registry.bases) });
    }
    if (request.method === "POST" && url.pathname === "/api/base-workbook/upload") {
      if (activeRun) return json(response, 409, { error: "Дождитесь завершения текущей операции" });
      const farmId = Number(url.searchParams.get("farmId"));
      const { registry } = await registryContext();
      const base = registry.bases.find((item) => item.id === farmId);
      if (!base) throw new Error(`База ${farmId || ""} не найдена`);
      const contents = await binaryBody(request);
      await loadWorkbookReport(contents, await workbookMappingConfig(), { farmId, fallbackName: base.name });
      await fs.mkdir(editedWorkbookDir, { recursive: true });
      await fs.writeFile(path.join(editedWorkbookDir, `${farmId}.xlsx`), contents);
      const workbook = await preferredWorkbook(farmId);
      return json(response, 200, {
        ok: true,
        farmId,
        workbook: { available: true, source: workbook.source, updatedAt: workbook.updatedAt, downloadUrl: `/api/base-workbook/download?farmId=${farmId}` }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/base-workbook/download") {
      const farmId = Number(url.searchParams.get("farmId"));
      const { registry } = await registryContext();
      const base = registry.bases.find((item) => item.id === farmId);
      if (!base) throw new Error(`База ${farmId || ""} не найдена`);
      const workbook = await preferredWorkbook(farmId);
      if (!workbook) throw new Error("Для этой базы ещё нет подготовленного Excel");
      const contents = await fs.readFile(workbook.path);
      const fileName = `${sanitizeReportName(base.name)}-${farmId}-для-правок.xlsx`;
      response.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      });
      return response.end(contents);
    }
    if (request.method === "GET" && url.pathname === "/api/google/status") {
      return json(response, 200, await googleAuth.status());
    }
    if (request.method === "POST" && url.pathname === "/api/google/oauth/import") {
      return json(response, 200, await googleAuth.importClient(await body(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/google/connect") {
      return json(response, 200, await googleAuth.beginAuthorization());
    }
    if (request.method === "POST" && url.pathname === "/api/google/disconnect") {
      return json(response, 200, await googleAuth.disconnect());
    }
    if (request.method === "GET" && url.pathname === "/api/google/oauth/callback") {
      try {
        await googleAuth.handleCallback({
          state: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
          error: url.searchParams.get("error")
        });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end("<!doctype html><meta charset=\"utf-8\"><title>Google подключён</title><style>body{font:18px Arial;padding:40px;color:#2a1b81}strong{color:#111}</style><strong>Google подключён.</strong><p>Вернитесь в DairyFarm Report — это окно можно закрыть.</p><script>setTimeout(()=>window.close(),1800)</script>");
      } catch (error) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        return response.end(`<!doctype html><meta charset="utf-8"><title>Ошибка Google</title><style>body{font:18px Arial;padding:40px;color:#8b2020}</style><strong>Подключение не выполнено.</strong><p>${String(error.message).replace(/[&<>"']/g, "")}</p>`);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/google/test") {
      const mapping = await presentationMappingConfig();
      const accessToken = await googleAuth.accessToken();
      const presentationId = mapping.template.presentationId;
      const check = await fetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}?fields=presentationId,title,slides(objectId)`, {
        headers: { authorization: `Bearer ${accessToken}` }
      });
      const data = await check.json();
      if (!check.ok) throw new Error(data?.error?.message || "Не удалось открыть шаблон Google Slides");
      return json(response, 200, { ok: true, title: data.title, slides: data.slides?.length || 0 });
    }
    if (request.method === "POST" && url.pathname === "/api/google/presentations/from-workbook") {
      if (activeRun) return json(response, 409, { error: "Другая операция уже выполняется" });
      const googleStatus = await googleAuth.status();
      if (!googleStatus.connected) throw new Error("Сначала подключите Google в разделе «Настройки»");
      const input = await body(request);
      const farmId = Number(input.farmId);
      const { registry } = await registryContext();
      const base = registry.bases.find((item) => item.id === farmId);
      if (!base) throw new Error(`База ${farmId || ""} не найдена`);
      const workbook = await preferredWorkbook(farmId);
      if (!workbook) throw new Error("Сначала соберите Excel или загрузите исправленный файл для этой базы");
      const controller = new AbortController();
      const run = {
        runId: `slides-workbook-${farmId}-${Date.now()}`,
        controller,
        outputKind: "google-slides-from-workbook",
        status: "presenting",
        startedAt: new Date().toISOString(),
        currentBase: { id: base.id, name: base.name },
        currentSource: { id: "excel", status: "reading", message: "Читаю исправленный Excel" },
        completed: [],
        errors: [],
        stopRequested: false
      };
      activeRun = run;
      try {
        const imported = await loadWorkbookReport(workbook.path, await workbookMappingConfig(), { farmId, fallbackName: base.name });
        run.currentSource = { id: "google-slides", status: "creating", message: "Создаю презентацию из Excel" };
        const presentation = await createGooglePresentation({
          accessToken: await googleAuth.accessToken(),
          mapping: await presentationMappingConfig(),
          report: imported.report,
          reportName: imported.reportName,
          baseName: base.name,
          farmId,
          start: imported.start,
          end: imported.end
        });
        const item = { farmId, baseName: base.name, workbookSource: workbook.source, presentation, errors: [] };
        run.completed.push({ farmId, baseName: base.name, presentationUrl: presentation.url });
        lastRun = {
          runId: run.runId,
          outputKind: run.outputKind,
          status: "completed",
          finishedAt: new Date().toISOString(),
          completed: run.completed,
          errors: []
        };
        return json(response, 200, { runId: run.runId, cancelled: false, results: [item], errors: [] });
      } catch (error) {
        run.errors.push({ farmId, baseName: base.name, message: error.message });
        throw error;
      } finally {
        activeRun = null;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/google/presentations/run") {
      if (activeRun) return json(response, 409, { error: "Другая выгрузка уже выполняется" });
      const googleStatus = await googleAuth.status();
      if (!googleStatus.connected) throw new Error("Сначала подключите Google");
      const input = await body(request);
      const period = validatePeriod(input.start, input.end);
      const { registry, template } = await registryContext();
      const selectedIds = [...new Set((input.farmIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (!selectedIds.length) throw new Error("Выберите хотя бы одну базу");
      const bases = selectedIds.map((id) => registry.bases.find((base) => base.id === id));
      const missingBases = selectedIds.filter((_, index) => !bases[index]);
      if (missingBases.length) throw new Error(`Базы не найдены в конфигурации: ${missingBases.join(", ")}`);
      const presentationMapping = await presentationMappingConfig();
      const controller = new AbortController();
      const run = {
        runId: `slides-${Date.now()}`,
        controller,
        outputKind: "google-slides",
        status: "starting",
        startedAt: new Date().toISOString(),
        currentBase: null,
        currentSource: null,
        completed: [],
        errors: [],
        stopRequested: false
      };
      activeRun = run;
      try {
        const results = await executeSelectedPresentations({ bases, template, presentationMapping, period, controller, run });
        const responseValue = { runId: run.runId, cancelled: controller.signal.aborted, results, errors: run.errors };
        lastRun = {
          runId: run.runId,
          outputKind: "google-slides",
          status: controller.signal.aborted ? "cancelled" : "completed",
          finishedAt: new Date().toISOString(),
          completed: run.completed,
          errors: run.errors
        };
        return json(response, 200, responseValue);
      } finally {
        activeRun = null;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/bases") {
      const input = await body(request);
      const { registry, sourceIds } = await registryContext();
      const base = normalizeBase(input.base, sourceIds);
      const index = registry.bases.findIndex((item) => item.id === base.id);
      if (index >= 0) registry.bases[index] = base;
      else registry.bases.push(base);
      const saved = await writeRegistry(root, registry, sourceIds);
      return json(response, 200, registryForClient(saved, sourceIds));
    }
    if (request.method === "POST" && url.pathname === "/api/bases/delete") {
      const input = await body(request);
      const id = Number(input.id);
      const { registry, sourceIds } = await registryContext();
      const bases = registry.bases.filter((base) => base.id !== id);
      if (bases.length === registry.bases.length) throw new Error(`База ${id} не найдена`);
      const saved = await writeRegistry(root, { ...registry, bases }, sourceIds);
      return json(response, 200, registryForClient(saved, sourceIds));
    }
    if (request.method === "POST" && url.pathname === "/api/bases/selection") {
      const input = await body(request);
      const selected = new Set((input.farmIds || []).map(Number));
      const { registry, sourceIds } = await registryContext();
      registry.bases = registry.bases.map((base) => ({ ...base, enabled: selected.has(base.id) }));
      const saved = await writeRegistry(root, registry, sourceIds);
      return json(response, 200, registryForClient(saved, sourceIds));
    }
    if (request.method === "GET" && url.pathname === "/api/config/export") {
      const { registry } = await registryContext();
      const contents = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "attachment; filename*=UTF-8''dairyfarm-bases.json"
      });
      return response.end(contents);
    }
    if (request.method === "POST" && url.pathname === "/api/config/import") {
      const input = await body(request);
      const { sourceIds } = await registryContext();
      const checked = validateRegistry(input, sourceIds);
      const saved = await writeRegistry(root, checked, sourceIds, { backup: true });
      return json(response, 200, registryForClient(saved, sourceIds));
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const ctx = await context();
      const pages = ctx.pages();
      const page = pages[0] || await ctx.newPage();
      await page.goto("https://www.dairyfarm.dev/login", { waitUntil: "domcontentloaded" });
      return json(response, 200, { ok: true, message: "Войдите в DairyFarm в открывшемся окне." });
    }
    if (request.method === "GET" && url.pathname === "/api/run/status") {
      return json(response, 200, publicRunState(activeRun));
    }
    if (request.method === "POST" && url.pathname === "/api/stop") {
      if (!activeRun) return json(response, 200, { ok: true, message: "Активной выгрузки нет." });
      activeRun.stopRequested = true;
      activeRun.status = "stopping";
      activeRun.controller.abort();
      return json(response, 200, { ok: true, message: "Останавливаю выгрузку и сохраняю собранные данные…" });
    }
    if (request.method === "POST" && url.pathname === "/api/run") {
      if (activeRun) return json(response, 409, { error: "Другая выгрузка уже выполняется" });
      const input = await body(request);
      const period = validatePeriod(input.start, input.end);
      const { registry, template } = await registryContext();
      const requestedIds = Array.isArray(input.farmIds)
        ? input.farmIds.map(Number)
        : input.farmId ? [Number(input.farmId)] : registry.bases.filter((base) => base.enabled).map((base) => base.id);
      const selectedIds = [...new Set(requestedIds.filter((id) => Number.isInteger(id) && id > 0))];
      if (!selectedIds.length) throw new Error("Выберите хотя бы одну базу");
      const bases = selectedIds.map((id) => registry.bases.find((base) => base.id === id));
      const missingBases = selectedIds.filter((_, index) => !bases[index]);
      if (missingBases.length) throw new Error(`Базы не найдены в конфигурации: ${missingBases.join(", ")}`);
      const controller = new AbortController();
      const run = {
        runId: `multi-${Date.now()}`,
        controller,
        status: "starting",
        startedAt: new Date().toISOString(),
        currentBase: null,
        currentSource: null,
        completed: [],
        errors: [],
        stopRequested: false
      };
      activeRun = run;
      try {
        const results = await executeSelectedBases({ bases, template, period, controller, run });
        const responseValue = {
          runId: run.runId,
          cancelled: controller.signal.aborted,
          results,
          errors: run.errors
        };
        lastRun = {
          runId: run.runId,
          status: controller.signal.aborted ? "cancelled" : "completed",
          finishedAt: new Date().toISOString(),
          completed: run.completed,
          errors: run.errors
        };
        return json(response, 200, responseValue);
      } finally {
        activeRun = null;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/download") {
      const run = url.searchParams.get("run") || "";
      const file = url.searchParams.get("file") || "";
      if (!/^[a-zA-Z0-9._-]+$/.test(run) || path.basename(file) !== file || !/\.(xlsx|txt)$/i.test(file)) {
        throw new Error("Некорректный путь к отчёту");
      }
      const contents = await fs.readFile(path.join(outputDir, run, file));
      response.writeHead(200, {
        "content-type": file.toLowerCase().endsWith(".xlsx")
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}`
      });
      return response.end(contents);
    }
    if (request.method === "GET" && ["/dfs-logo.png", "/dfs-pattern-yellow.png"].includes(url.pathname)) {
      const contents = await fs.readFile(path.join(root, "public", path.basename(url.pathname)));
      response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
      return response.end(contents);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await fs.readFile(path.join(root, "public", "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(html);
    }
    return json(response, 404, { error: "Не найдено" });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`DairyFarm Report: http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    activeRun?.controller.abort();
    await browserContexts.close();
    server.close(() => process.exit(0));
  });
}
