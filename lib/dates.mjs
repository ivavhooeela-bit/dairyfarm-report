export function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultPeriod(now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
  return { start: isoDate(start), end: isoDate(end) };
}

export function validatePeriod(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("Даты должны быть в формате ГГГГ-ММ-ДД");
  }
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.valueOf()) || Number.isNaN(endDate.valueOf())) {
    throw new Error("Указана некорректная дата");
  }
  if (startDate > endDate) throw new Error("Начальная дата позже конечной");
  return { start, end };
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function addYears(iso, years) {
  const date = new Date(`${iso}T00:00:00`);
  const originalMonth = date.getMonth();
  date.setFullYear(date.getFullYear() + years);
  if (date.getMonth() !== originalMonth) date.setDate(0);
  return isoDate(date);
}

function addMonths(iso, months) {
  const date = new Date(`${iso}T00:00:00`);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return isoDate(date);
}

export function sourcePeriod(policy, userStart, userEnd) {
  switch (policy) {
    case "user": return { start: userStart, end: userEnd };
    case "30-days-ending-user-end": return { start: addDays(userEnd, -29), end: userEnd };
    case "365-days-ending-user-end": return { start: addDays(userEnd, -364), end: userEnd };
    case "year-ending-user-end": return { start: addDays(addYears(userEnd, -1), 1), end: userEnd };
    case "month-ending-user-end": return { start: addMonths(userEnd, -1), end: userEnd };
    case "12-days-ending-user-end": return { start: addDays(userEnd, -11), end: userEnd };
    case "month-containing-user-end": {
      const date = new Date(`${userEnd}T00:00:00`);
      return {
        start: isoDate(new Date(date.getFullYear(), date.getMonth(), 1)),
        end: isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0))
      };
    }
    case "user-end": return { start: userEnd, end: userEnd };
    case "none":
    case "report-defined":
    default: return null;
  }
}
