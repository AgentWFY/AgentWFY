/**
 * 6-field schedule expression parser and matcher.
 *
 * Format: "second minute hour day month weekday"
 *   second  : 0-59
 *   minute  : 0-59
 *   hour    : 0-23
 *   day     : 1-31
 *   month   : 1-12
 *   weekday : 0-6 (0 = Sunday)
 *
 * Supports: * (any), values (5), ranges (1-5), lists (1,15), steps (STAR/10, 2-30/2).
 */

interface ParsedExpression {
  second: number[];
  minute: number[];
  hour: number[];
  day: number[];
  month: number[];
  weekday: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    // */step or range/step
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex !== -1) {
      const base = trimmed.slice(0, slashIndex);
      const step = parseInt(trimmed.slice(slashIndex + 1), 10);
      if (!Number.isFinite(step) || step < 1) {
        throw new Error(`Invalid step value in "${trimmed}"`);
      }

      let rangeMin = min;
      let rangeMax = max;

      if (base === '*') {
        // */step — full range with step
      } else if (base.includes('-')) {
        const [lo, hi] = base.split('-').map(Number);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          throw new Error(`Invalid range in "${trimmed}"`);
        }
        rangeMin = lo;
        rangeMax = hi;
      } else {
        rangeMin = parseInt(base, 10);
        if (!Number.isFinite(rangeMin)) {
          throw new Error(`Invalid base in "${trimmed}"`);
        }
        rangeMax = max;
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // *
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // range: 1-5
    if (trimmed.includes('-')) {
      const [lo, hi] = trimmed.split('-').map(Number);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`Invalid range "${trimmed}"`);
      }
      for (let i = lo; i <= hi; i++) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // single value
    const val = parseInt(trimmed, 10);
    if (!Number.isFinite(val) || val < min || val > max) {
      throw new Error(`Value ${trimmed} out of range [${min}-${max}]`);
    }
    values.add(val);
  }

  if (values.size === 0) {
    throw new Error(`Empty field: "${field}"`);
  }

  return Array.from(values).sort((a, b) => a - b);
}

export function parseExpression(expr: string): ParsedExpression {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 6) {
    throw new Error(`Schedule expression must have 6 fields (second minute hour day month weekday), got ${parts.length}`);
  }

  return {
    second: parseField(parts[0], 0, 59),
    minute: parseField(parts[1], 0, 59),
    hour: parseField(parts[2], 0, 23),
    day: parseField(parts[3], 1, 31),
    month: parseField(parts[4], 1, 12),
    weekday: parseField(parts[5], 0, 6),
  };
}

/**
 * Find the next Date after `after` that matches the parsed expression.
 * Searches up to 2 years ahead to avoid infinite loops.
 */
export function nextMatch(parsed: ParsedExpression, after: Date): Date | null {
  const limit = new Date(after.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);

  // Start from the next second after `after`
  const candidate = new Date(after.getTime() + 1000);
  candidate.setMilliseconds(0);

  while (candidate.getTime() <= limit.getTime()) {
    // Check month
    const month = candidate.getMonth() + 1;
    if (!parsed.month.includes(month)) {
      // Jump to next matching month
      const nextMonth = parsed.month.find(m => m > month);
      if (nextMonth !== undefined) {
        candidate.setMonth(nextMonth - 1, 1);
        candidate.setHours(parsed.hour[0], parsed.minute[0], parsed.second[0], 0);
      } else {
        // Next year, first matching month
        candidate.setFullYear(candidate.getFullYear() + 1, parsed.month[0] - 1, 1);
        candidate.setHours(parsed.hour[0], parsed.minute[0], parsed.second[0], 0);
      }
      continue;
    }

    // Check day
    const day = candidate.getDate();
    if (!parsed.day.includes(day)) {
      const nextDay = parsed.day.find(d => d > day);
      if (nextDay !== undefined) {
        candidate.setDate(nextDay);
        candidate.setHours(parsed.hour[0], parsed.minute[0], parsed.second[0], 0);
      } else {
        // Next month
        candidate.setMonth(candidate.getMonth() + 1, 1);
        candidate.setHours(parsed.hour[0], parsed.minute[0], parsed.second[0], 0);
      }
      continue;
    }

    // Check weekday
    const weekday = candidate.getDay();
    if (!parsed.weekday.includes(weekday)) {
      // Jump to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(parsed.hour[0], parsed.minute[0], parsed.second[0], 0);
      continue;
    }

    // Check hour
    const hour = candidate.getHours();
    if (!parsed.hour.includes(hour)) {
      const nextHour = parsed.hour.find(h => h > hour);
      if (nextHour !== undefined) {
        candidate.setHours(nextHour, parsed.minute[0], parsed.second[0], 0);
      } else {
        // Next day
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(parsed.hour[0], parsed.minute[0], parsed.second[0], 0);
      }
      continue;
    }

    // Check minute
    const minute = candidate.getMinutes();
    if (!parsed.minute.includes(minute)) {
      const nextMinute = parsed.minute.find(m => m > minute);
      if (nextMinute !== undefined) {
        candidate.setMinutes(nextMinute, parsed.second[0], 0);
      } else {
        // Next hour
        candidate.setHours(candidate.getHours() + 1, parsed.minute[0], parsed.second[0], 0);
      }
      continue;
    }

    // Check second
    const second = candidate.getSeconds();
    if (!parsed.second.includes(second)) {
      const nextSecond = parsed.second.find(s => s > second);
      if (nextSecond !== undefined) {
        candidate.setSeconds(nextSecond, 0);
      } else {
        // Next minute
        candidate.setMinutes(candidate.getMinutes() + 1, parsed.second[0], 0);
      }
      continue;
    }

    // All fields match
    return candidate;
  }

  return null;
}
