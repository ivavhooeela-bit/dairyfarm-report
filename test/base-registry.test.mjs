import test from "node:test";
import assert from "node:assert/strict";

import {
  collectorPathFromLink,
  configForBase,
  normalizeBase,
  normalizeDairyFarmLink,
  validateRegistry
} from "../lib/base-registry.mjs";

const sourceIds = ["monitor", "hdr-pr"];

test("DairyFarm links are normalized and retain query parameters", () => {
  assert.equal(
    normalizeDairyFarmLink("/2468/user/analytics/livestock-forecast?farmId=null"),
    "https://www.dairyfarm.dev/2468/user/analytics/livestock-forecast?farmId=null"
  );
  assert.equal(
    collectorPathFromLink("https://www.dairyfarm.dev/2468/user/analytics/monitor"),
    "/2468/user/analytics/monitor"
  );
  assert.throws(() => normalizeDairyFarmLink("https://example.com/report"), /dairyfarm\.dev/);
});

test("base registry rejects duplicate IDs", () => {
  const base = {
    id: 2468,
    name: "Тестовая база",
    links: { monitor: "/2468/monitor", "hdr-pr": "/2468/hdr" }
  };
  assert.throws(() => validateRegistry({ bases: [base, base] }, sourceIds), /повторяется/);
});

test("a base keeps its own report links when building collector config", () => {
  const base = normalizeBase({
    id: 2468,
    name: "Тестовая база",
    links: {
      monitor: "https://www.dairyfarm.dev/2468/user/analytics/monitor",
      "hdr-pr": "https://www.dairyfarm.dev/2468/user/analytics/reproduction/custom_999"
    }
  }, sourceIds);
  const template = {
    farmId: 1369,
    sources: [
      { id: "monitor", url: "/1369/old-monitor" },
      { id: "hdr-pr", url: "/1369/old-hdr" }
    ]
  };
  const config = configForBase(template, base);
  assert.equal(config.farmId, 2468);
  assert.equal(config.name, "Тестовая база");
  assert.equal(config.sources[0].url, "/2468/user/analytics/monitor");
  assert.equal(config.sources[1].url, "/2468/user/analytics/reproduction/custom_999");
  assert.deepEqual(config.configurationErrors, []);
});

test("a base with missing links keeps collecting configured sources", () => {
  const base = normalizeBase({
    id: 2468,
    name: "Неполная база",
    links: { monitor: "https://www.dairyfarm.dev/2468/user/analytics/monitor" }
  }, sourceIds);
  const template = {
    sources: [
      { id: "monitor", type: "monitor", url: "/old-monitor" },
      { id: "hdr-pr", type: "analytics-report", url: "/old-hdr" }
    ]
  };

  const config = configForBase(template, base);

  assert.deepEqual(config.sources.map(({ id }) => id), ["monitor"]);
  assert.deepEqual(config.configurationErrors, [{
    source: "hdr-pr",
    message: "Не заполнена ссылка «HDR и PR». Источник пропущен."
  }]);
});
