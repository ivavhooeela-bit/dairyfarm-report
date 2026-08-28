import test from "node:test";
import assert from "node:assert/strict";
import { defaultPeriod, sourcePeriod, validatePeriod } from "../lib/dates.mjs";

test("период по умолчанию — семь полных дней до сегодня", () => {
  assert.deepEqual(defaultPeriod(new Date(2026, 7, 17, 15)), { start: "2026-08-10", end: "2026-08-16" });
});

test("период корректно проходит границу месяца", () => {
  assert.deepEqual(defaultPeriod(new Date(2026, 2, 3)), { start: "2026-02-24", end: "2026-03-02" });
});

test("начальная дата не может быть позже конечной", () => {
  assert.throws(() => validatePeriod("2026-08-17", "2026-08-10"), /позже/);
});

test("годовой период заканчивается датой пользователя", () => {
  assert.deepEqual(sourcePeriod("year-ending-user-end", "2026-08-10", "2026-08-16"), { start: "2025-08-17", end: "2026-08-16" });
});

test("период 365 дней содержит ровно 365 календарных дат", () => {
  assert.deepEqual(sourcePeriod("365-days-ending-user-end", "2026-08-10", "2026-08-19"), { start: "2025-08-20", end: "2026-08-19" });
  assert.deepEqual(sourcePeriod("365-days-ending-user-end", "2024-02-24", "2024-03-01"), { start: "2023-03-03", end: "2024-03-01" });
});

test("период 30 дней содержит ровно 30 календарных дат", () => {
  assert.deepEqual(sourcePeriod("30-days-ending-user-end", "2026-08-10", "2026-08-19"), { start: "2026-07-21", end: "2026-08-19" });
});

test("двенадцатидневный период включает ровно 12 дат", () => {
  assert.deepEqual(sourcePeriod("12-days-ending-user-end", "2026-08-10", "2026-08-16"), { start: "2026-08-05", end: "2026-08-16" });
});

test("месячный период начинается тем же числом прошлого месяца", () => {
  assert.deepEqual(sourcePeriod("month-ending-user-end", "2026-08-10", "2026-08-16"), { start: "2026-07-16", end: "2026-08-16" });
});
