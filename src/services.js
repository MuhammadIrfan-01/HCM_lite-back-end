import { AuditLog, Holiday, Setting } from "./models.js";
import { currentTenantId } from "./tenant-context.js";

export async function getSetting(key, fallback = null) {
  const setting = await Setting.findOne({
    key,
    companyId: currentTenantId(),
  }).lean();
  return setting ? setting.value : fallback;
}

export async function setSetting(key, value) {
  await Setting.findOneAndUpdate(
    { key, companyId: currentTenantId() },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function writeAudit(
  user,
  action,
  entity,
  entityId,
  before = null,
  after = null,
) {
  await AuditLog.create({
    actorId: user?.id || null,
    actorName: user?.name || "System",
    action,
    entity,
    entityId: entityId?.toString() || "",
    before,
    after,
  });
}

export async function getOrganizationSettings() {
  const [
    company,
    officeStart,
    officeEnd,
    graceMinutes,
    halfDayHours,
    weekend,
    officeLatitude,
    officeLongitude,
    officeRadiusMeters,
  ] = await Promise.all([
    getSetting("company_name", ""),
    getSetting("office_start", "09:00"),
    getSetting("office_end", "17:00"),
    getSetting("grace_minutes", 15),
    getSetting("half_day_hours", 5),
    getSetting("weekend", [0, 6]),
    getSetting("office_latitude", null),
    getSetting("office_longitude", null),
    getSetting("office_radius_meters", 150),
  ]);

  return {
    company,
    officeStart,
    officeEnd,
    graceMinutes: Number(graceMinutes),
    halfDayHours: Number(halfDayHours),
    weekend,
    officeLatitude,
    officeLongitude,
    officeRadiusMeters: Number(officeRadiusMeters),
  };
}

export async function workingDays(startDate, endDate) {
  const settings = await getOrganizationSettings();
  const holidays = await Holiday.find({
    date: { $gte: startDate, $lte: endDate },
  })
    .select("date -_id")
    .lean();
  const holidayDates = new Set(holidays.map(({ date }) => date));
  const weekends = new Set(settings.weekend.map(Number));
  let count = 0;
  const current = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);

  while (current <= end) {
    const isoDate = current.toISOString().slice(0, 10);
    if (!weekends.has(current.getUTCDay()) && !holidayDates.has(isoDate))
      count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}

export function haversineDistanceMeters(
  latitudeA,
  longitudeA,
  latitudeB,
  longitudeB,
) {
  const earthRadius = 6_371_000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calculateAnnualTax(annualGross) {
  if (annualGross <= 600_000) return 0;
  if (annualGross <= 1_200_000) return (annualGross - 600_000) * 0.05;
  if (annualGross <= 2_400_000)
    return 30_000 + (annualGross - 1_200_000) * 0.15;
  if (annualGross <= 3_600_000)
    return 210_000 + (annualGross - 2_400_000) * 0.25;
  return 510_000 + (annualGross - 3_600_000) * 0.35;
}

export function localDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIME_ZONE || "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function workdayHasEnded(date, officeEnd, now = new Date()) {
  const today = localDateString(now);
  if (date < today) return true;
  if (date > today) return false;
  const timeZone = process.env.APP_TIME_ZONE || "Asia/Karachi";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  const currentMinutes = Number(values.hour) * 60 + Number(values.minute);
  const [endHour, endMinute] = officeEnd.split(":").map(Number);
  return currentMinutes >= endHour * 60 + endMinute;
}

export function effectiveAttendanceStatus(record, officeEnd, now = new Date()) {
  if (!record.checkOut && workdayHasEnded(record.date, officeEnd, now))
    return "missing_checkout";
  return record.status;
}

export function isValidIsoDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
