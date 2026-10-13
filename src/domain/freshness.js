export const STALE_AFTER_CALENDAR_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Midnight UTC of a "YYYY-MM-DD" observation date, or null when it is not a real calendar date.
function observationDayMs(observationDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(observationDate))) return null;
  const [year, month, day] = observationDate.split("-").map(Number);
  const observationMs = Date.UTC(year, month - 1, day);
  const expected = new Date(observationMs);
  if (expected.getUTCFullYear() !== year || expected.getUTCMonth() !== month - 1 || expected.getUTCDate() !== day) return null;
  return observationMs;
}

export function observationAgeInDays(observationDate, now = new Date()) {
  const observationMs = observationDayMs(observationDate);
  if (observationMs === null) return null;
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((todayMs - observationMs) / DAY_MS);
}

// The same count on the viewer's own calendar: the number someone gets by comparing the date on
// a card with today's date where they are. Used for the age that is shown to them.
export function observationAgeInLocalDays(observationDate, now = new Date()) {
  const observationMs = observationDayMs(observationDate);
  if (observationMs === null) return null;
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((todayMs - observationMs) / DAY_MS);
}

export function isObservationStale(observationDate, now = new Date()) {
  const age = observationAgeInDays(observationDate, now);
  return age === null || age > STALE_AFTER_CALENDAR_DAYS;
}
