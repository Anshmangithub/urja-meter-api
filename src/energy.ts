import type { Consumption, EnergyReading } from "./models.js";
import type { RawRow } from "./portal.js";

const PORTAL_TS = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

export function buildConsumption(meterId: string, rows: RawRow[], utcOffsetMinutes: number): Consumption {
  const parsed: { at: number; iso: string; kwh: number | null; kvah: number | null; volt: number | null }[] = [];
  for (const row of rows) {
    const ts = parseTimestamp(row.timestamp, utcOffsetMinutes);
    if (!ts) continue;
    parsed.push({ ...ts, kwh: num(row.kwh), kvah: num(row.kvah), volt: num(row.voltR) });
  }
  parsed.sort((a, b) => a.at - b.at);

  const readings: EnergyReading[] = [];
  let resets = 0;
  let prevKwh: number | null = null;
  let prevKvah: number | null = null;
  for (const p of parsed) {
    let kwhDelta: number | null = null;
    let kvahDelta: number | null = null;
    if (p.kwh !== null) {
      if (prevKwh !== null) {
        if (p.kwh >= prevKwh) kwhDelta = round(p.kwh - prevKwh, 4);
        else resets++;
      }
      prevKwh = p.kwh;
    }
    if (p.kvah !== null) {
      if (prevKvah !== null && p.kvah >= prevKvah) kvahDelta = round(p.kvah - prevKvah, 4);
      prevKvah = p.kvah;
    }
    readings.push({
      timestamp: p.iso,
      kwh: p.kwh,
      kvah: p.kvah,
      voltage_r: p.volt,
      kwh_delta: kwhDelta,
      kvah_delta: kvahDelta,
    });
  }

  const gapsMs = parsed.slice(1).map((p, i) => p.at - parsed[i]!.at);
  const cadenceMs = median(gapsMs);
  const volts = readings.map((r) => r.voltage_r).filter((v): v is number => v !== null);
  const deltas = readings.map((r) => r.kwh_delta).filter((v): v is number => v !== null);

  return {
    meter_id: meterId,
    interval_minutes: cadenceMs === null ? null : Math.round(cadenceMs / 60_000),
    count: readings.length,
    readings,
    summary: {
      consumption_kwh: deltas.length ? round(deltas.reduce((a, b) => a + b, 0), 3) : null,
      avg_voltage_r: volts.length ? round(volts.reduce((a, b) => a + b, 0) / volts.length, 2) : null,
      min_voltage_r: volts.length ? Math.min(...volts) : null,
      max_voltage_r: volts.length ? Math.max(...volts) : null,
      missing_values: readings.filter((r) => r.kwh === null || r.kvah === null || r.voltage_r === null).length,
      register_resets: resets,
      gaps: cadenceMs === null ? 0 : gapsMs.filter((g) => g > 1.5 * cadenceMs).length,
    },
  };
}

function parseTimestamp(value: unknown, offsetMin: number): { at: number; iso: string } | null {
  const m = PORTAL_TS.exec(String(value ?? ""));
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi] = m;
  const at = Date.UTC(+yyyy!, +mm! - 1, +dd!, +hh!, +mi!) - offsetMin * 60_000;
  if (Number.isNaN(at) || new Date(Date.UTC(+yyyy!, +mm! - 1, +dd!)).getUTCDate() !== +dd!) return null;
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return { at, iso: `${yyyy}-${mm}-${dd}T${hh}:${mi}:00${off}` };
}

function num(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
