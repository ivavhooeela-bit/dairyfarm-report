import test from "node:test";
import assert from "node:assert/strict";
import { extractMonitor } from "../lib/collector.mjs";

function monitorResponse(entries) {
  return [{
    request: { postData: { operationName: "monitor" } },
    body: { data: { monitor: { edges: entries.map((node) => ({ node })) } } }
  }];
}

test("monitor finds metrics by label regardless of row order and spacing", () => {
  const responses = monitorResponse([
    {
      name: "% Брака коровы",
      values: [{ value: 9, monitorLaunch: { happenedOn: "2026-08-19" } }]
    },
    {
      name: "Кол-во   коров в стаде",
      values: [
        { value: 4448, monitorLaunch: { happenedOn: "2026-08-17" } },
        { value: 4442, monitorLaunch: { happenedOn: "2026-08-19" } }
      ]
    },
    {
      name: "%Стельных",
      values: [{ value: 50, monitorLaunch: { happenedOn: "2026-08-19" } }]
    }
  ]);

  const result = extractMonitor(responses, [
    "Кол-во коров в стаде",
    "% Стельных",
    "% Брака коровы"
  ], { selection: "latest-available" });

  assert.equal(result["Кол-во коров в стаде"].value, 4442);
  assert.equal(result["Кол-во коров в стаде"].date, "2026-08-19");
  assert.equal(result["% Стельных"].value, 50);
  assert.equal(result["% Брака коровы"].value, 9);
});

test("monitor can still select the latest value at or before an end date", () => {
  const responses = monitorResponse([{
    name: "Средний надой ДЗ",
    values: [
      { value: 31.9, monitorLaunch: { happenedOn: "2026-08-16" } },
      { value: 32.4, monitorLaunch: { happenedOn: "2026-08-19" } }
    ]
  }]);

  const result = extractMonitor(responses, ["Средний надой ДЗ"], {
    end: "2026-08-16",
    selection: "latest-at-or-before-end"
  });

  assert.equal(result["Средний надой ДЗ"].value, 31.9);
  assert.equal(result["Средний надой ДЗ"].date, "2026-08-16");
});

test("monitor uses Средний надой КД when Средний надой ДЗ is absent", () => {
  const result = extractMonitor([{
    request: { postData: [{ operationName: "monitor" }] },
    body: [{ data: { monitor: { edges: [{ node: {
      name: "Средний надой КД",
      calculationMethod: "AVERAGE",
      values: [{ value: 30.7, monitorLaunch: { happenedOn: "2026-08-25" } }]
    } }] } } }]
  }], ["Средний надой ДЗ"], { selection: "latest-available" });

  assert.equal(result["Средний надой ДЗ"].name, "Средний надой КД");
  assert.equal(result["Средний надой ДЗ"].value, 30.7);
});

test("monitor resolves cross-farm KPI aliases and keeps percent labels with different spacing distinct", () => {
  const nodes = [
    { name: "%Брака", values: [{ value: 0, monitorLaunch: { happenedOn: "2026-08-25" } }] },
    { name: "% Брака", values: [{ value: 6, monitorLaunch: { happenedOn: "2026-08-25" } }] },
    { name: "Количество коров в стаде", values: [{ value: 587, monitorLaunch: { happenedOn: "2026-08-25" } }] },
    { name: "Количество БРАК", values: [{ value: 44, monitorLaunch: { happenedOn: "2026-08-25" } }] },
    { name: "Средние дни в доении", values: [{ value: 190.5, monitorLaunch: { happenedOn: "2026-08-25" } }] }
  ];
  const result = extractMonitor([{
    request: { postData: [{ operationName: "monitor" }] },
    body: [{ data: { monitor: { edges: nodes.map((node) => ({ node })) } } }]
  }], [
    "Кол-во коров в стаде",
    "Кол-во БРАК коровы",
    "Средние дни в доении (без сух.)",
    "% Брака коровы"
  ], { selection: "latest-available" });

  assert.equal(result["Кол-во коров в стаде"].value, 587);
  assert.equal(result["Кол-во БРАК коровы"].value, 44);
  assert.equal(result["Средние дни в доении (без сух.)"].value, 190.5);
  assert.equal(result["% Брака коровы"].value, 6);
});
