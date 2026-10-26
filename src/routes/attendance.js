import { Router } from "express";
import {
  Attendance,
  AttendanceCorrection,
  Employee,
  Holiday,
  LeaveRequest,
} from "../models.js";
import { asyncRoute, authenticate, allowRoles } from "../middleware.js";
import {
  getOrganizationSettings,
  haversineDistanceMeters,
  isValidIsoDate,
  localDateString,
  effectiveAttendanceStatus,
  workdayHasEnded,
  writeAudit,
} from "../services.js";

const router = Router();

function minutesAtOfficeTime(dateInput, timeZone) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return 0;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone || "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return Number(values.hour) * 60 + Number(values.minute);
}

function attendanceJson(record) {
  const value = record?.toObject ? record.toObject() : record?.toJSON ? record.toJSON() : (record || {});
  return {
    ...value,
    id: value._id?.toString() || value.id,
    employeeId:
      value.employeeId?._id?.toString() || value.employeeId?.toString(),
    name: value.employeeId?.name,
    code: value.employeeId?.code,
    department: value.employeeId?.department,
    check_in: value.checkIn,
    check_out: value.checkOut,
    checkIn: value.checkIn,
    checkOut: value.checkOut,
    photo: value.photo || null,
  };
}

router.post(
  "/attendance/check-in",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const date = localDateString();
    const now = new Date();
    const source = req.body.source === "camera" ? "camera" : "web";
    const settings = await getOrganizationSettings();
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (settings.weekend.map(Number).includes(weekday))
      return res
        .status(422)
        .json({ error: "Attendance is not scheduled for this weekday." });
    if (await Holiday.exists({ date }))
      return res
        .status(422)
        .json({ error: "Attendance is not scheduled for this holiday." });
    let location;

    if (source === "camera") {
      if (Number(req.body.faceCount) !== 1) {
        return res.status(422).json({
          error: "Camera check-in requires exactly one detected face.",
        });
      }
      const latitude = Number(req.body.latitude);
      const longitude = Number(req.body.longitude);
      const accuracy = Number(req.body.accuracy);
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        !Number.isFinite(accuracy)
      ) {
        return res.status(422).json({
          error: "Camera check-in requires a valid location reading.",
        });
      }
      if (accuracy > 100)
        return res
          .status(422)
          .json({ error: "Location accuracy must be 100 meters or better." });
      if (
        settings.officeLatitude === null ||
        settings.officeLongitude === null
      ) {
        return res.status(422).json({
          error: "Your Admin has not configured the office location.",
        });
      }
      const distanceMeters = haversineDistanceMeters(
        latitude,
        longitude,
        settings.officeLatitude,
        settings.officeLongitude,
      );
      if (distanceMeters > settings.officeRadiusMeters) {
        return res.status(422).json({
          error: "You are outside the configured office check-in area.",
        });
      }
      location = {
        latitude,
        longitude,
        accuracy,
        distanceMeters: Math.round(distanceMeters),
      };
    }

    const configuredStart =
      Number(settings.officeStart.slice(0, 2)) * 60 +
      Number(settings.officeStart.slice(3, 5));
    const lateAfter = configuredStart + settings.graceMinutes;
    const actualMinutes = minutesAtOfficeTime(
      now,
      process.env.APP_TIME_ZONE || "Asia/Karachi",
    );
    const status = actualMinutes > lateAfter ? "late" : "present";

    try {
      const record = await Attendance.create({
        employeeId: req.user.employeeId,
        date,
        checkIn: now,
        status,
        source,
        location,
        photo: req.body.photo || null,
      });
      await writeAudit(
        req.user,
        "check_in",
        "attendance",
        record.id || record._id?.toString(),
        null,
        attendanceJson(record),
      );
      return res.status(201).json(attendanceJson(record));
    } catch (error) {
      if (error.code === 11000)
        return res.status(409).json({ error: "You already checked in today." });
      throw error;
    }
  }),
);

router.post(
  "/attendance/check-out",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const today = localDateString();
    let record = await Attendance.findOne({
      employeeId: req.user.employeeId,
      date: today,
    });
    if (!record) {
      // Fallback: check for any open check-in without checkOut for this employee
      record = await Attendance.findOne({
        employeeId: req.user.employeeId,
        $or: [{ checkOut: null }, { checkOut: { $exists: false } }],
      }).sort({ checkIn: -1 });
    }
    if (!record)
      return res.status(409).json({ error: "Check in before checking out." });
    if (record.checkOut)
      return res.status(409).json({ error: "You already checked out today." });

    const before = attendanceJson(record);
    const now = new Date();
    record.checkOut = now;
    const checkInTime = new Date(record.checkIn).getTime();
    const checkOutTime = now.getTime();
    const hoursWorked = Math.max(0, (checkOutTime - checkInTime) / 3_600_000);
    const halfDayHours = Number(
      (await getOrganizationSettings()).halfDayHours || 5,
    );
    if (hoursWorked < halfDayHours && record.status !== "late") {
      record.status = "half_day";
    }
    await record.save();
    await writeAudit(
      req.user,
      "check_out",
      "attendance",
      record.id || record._id?.toString(),
      before,
      attendanceJson(record),
    );
    res.json({
      ...attendanceJson(record),
      hoursWorked: Number(hoursWorked.toFixed(2)),
    });
  }),
);

router.get(
  "/attendance",
  authenticate,
  asyncRoute(async (req, res) => {
    const filter = {};
    if (req.user.role === "employee") filter.employeeId = req.user.employeeId;
    else if (req.query.employeeId)
      filter.employeeId = String(req.query.employeeId);
    if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = String(req.query.from);
      if (req.query.to) filter.date.$lte = String(req.query.to);
    }
    if (req.query.date) filter.date = String(req.query.date);
    if (req.query.department && req.user.role !== "employee") {
      const employees = await Employee.find({
        department: req.query.department,
      })
        .select("_id")
        .lean();
      filter.employeeId = { $in: employees.map(({ _id }) => _id) };
    }
    const rows = await Attendance.find(filter)
      .populate("employeeId", "name code department")
      .sort({ date: -1, checkIn: -1 })
      .limit(1000)
      .lean();
    const settings = await getOrganizationSettings();
    const results = rows.map((row) => ({
      ...attendanceJson(row),
      status: effectiveAttendanceStatus(row, settings.officeEnd),
    }));
    const startDate = String(req.query.date || req.query.from || "");
    const endDate = String(req.query.date || req.query.to || startDate);
    const startTime = Date.parse(`${startDate}T00:00:00Z`);
    const endTime = Date.parse(`${endDate}T00:00:00Z`);

    if (
      startDate &&
      endDate &&
      Number.isFinite(startTime) &&
      Number.isFinite(endTime) &&
      endTime >= startTime &&
      endTime - startTime <= 90 * 86_400_000
    ) {
      const employees = await Employee.find({
        ...(req.user.role === "employee" ? { _id: req.user.employeeId } : {}),
        ...(req.query.department && req.user.role !== "employee"
          ? { department: req.query.department }
          : {}),
        joiningDate: { $lte: endDate },
        $or: [{ exitDate: "" }, { exitDate: { $gte: startDate } }],
        $and: [
          {
            $or: [
              { status: { $in: ["active", "probation"] } },
              { status: "inactive", exitDate: { $gte: startDate } },
            ],
          },
          { $or: [{ exitDate: "" }, { exitDate: { $gte: startDate } }] },
        ],
      })
        .select("_id name code department")
        .lean();
      const peopleIds = employees.map(({ _id }) => _id);
      const [holidays, leaves] = await Promise.all([
        Holiday.find({ date: { $gte: startDate, $lte: endDate } })
          .select("date")
          .lean(),
        LeaveRequest.find({
          employeeId: { $in: peopleIds },
          status: "approved",
          startDate: { $lte: endDate },
          endDate: { $gte: startDate },
        })
          .select("employeeId startDate endDate")
          .lean(),
      ]);
      const holidayDates = new Set(holidays.map(({ date }) => date));
      const existingKeys = new Set(
        results.map((record) => `${record.employeeId}:${record.date}`),
      );
      const weekends = new Set(settings.weekend.map(Number));
      const current = new Date(`${startDate}T12:00:00Z`);
      const last = new Date(`${endDate}T12:00:00Z`);

      while (current <= last) {
        const currentDate = current.toISOString().slice(0, 10);
        if (
          !weekends.has(current.getUTCDay()) &&
          !holidayDates.has(currentDate) &&
          workdayHasEnded(currentDate, settings.officeEnd)
        ) {
          for (const employee of employees) {
            if (
              employee.joiningDate > currentDate ||
              (employee.exitDate && employee.exitDate < currentDate) ||
              existingKeys.has(`${employee._id}:${currentDate}`)
            )
              continue;
            const approvedLeave = leaves.some(
              (leave) =>
                leave.employeeId.toString() === employee._id.toString() &&
                leave.startDate <= currentDate &&
                leave.endDate >= currentDate,
            );
            results.push({
              id: `missing:${employee._id}:${currentDate}`,
              employeeId: employee._id.toString(),
              name: employee.name,
              code: employee.code,
              department: employee.department,
              date: currentDate,
              check_in: null,
              check_out: null,
              status: approvedLeave ? "on_leave" : "absent",
              synthetic: true,
            });
          }
        }
        current.setUTCDate(current.getUTCDate() + 1);
      }
    }

    results.sort((left, right) => right.date.localeCompare(left.date));
    res.json(results);
  }),
);

router.post(
  "/attendance/corrections",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const date = String(req.body.date || "");
    const reason = String(req.body.reason || "").trim();
    if (!isValidIsoDate(date) || !reason)
      return res
        .status(422)
        .json({ error: "Provide a valid date and reason for the correction." });
    const existing = await AttendanceCorrection.findOne({
      employeeId: req.user.employeeId,
      date,
      status: "pending",
    });
    if (existing)
      return res.status(409).json({
        error: "You already have a correction request for this date.",
      });
    const correction = await AttendanceCorrection.create({
      employeeId: req.user.employeeId,
      date,
      requestedCheckIn: req.body.checkIn ? new Date(req.body.checkIn) : null,
      requestedCheckOut: req.body.checkOut ? new Date(req.body.checkOut) : null,
      reason,
    });
    await writeAudit(
      req.user,
      "request",
      "attendance_correction",
      correction.id,
      null,
      correction.toJSON(),
    );
    res.status(201).json(correction);
  }),
);

router.get(
  "/attendance/corrections",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (_req, res) => {
    const corrections = await AttendanceCorrection.find()
      .populate("employeeId", "name code department")
      .sort({ createdAt: -1 })
      .lean();
    res.json(
      corrections.map((item) => ({
        ...item,
        id: item._id.toString(),
        employeeName: item.employeeId?.name,
        code: item.employeeId?.code,
        department: item.employeeId?.department,
      })),
    );
  }),
);

router.get(
  "/attendance/corrections/mine",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const corrections = await AttendanceCorrection.find({
      employeeId: req.user.employeeId,
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json(corrections.map((item) => ({ ...item, id: item._id.toString() })));
  }),
);

router.patch(
  "/attendance/corrections/:id/review",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!["approved", "rejected"].includes(status))
      return res.status(422).json({ error: "Choose approve or reject." });
    const comment =
      String(req.body.comment || "").trim() ||
      (status === "approved" ? "Approved" : "Rejected");
    const correction = await AttendanceCorrection.findById(
      req.params.id,
    ).populate("employeeId");
    if (!correction)
      return res.status(404).json({ error: "Correction request not found." });
    if (correction.status !== "pending")
      return res
        .status(409)
        .json({ error: "This request has already been reviewed." });

    const before = correction.toJSON();
    const employeeId =
      correction.employeeId?.id ||
      correction.employeeId?._id ||
      correction.employeeId?.toString() ||
      correction.employeeId;
    correction.status = status;
    correction.comment = comment;
    correction.reviewedBy = req.user.id;

    if (status === "approved") {
      const settings = await getOrganizationSettings();
      const values = {};
      if (correction.requestedCheckIn)
        values.checkIn = correction.requestedCheckIn;
      if (correction.requestedCheckOut)
        values.checkOut = correction.requestedCheckOut;
      if (!values.checkIn)
        values.checkIn = new Date(
          `${correction.date}T${settings.officeStart || "09:00"}:00+05:00`,
        ).toISOString();
      const checkInMinutes = minutesAtOfficeTime(
        values.checkIn,
        process.env.APP_TIME_ZONE || "Asia/Karachi",
      );
      const officeStart = settings.officeStart || "09:00";
      const officeStartMinutes =
        Number(officeStart.slice(0, 2)) * 60 +
        Number(officeStart.slice(3, 5));
      let correctedStatus =
        checkInMinutes > officeStartMinutes + (settings.graceMinutes ?? 15)
          ? "late"
          : "present";
      if (values.checkOut) {
        const correctedHours =
          (new Date(values.checkOut).getTime() -
            new Date(values.checkIn).getTime()) /
          3_600_000;
        if (correctedHours < (settings.halfDayHours ?? 5))
          correctedStatus = "half_day";
      }
      const saved = await Attendance.findOneAndUpdate(
        { employeeId, date: correction.date },
        {
          $set: { ...values, status: correctedStatus, source: "hr_correction" },
          $setOnInsert: {
            employeeId,
            date: correction.date,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
      await writeAudit(
        req.user,
        "correct",
        "attendance",
        saved.id || saved._id?.toString(),
        null,
        attendanceJson(saved),
      );
    }

    correction.employeeId = employeeId;
    await correction.save();
    await writeAudit(
      req.user,
      status,
      "attendance_correction",
      correction.id || correction._id?.toString(),
      before,
      correction.toJSON(),
    );
    res.json(correction);
  }),
);

export default router;
