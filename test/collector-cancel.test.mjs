import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectReport } from "../lib/collector.mjs";

test("an already cancelled collection does not open a page and writes a partial summary", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dairyfarm-cancel-"));
  const controller = new AbortController();
  controller.abort();
  let pagesOpened = 0;
  try {
    const result = await collectReport({
      context: { async newPage() { pagesOpened += 1; throw new Error("should not open"); } },
      config: { farmId: 2468, sources: [{ id: "monitor", type: "monitor", url: "/2468/monitor" }] },
      start: "2026-08-17",
      end: "2026-08-23",
      outputDir,
      signal: controller.signal
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.sources.length, 0);
    assert.equal(pagesOpened, 0);
    const summary = JSON.parse(await fs.readFile(path.join(result.outputDirectory, "summary.json"), "utf8"));
    assert.equal(summary.cancelled, true);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("configuration errors are logged while a partial report is still created", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "dairyfarm-partial-"));
  let pagesOpened = 0;
  try {
    const result = await collectReport({
      context: { async newPage() { pagesOpened += 1; throw new Error("should not open"); } },
      config: {
        farmId: 2468,
        sources: [],
        configurationErrors: [{ source: "hdr-pr", message: "Не заполнена ссылка. Источник пропущен." }]
      },
      start: "2026-08-20",
      end: "2026-08-26",
      outputDir
    });

    assert.equal(pagesOpened, 0);
    assert.equal(result.cancelled, false);
    assert.deepEqual(result.errors, [{ source: "hdr-pr", message: "Не заполнена ссылка. Источник пропущен." }]);
    const reportData = JSON.parse(await fs.readFile(path.join(result.outputDirectory, "report-data.json"), "utf8"));
    assert.deepEqual(reportData.errors, result.errors);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
