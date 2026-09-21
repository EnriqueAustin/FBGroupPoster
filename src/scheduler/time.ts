/**
 * Timezone-aware date helpers built only on Intl.DateTimeFormat.
 *
 * The scheduler reasons in two frames at once:
 *   - UTC instants (everything stored / compared is an epoch ms or ISO string)
 *   - the user's local calendar (the "day" a daily cap applies to, and the
 *     active-hours window a human would recognise as "daytime")
 *
 * Getting this wrong is a safety bug, not a cosmetic one: a mis-computed day
 * boundary silently doubles the number of posts Facebook sees in 24h.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Break an instant into the wall-clock fields an observer in `tz` would read. */
export function partsInZone(ms: number, tz: string): ZonedParts {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p === undefined ? 0 : Number(p.value);
  };
  // h23 still renders midnight as "24" in some ICU versions; normalise it.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function partsAsUtcMs(p: ZonedParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}

/** Zone offset (ms east of UTC) in effect at the given instant. */
export function offsetMsAt(ms: number, tz: string): number {
  return partsAsUtcMs(partsInZone(ms, tz)) - ms;
}

/**
 * Inverse of partsInZone: the UTC instant at which the local clock in `tz`
 * reads these wall-clock fields. Two refinement passes settle DST shifts
 * (the first guess can land on the wrong side of a transition).
 */
export function zonedPartsToUtcMs(p: ZonedParts, tz: string): number {
  const wall = partsAsUtcMs(p);
  let utc = wall - offsetMsAt(wall, tz);
  utc = wall - offsetMsAt(utc, tz);
  return utc;
}

/** Local hour-of-day (0-23) at an instant. */
export function localHour(ms: number, tz: string): number {
  return partsInZone(ms, tz).hour;
}

/** Stable "YYYY-MM-DD" key for the local calendar day containing the instant. */
export function dayKeyInZone(ms: number, tz: string): string {
  const p = partsInZone(ms, tz);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC instant of local midnight opening the calendar day containing `ms`. */
export function startOfDayUtcMs(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  return zonedPartsToUtcMs({ ...p, hour: 0, minute: 0, second: 0 }, tz);
}

/** UTC instant of the next local midnight (exclusive end of the day). */
export function endOfDayUtcMs(ms: number, tz: string): number {
  return startOfNextDayUtcMs(ms, tz);
}

export function startOfNextDayUtcMs(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  // Date.UTC normalises day overflow (e.g. Jan 32 -> Feb 1) for us.
  return zonedPartsToUtcMs(
    { year: p.year, month: p.month, day: p.day + 1, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** [start, end) UTC bounds of the local calendar day containing `ms`. */
export function dayBoundsUtcMs(ms: number, tz: string): { start: number; end: number } {
  return { start: startOfDayUtcMs(ms, tz), end: startOfNextDayUtcMs(ms, tz) };
}

/** UTC instant of a given local hour:minute on the local day containing `ms`. */
export function localTimeOnDayUtcMs(
  ms: number,
  tz: string,
  hour: number,
  minute = 0,
): number {
  const p = partsInZone(ms, tz);
  return zonedPartsToUtcMs({ ...p, hour, minute, second: 0 }, tz);
}

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
