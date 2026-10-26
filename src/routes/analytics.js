import { Router } from "express";
import {
  Announcement,
  Attendance,
  AuditLog,
  Employee,
  LeaveRequest,
  LeaveType,
  PayrollRun,
  Payslip,
  User,
} from "../models.js";
import { asyncRoute, authenticate } from "../middleware.js";
import {
  getOrganizationSettings,
  localDateString,
  effectiveAttendanceStatus,
  workingDays,
  isValidIsoDate,
} from "../services.js";
import { getLeaveBalances } from "./leaves.js";

const router = Router();

function dateRange(query) {
  const today = localDateString();
  const startOfMonth = `${today.slice(0, 7)}-01`;
  const from = String(query.from || startOfMonth);
  const to = String(query.to || today);
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to || to > today)
    throw Object.assign(
      new Error("Choose a valid date range ending today or earlier."),
      { status: 422 },
    );
  return { from, to };
}

function insideRange(date, from, to) {
  return date >= from && date <= to;
}

async function employeeFilter(role, employeeId, department) {
  if (role === "employee") return { _id: employeeId };
  return department
    ? { department, status: { $in: ["active", "probation", "inactive"] } }
    : { status: { $in: ["active", "probation", "inactive"] } };
}

export async function buildAnalytics({
  role,
  employeeId,
  from,
  to,
  department,
}) {
  if (
    !isValidIsoDate(from) ||
    !isValidIsoDate(to) ||
    from > to ||
    to > localDateString()
  )
    throw Object.assign(new Error("Choose a valid date range."), {
      status: 422,
    });
  const employeeQuery = await employeeFilter(role, employeeId, department);
  const employees = await Employee.find(employeeQuery).lean();
  const employeeIds = employees.map(({ _id }) => _id);
  const peopleById = new Map(
    employees.map((employee) => [employee._id.toString(), employee]),
  );
  const activePeople = employees.filter(
    (employee) =>
      ["active", "probation"].includes(employee.status) &&
      employee.joiningDate <= to &&
      (!employee.exitDate || employee.exitDate >= to),
  );
  const expectedDays = await Promise.all(
    employees.map(async (employee) => {
      const start = employee.joiningDate > from ? employee.joiningDate : from;
      const end =
        employee.exitDate && employee.exitDate < to ? employee.exitDate : to;
      return start <= end &&
        (employee.status !== "inactive" || Boolean(employee.exitDate))
        ? workingDays(start, end)
        : 0;
    }),
  );
  const expectedWorkdayRecords = expectedDays.reduce(
    (sum, days) => sum + days,
    0,
  );
  const expectedByDepartment = {};
  employees.forEach((employee, index) => {
    const days = expectedDays[index];
    expectedByDepartment[employee.department] =
      (expectedByDepartment[employee.department] || 0) + days;
  });

  const [attendance, leaveRequests, slips, payrollRuns] = await Promise.all([
    Attendance.find({
      employeeId: { $in: employeeIds },
      date: { $gte: from, $lte: to },
    }).lean(),
    LeaveRequest.find({
      employeeId: { $in: employeeIds },
      status: "approved",
      startDate: { $lte: to },
      endDate: { $gte: from },
    }).lean(),
    Payslip.find({
      employeeId: { $in: employeeIds },
      month: { $gte: from.slice(0, 7), $lte: to.slice(0, 7) },
    })
      .populate({
        path: "runId",
        match: { status: "finalized" },
        select: "status",
      })
      .lean(),
    PayrollRun.find({
      month: { $gte: from.slice(0, 7), $lte: to.slice(0, 7) },
    }).lean(),
  ]);

  const organizationSettings = await getOrganizationSettings();
  for (const row of attendance)
    row.status = effectiveAttendanceStatus(row, organizationSettings.officeEnd);

  const byAttendance = {
    present: 0,
    late: 0,
    half_day: 0,
    missing_checkout: 0,
  };
  let lateDays = 0;
  let halfDays = 0;
  for (const row of attendance) {
    if (byAttendance[row.status] !== undefined) byAttendance[row.status] += 1;
    if (row.status === "late") lateDays += 1;
    if (row.status === "half_day") halfDays += 1;
  }

  let approvedLeaveDays = 0;
  const leaveByType = {};
  const leaveByDepartment = {};
  const leaveByDepartmentAndType = {};
  for (const leave of leaveRequests) {
    const clippedStart = leave.startDate < from ? from : leave.startDate;
    const clippedEnd = leave.endDate > to ? to : leave.endDate;
    const days = await workingDays(clippedStart, clippedEnd);
    approvedLeaveDays += days;
    leaveByType[leave.type] = (leaveByType[leave.type] || 0) + days;
    const departmentName =
      peopleById.get(leave.employeeId.toString())?.department || "Unknown";
    leaveByDepartment[departmentName] =
      (leaveByDepartment[departmentName] || 0) + days;
    leaveByDepartmentAndType[departmentName] ||= {};
    leaveByDepartmentAndType[departmentName][leave.type] =
      (leaveByDepartmentAndType[departmentName][leave.type] || 0) + days;
  }

  const attendanceNumerator =
    byAttendance.present +
    byAttendance.late +
    byAttendance.missing_checkout +
    0.5 * byAttendance.half_day;
  const attendanceDenominator = Math.max(
    0,
    expectedWorkdayRecords - approvedLeaveDays,
  );
  const rate = attendanceDenominator
    ? (attendanceNumerator / attendanceDenominator) * 100
    : 0;
  const latePercentage =
    byAttendance.present + byAttendance.late
      ? (lateDays / (byAttendance.present + byAttendance.late)) * 100
      : 0;
  const absentDays = Math.max(
    0,
    expectedWorkdayRecords - approvedLeaveDays - attendance.length,
  );
  const finalizedSlips = slips.filter(
    (slip) => slip.runId?.status === "finalized",
  );
  const payrollGross = finalizedSlips.reduce(
    (sum, slip) => sum + slip.gross,
    0,
  );
  const payrollNet = finalizedSlips.reduce((sum, slip) => sum + slip.net, 0);

  const attendanceByDepartment = {};
  const attendanceTrend = {};
  const lateByEmployee = {};
  for (const row of attendance) {
    const departmentName =
      peopleById.get(row.employeeId.toString())?.department || "Unknown";
    const entry = attendanceByDepartment[departmentName] || {
      present: 0,
      late: 0,
      halfDay: 0,
      records: 0,
    };
    entry.records += 1;
    if (row.status === "present" || row.status === "missing_checkout")
      entry.present += 1;
    if (row.status === "late") entry.late += 1;
    if (row.status === "half_day") entry.halfDay += 1;
    attendanceByDepartment[departmentName] = entry;
    const month = row.date.slice(0, 7);
    const trend = attendanceTrend[month] || { present: 0, late: 0, halfDay: 0 };
    if (row.status === "present" || row.status === "missing_checkout")
      trend.present += 1;
    if (row.status === "late") trend.late += 1;
    if (row.status === "half_day") trend.halfDay += 1;
    attendanceTrend[month] = trend;
    if (row.status === "late") {
      const employee = peopleById.get(row.employeeId.toString());
      if (employee) {
        const lateEntry = lateByEmployee[employee._id.toString()] || {
          name: employee.name,
          department: employee.department,
          count: 0,
        };
        lateEntry.count += 1;
        lateByEmployee[employee._id.toString()] = lateEntry;
      }
    }
  }
  for (const [departmentName, expected] of Object.entries(
    expectedByDepartment,
  )) {
    const row = attendanceByDepartment[departmentName] || {
      present: 0,
      late: 0,
      halfDay: 0,
      records: 0,
    };
    const actualRecords = attendance.filter(
      (record) =>
        peopleById.get(record.employeeId.toString())?.department ===
        departmentName,
    ).length;
    const approvedForDepartment = leaveByDepartment[departmentName] || 0;
    row.absent = Math.max(0, expected - approvedForDepartment - actualRecords);
    row.absenteeism = expected
      ? Number(((row.absent / expected) * 100).toFixed(1))
      : 0;
    row.latePercentage =
      row.present + row.late
        ? Number(((row.late / (row.present + row.late)) * 100).toFixed(1))
        : 0;
    attendanceByDepartment[departmentName] = row;
  }
  const payrollByDepartment = {};
  for (const slip of finalizedSlips) {
    const entry = payrollByDepartment[slip.department] || { gross: 0, net: 0 };
    entry.gross += slip.gross;
    entry.net += slip.net;
    payrollByDepartment[slip.department] = entry;
  }
  const salaryByDepartmentAndDesignation = {};
  for (const employee of activePeople) {
    const key = `${employee.department} · ${employee.designation}`;
    const entry = salaryByDepartmentAndDesignation[key] || {
      total: 0,
      count: 0,
    };
    entry.total +=
      employee.basicSalary * 1.5 + Number(employee.allowances || 0);
    entry.count += 1;
    salaryByDepartmentAndDesignation[key] = entry;
  }

  const exits = employees.filter(
    (employee) => employee.exitDate && insideRange(employee.exitDate, from, to),
  ).length;
  const startHeadcount = employees.filter(
    (employee) =>
      employee.joiningDate <= from &&
      (employee.status !== "inactive" || Boolean(employee.exitDate)) &&
      (!employee.exitDate || employee.exitDate >= from),
  ).length;
  const averageHeadcount = (startHeadcount + activePeople.length) / 2;
  const attrition = averageHeadcount ? (exits / averageHeadcount) * 100 : 0;
  const configuredLeaveTypes = await LeaveType.find({ active: true }).lean();
  const leaveUtilization = Object.fromEntries(
    configuredLeaveTypes.map((type) => {
      const quota = type.quota === 0 ? 0 : type.quota * activePeople.length;
      const approvedDays = leaveByType[type.name] || 0;
      return [
        type.name,
        {
          approvedDays,
          quota,
          percent: quota
            ? Number(((approvedDays / quota) * 100).toFixed(1))
            : null,
        },
      ];
    }),
  );
  const activeByDepartment = activePeople.reduce((counts, employee) => {
    counts[employee.department] = (counts[employee.department] || 0) + 1;
    return counts;
  }, {});
  const leaveUtilizationByDepartment = Object.fromEntries(
    Object.entries(leaveByDepartmentAndType).map(
      ([departmentName, typeDays]) => [
        departmentName,
        Object.fromEntries(
          configuredLeaveTypes.map((type) => {
            const quota =
              type.quota === 0
                ? 0
                : type.quota * (activeByDepartment[departmentName] || 0);
            const approvedDays = typeDays[type.name] || 0;
            return [
              type.name,
              {
                approvedDays,
                quota,
                percent: quota
                  ? Number(((approvedDays / quota) * 100).toFixed(1))
                  : null,
              },
            ];
          }),
        ),
      ],
    ),
  );
  const headcountByDepartment = {};
  const genderBreakdown = {};
  const tenureBreakdown = {
    underOneYear: 0,
    oneToThreeYears: 0,
    overThreeYears: 0,
  };
  for (const employee of activePeople) {
    headcountByDepartment[employee.department] =
      (headcountByDepartment[employee.department] || 0) + 1;
    const gender = employee.gender || "unspecified";
    genderBreakdown[gender] = (genderBreakdown[gender] || 0) + 1;
    const tenureYears = Math.max(
      0,
      (Date.parse(`${to}T00:00:00Z`) -
        Date.parse(`${employee.joiningDate}T00:00:00Z`)) /
        (365.25 * 86_400_000),
    );
    if (tenureYears < 1) tenureBreakdown.underOneYear += 1;
    else if (tenureYears <= 3) tenureBreakdown.oneToThreeYears += 1;
    else tenureBreakdown.overThreeYears += 1;
  }

  return {
    filters: { from, to, department: department || null },
    headcount: activePeople.length,
    attrition: Number(attrition.toFixed(1)),
    attendance: {
      ...byAttendance,
      onLeave: approvedLeaveDays,
      absent: absentDays,
      expectedWorkdayRecords,
      rate: Number(rate.toFixed(1)),
      latePercentage: Number(latePercentage.toFixed(1)),
      absenteeism: expectedWorkdayRecords
        ? Number(((absentDays / expectedWorkdayRecords) * 100).toFixed(1))
        : 0,
      lateDays,
      halfDays,
    },
    attendanceByDepartment,
    attendanceTrend,
    topLateComers: Object.values(lateByEmployee)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    headcountByDepartment,
    genderBreakdown,
    tenureBreakdown,
    leaveUtilization,
    leaveUtilizationByDepartment,
    leaveByDepartment,
    payroll: {
      gross: Number(payrollGross.toFixed(2)),
      net: Number(payrollNet.toFixed(2)),
      byDepartment: payrollByDepartment,
      meanGrossByDepartmentAndDesignation: Object.fromEntries(
        Object.entries(salaryByDepartmentAndDesignation).map(([key, value]) => [
          key,
          Number((value.total / value.count).toFixed(2)),
        ]),
      ),
      finalizedRuns: payrollRuns.filter((run) => run.status === "finalized")
        .length,
    },
  };
}

router.get(
  "/analytics",
  authenticate,
  asyncRoute(async (req, res) => {
    const { from, to } = dateRange(req.query);
    const analytics = await buildAnalytics({
      role: req.user.role,
      employeeId: req.user.employeeId,
      from,
      to,
      department: req.query.department,
    });
    res.json(analytics);
  }),
);

router.get(
  "/dashboard",
  authenticate,
  asyncRoute(async (req, res) => {
    const today = localDateString();
    const defaultStart =
      req.user.role === "admin"
        ? `${today.slice(0, 4)}-01-01`
        : `${today.slice(0, 7)}-01`;
    const { from, to } = dateRange({
      from: req.query.from || defaultStart,
      to: req.query.to || today,
    });
    const todayFilter = { date: today };
    const peopleFilter = await employeeFilter(
      req.user.role,
      req.user.employeeId,
      req.query.department,
    );
    const employeeIds = (
      await Employee.find(peopleFilter).select("_id").lean()
    ).map(({ _id }) => _id);
    todayFilter.employeeId = { $in: employeeIds };
    const [
      analytics,
      todayRecords,
      approvedToday,
      pendingLeaves,
      hrCount,
      recentActivity,
      announcements,
    ] = await Promise.all([
      buildAnalytics({
        role: req.user.role,
        employeeId: req.user.employeeId,
        from,
        to,
        department: req.query.department,
      }),
      Attendance.find(todayFilter).lean(),
      LeaveRequest.find({
        employeeId: { $in: employeeIds },
        status: "approved",
        startDate: { $lte: today },
        endDate: { $gte: today },
      }).countDocuments(),
      LeaveRequest.countDocuments({
        employeeId: { $in: employeeIds },
        status: "pending",
      }),
      req.user.role === "admin"
        ? User.countDocuments({ role: "hr", active: true })
        : Promise.resolve(0),
      req.user.role === "employee"
        ? []
        : AuditLog.find().sort({ createdAt: -1 }).limit(8).lean(),
      Announcement.find().sort({ createdAt: -1 }).limit(5).lean(),
    ]);
    const counts = { present: 0, late: 0, half_day: 0, missing_checkout: 0 };
    const organization = await getOrganizationSettings();
    for (const row of todayRecords) {
      const status = effectiveAttendanceStatus(row, organization.officeEnd);
      if (counts[status] !== undefined) counts[status] += 1;
    }

    let personal = null;
    if (req.user.role === "employee") {
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
      const daysFromMonday = (weekday + 6) % 7;
      const weekStartDate = new Date(`${today}T12:00:00Z`);
      weekStartDate.setUTCDate(weekStartDate.getUTCDate() - daysFromMonday);
      const weekStart = weekStartDate.toISOString().slice(0, 10);
      const ownAttendance = await Attendance.find({
        employeeId: req.user.employeeId,
        date: { $gte: weekStart, $lte: today },
      }).lean();
      const totalHours = ownAttendance.reduce(
        (sum, row) =>
          sum + (row.checkOut ? (row.checkOut - row.checkIn) / 3_600_000 : 0),
        0,
      );
      const thisMonth = today.slice(0, 7);
      const finalizedRunIds = (
        await PayrollRun.find({
          status: "finalized",
          month: { $lte: thisMonth },
        })
          .select("_id")
          .lean()
      ).map(({ _id }) => _id);
      const latestPayslip = await Payslip.findOne({
        employeeId: req.user.employeeId,
        runId: { $in: finalizedRunIds },
      })
        .sort({ month: -1 })
        .populate("runId", "status")
        .lean();
      const leaveBalance = await getLeaveBalances(
        req.user.employeeId,
        Number(today.slice(0, 4)),
      );
      const monthStart = `${thisMonth}-01`;
      const monthAttendance = await Attendance.find({
        employeeId: req.user.employeeId,
        date: { $gte: monthStart, $lte: today },
      })
        .select("status")
        .lean();
      personal = {
        hours: Number(totalHours.toFixed(1)),
        weekStart,
        lateCount: monthAttendance.filter((row) => row.status === "late")
          .length,
        leaveBalance,
        lastPayslip:
          latestPayslip?.runId?.status === "finalized" ? latestPayslip : null,
      };
    }

    res.json({
      company: organization.company,
      role: req.user.role,
      headcount: analytics.headcount,
      hrCount: hrCount || 0,
      present: counts.present,
      late: counts.late,
      halfDay: counts.half_day,
      onLeave: approvedToday,
      pendingLeaves: req.user.role === "employee" ? 0 : pendingLeaves,
      attendanceToday: counts,
      leaveCounts: { pending: pendingLeaves },
      analytics,
      personal,
      recentActivity: recentActivity.map((entry) => ({
        id: entry._id.toString(),
        actor_name: entry.actorName,
        action: entry.action,
        entity: entry.entity,
        created_at: entry.createdAt,
      })),
      announcements: announcements.map((entry) => ({
        ...entry,
        id: entry._id.toString(),
      })),
    });
  }),
);

export default router;
