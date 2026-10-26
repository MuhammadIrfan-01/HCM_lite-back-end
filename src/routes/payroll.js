import { Router } from "express";
import PDFDocument from "pdfkit";
import { withTransaction } from "../storage.js";
import {
  Attendance,
  Employee,
  Holiday,
  LeaveRequest,
  LeaveType,
  Notification,
  PayrollRun,
  Payslip,
  User,
} from "../models.js";
import { asyncRoute, authenticate, allowRoles } from "../middleware.js";
import {
  calculateAnnualTax,
  getOrganizationSettings,
  writeAudit,
  workingDays,
  getSetting,
  localDateString,
  workdayHasEnded,
} from "../services.js";

const router = Router();
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthBounds(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const endDate = new Date(Date.UTC(year, monthNumber, 0))
    .toISOString()
    .slice(0, 10);
  return { startDate, endDate, year, monthNumber };
}

async function employeeWorkdayCount(
  employee,
  startDate,
  endDate,
  weekend,
  holidayDates,
) {
  const effectiveStart =
    employee.joiningDate > startDate ? employee.joiningDate : startDate;
  const effectiveEnd =
    employee.exitDate && employee.exitDate < endDate
      ? employee.exitDate
      : endDate;
  if (effectiveStart > effectiveEnd) return 0;

  const weekends = new Set(weekend.map(Number));
  let count = 0;
  const current = new Date(`${effectiveStart}T12:00:00Z`);
  const end = new Date(`${effectiveEnd}T12:00:00Z`);
  while (current <= end) {
    const date = current.toISOString().slice(0, 10);
    if (!weekends.has(current.getUTCDay()) && !holidayDates.has(date))
      count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}

async function preparePayslips(month) {
  if (!monthPattern.test(month))
    throw Object.assign(new Error("Month must use YYYY-MM format."), {
      status: 422,
    });
  const { startDate, endDate: monthEnd } = monthBounds(month);
  const settings = await getOrganizationSettings();
  const today = localDateString();
  const currentMonth = today.slice(0, 7);
  if (month > currentMonth)
    throw Object.assign(
      new Error("Payroll cannot be prepared for a future month."),
      {
        status: 422,
      },
    );
  let endDate = monthEnd;
  if (month === currentMonth) {
    endDate = today;
    if (!workdayHasEnded(today, settings.officeEnd)) {
      const previousDay = new Date(`${today}T12:00:00Z`);
      previousDay.setUTCDate(previousDay.getUTCDate() - 1);
      endDate = previousDay.toISOString().slice(0, 10);
    }
  }
  const holidays = await Holiday.find({
    date: { $gte: startDate, $lte: endDate },
  })
    .select("date")
    .lean();
  const holidayDates = new Set(holidays.map(({ date }) => date));
  const employees = await Employee.find({
    joiningDate: { $lte: endDate },
    $or: [
      { status: { $in: ["active", "probation"] } },
      { status: "inactive", exitDate: { $gte: startDate, $lte: endDate } },
    ],
  }).sort({ name: 1 });
  const totalWorkingDays = await workingDays(startDate, endDate);
  const configuredLeaveTypes = await LeaveType.find()
    .select("name paid")
    .lean();
  const unpaidTypes = new Set(
    configuredLeaveTypes.filter((type) => !type.paid).map((type) => type.name),
  );
  const slips = [];

  for (const employee of employees) {
    const eligibleDays = await employeeWorkdayCount(
      employee,
      startDate,
      endDate,
      settings.weekend,
      holidayDates,
    );
    if (!eligibleDays) continue;

    const attendance = await Attendance.find({
      employeeId: employee.id,
      date: { $gte: startDate, $lte: endDate },
    })
      .select("date status")
      .lean();
    const attendanceByDate = new Map(
      attendance.map((row) => [row.date, row.status]),
    );
    const approvedLeave = await LeaveRequest.find({
      employeeId: employee.id,
      status: "approved",
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    })
      .select("type startDate endDate")
      .lean();
    const unpaidDates = new Set();
    const leaveDates = new Set();

    for (const leave of approvedLeave) {
      const current = new Date(`${leave.startDate}T12:00:00Z`);
      const end = new Date(`${leave.endDate}T12:00:00Z`);
      while (current <= end) {
        const date = current.toISOString().slice(0, 10);
        if (
          date >= startDate &&
          date <= endDate &&
          !holidayDates.has(date) &&
          !settings.weekend.map(Number).includes(current.getUTCDay())
        ) {
          leaveDates.add(date);
          if (unpaidTypes.has(leave.type)) unpaidDates.add(date);
        }
        current.setUTCDate(current.getUTCDate() + 1);
      }
    }

    let absentDays = 0;
    let halfDays = 0;
    const current = new Date(
      `${employee.joiningDate > startDate ? employee.joiningDate : startDate}T12:00:00Z`,
    );
    const finalDate = new Date(
      `${employee.exitDate && employee.exitDate < endDate ? employee.exitDate : endDate}T12:00:00Z`,
    );
    const weekends = new Set(settings.weekend.map(Number));
    while (current <= finalDate) {
      const date = current.toISOString().slice(0, 10);
      if (!weekends.has(current.getUTCDay()) && !holidayDates.has(date)) {
        if (unpaidDates.has(date)) {
          // Deducted as unpaid leave below rather than counted as an absence.
        } else if (leaveDates.has(date)) {
          // Approved paid leave is excluded from attendance deductions.
        } else if (attendanceByDate.get(date) === "half_day") {
          halfDays += 1;
        } else if (!attendanceByDate.has(date)) {
          absentDays += 1;
        }
      }
      current.setUTCDate(current.getUTCDate() + 1);
    }

    const unpaidDays = unpaidDates.size;
    const basic =
      employee.basicSalary * (eligibleDays / Math.max(totalWorkingDays, 1));
    const hra =
      employee.basicSalary *
      0.4 *
      (eligibleDays / Math.max(totalWorkingDays, 1));
    const medical =
      employee.basicSalary *
      0.1 *
      (eligibleDays / Math.max(totalWorkingDays, 1));
    const allowances =
      Number(employee.allowances || 0) *
      (eligibleDays / Math.max(totalWorkingDays, 1));
    const gross = basic + hra + medical + allowances;
    const perDay = gross / Math.max(eligibleDays, 1);
    const absentDeduction = perDay * absentDays;
    const unpaidDeduction = perDay * unpaidDays;
    const halfDayDeduction = perDay * 0.5 * halfDays;
    const tax = calculateAnnualTax(gross * 12) / 12;
    const net = Math.max(
      0,
      gross - absentDeduction - unpaidDeduction - halfDayDeduction - tax,
    );

    slips.push({
      employeeId: employee.id,
      employeeName: employee.name,
      employeeCode: employee.code,
      department: employee.department,
      designation: employee.designation,
      month,
      basic: roundMoney(basic),
      hra: roundMoney(hra),
      medical: roundMoney(medical),
      allowances: roundMoney(allowances),
      gross: roundMoney(gross),
      absentDeduction: roundMoney(absentDeduction),
      unpaidDeduction: roundMoney(unpaidDeduction),
      halfDayDeduction: roundMoney(halfDayDeduction),
      tax: roundMoney(tax),
      net: roundMoney(net),
      workingDays: eligibleDays,
    });
  }
  return slips;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

router.get(
  "/payroll/runs",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (_req, res) => {
    const runs = await PayrollRun.find().sort({ month: -1 }).lean();
    const result = await Promise.all(
      runs.map(async (run) => {
        const runId = String(run.id || run._id);
        const count = await Payslip.countDocuments({
          $or: [{ runId }, { month: run.month }],
        });
        return {
          ...run,
          id: runId,
          payslipCount: count,
        };
      }),
    );
    res.json(result);
  }),
);

router.post(
  "/payroll/runs",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const month = String(req.body.month || "");
    if (!monthPattern.test(month))
      return res
        .status(422)
        .json({ error: "Choose a month in YYYY-MM format." });
    const existing = await PayrollRun.findOne({ month });
    if (existing?.status === "finalized")
      return res
        .status(409)
        .json({ error: "This payroll month is finalized and locked." });

    const slips = await preparePayslips(month);
    let run;
    await withTransaction(async () => {
      run = await PayrollRun.findOneAndUpdate(
        { month },
        {
          $set: {
            month,
            status: "draft",
            totalGross: roundMoney(
              slips.reduce((sum, slip) => sum + slip.gross, 0),
            ),
            totalNet: roundMoney(
              slips.reduce((sum, slip) => sum + slip.net, 0),
            ),
            createdBy: req.user.id,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      const runId = String(run.id || run._id);
      await Payslip.deleteMany({
        $or: [{ runId }, { month: run.month }],
      });
      if (slips.length)
        await Payslip.insertMany(
          slips.map((slip) => ({ ...slip, runId })),
        );
    });

    const runId = String(run.id || run._id);
    await writeAudit(
      req.user,
      existing ? "update" : "create",
      "payroll_run",
      runId,
      existing?.toJSON() || null,
      run.toJSON(),
    );
    res
      .status(existing ? 200 : 201)
      .json({ ...run.toJSON(), id: runId, payslipCount: slips.length });
  }),
);

router.post(
  "/payroll/runs/:id/finalize",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (req, res) => {
    const idParam = String(req.params.id || "").trim();
    let run = await PayrollRun.findById(idParam);
    if (!run && monthPattern.test(idParam)) {
      run = await PayrollRun.findOne({ month: idParam });
    }
    if (!run && (idParam === "[object Object]" || idParam === "undefined" || !idParam)) {
      run = await PayrollRun.findOne({ status: "draft" }).sort({ month: -1 });
    }
    if (!run) return res.status(404).json({ error: "Payroll run not found." });
    if (run.status === "finalized")
      return res
        .status(409)
        .json({ error: "This payroll run is already finalized." });
    const before = run.toJSON();
    run.status = "finalized";
    run.finalizedBy = req.user.id;
    run.finalizedAt = new Date();
    await run.save();
    const runId = String(run.id || run._id);

    await writeAudit(
      req.user,
      "finalize",
      "payroll_run",
      runId,
      before,
      run.toJSON(),
    );

    // Repair any legacy payslips for this month that had runId: "[object Object]"
    await Payslip.updateMany(
      { month: run.month, runId: { $in: ["[object Object]", null, ""] } },
      { $set: { runId } },
    );

    const slips = await Payslip.find({
      $or: [{ runId }, { month: run.month }],
    })
      .select("employeeId")
      .lean();
    const users = await User.find({
      employeeId: { $in: slips.map((slip) => slip.employeeId) },
    })
      .select("_id")
      .lean();
    if (users.length) {
      await Notification.insertMany(
        users.map((user) => ({
          userId: user._id,
          message: `Your ${run.month} payslip is ready to download.`,
        })),
      );
    }
    res.json({
      ...run.toJSON(),
      id: runId,
    });
  }),
);

router.get(
  "/payslips",
  authenticate,
  asyncRoute(async (req, res) => {
    const filter = {};
    if (req.user.role === "employee") {
      let empId = req.user.employeeId;
      if (!empId) {
        const emp = await Employee.findOne({ email: req.user.email });
        empId = emp ? String(emp._id || emp.id) : null;
      }
      filter.$or = [
        { employeeId: empId },
        { employeeName: req.user.name },
      ];
    } else if (req.query.employeeId) {
      filter.employeeId = String(req.query.employeeId);
    }
    if (req.query.month) filter.month = String(req.query.month);

    const finalizedRuns = await PayrollRun.find({ status: "finalized" })
      .select("_id month")
      .lean();
    const finalizedMonths = new Set(finalizedRuns.map((r) => r.month));
    const finalizedRunIds = new Set(
      finalizedRuns.flatMap((r) => [String(r.id || ""), String(r._id || "")]),
    );

    const slips = await Payslip.find(filter)
      .populate("runId", "status")
      .sort({ month: -1 })
      .lean();
    res.json(
      slips.map((slip) => {
        const isFinalized =
          slip.runId?.status === "finalized" ||
          finalizedMonths.has(slip.month) ||
          finalizedRunIds.has(String(slip.runId));
        return {
          ...slip,
          id: slip._id?.toString() || slip.id,
          finalized: Boolean(isFinalized),
        };
      }),
    );
  }),
);

router.get(
  "/payslips/:id/pdf",
  authenticate,
  asyncRoute(async (req, res) => {
    const slip = await Payslip.findById(req.params.id).populate(
      "runId",
      "status",
    );
    if (!slip) return res.status(404).json({ error: "Payslip not found." });

    let isFinalized = slip.runId?.status === "finalized";
    if (!isFinalized && slip.month) {
      const run = await PayrollRun.findOne({ month: slip.month });
      if (run?.status === "finalized") isFinalized = true;
    }

    if (!isFinalized && req.user.role === "employee") {
      return res
        .status(409)
        .json({ error: "Payslips are available after payroll is finalized." });
    }
    let userEmployeeId = req.user.employeeId;
    if (!userEmployeeId && req.user.role === "employee") {
      const emp = await Employee.findOne({ email: req.user.email });
      userEmployeeId = emp ? String(emp._id || emp.id) : null;
    }
    if (
      req.user.role === "employee" &&
      String(slip.employeeId) !== String(userEmployeeId)
    ) {
      return res
        .status(403)
        .json({ error: "You can only download your own payslip." });
    }

    const company = await getSetting("company_name", "HCM Lite");
    const document = new PDFDocument({ size: "A4", margin: 52 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="payslip-${slip.month}-${slip.employeeCode}.pdf"`,
    );
    document.pipe(res);
    document.fontSize(20).fillColor("#5c4bc8").text(company, { align: "left" });
    document
      .moveDown(0.4)
      .fontSize(12)
      .fillColor("#333333")
      .text(`Payslip · ${slip.month}${!isFinalized ? " (DRAFT COPY)" : ""}`);
    document
      .moveDown()
      .fontSize(10)
      .text(`${slip.employeeName} (${slip.employeeCode})`);
    document.text(`${slip.designation} · ${slip.department}`);
    document.moveDown().text(`Eligible working days: ${slip.workingDays}`);
    document.moveDown().fontSize(12).text("Earnings", { underline: true });
    document.fontSize(10);
    writePdfLine(document, "Basic salary", slip.basic);
    writePdfLine(document, "House rent allowance", slip.hra);
    writePdfLine(document, "Medical allowance", slip.medical);
    writePdfLine(document, "Additional allowances", slip.allowances);
    writePdfLine(document, "Gross pay", slip.gross, true);
    document.moveDown().fontSize(12).text("Deductions", { underline: true });
    document.fontSize(10);
    writePdfLine(document, "Absent days", slip.absentDeduction);
    writePdfLine(document, "Unpaid leave", slip.unpaidDeduction);
    writePdfLine(document, "Half days", slip.halfDayDeduction);
    writePdfLine(document, "Illustrative income tax", slip.tax);
    document
      .moveDown()
      .fontSize(14)
      .fillColor("#333333")
      .text(
        `Net pay: PKR ${slip.net.toLocaleString("en-PK", { minimumFractionDigits: 2 })}`,
        { align: "right" },
      );
    document
      .moveDown(2)
      .fontSize(8)
      .fillColor("#888888")
      .text(
        isFinalized
          ? "Tax estimate is illustrative and should be reviewed against current payroll rules."
          : "DRAFT PREVIEW - This payroll run has not yet been finalized by Administration.",
      );
    document.end();
  }),
);

function writePdfLine(document, label, amount, bold = false) {
  const value = `PKR ${Number(amount).toLocaleString("en-PK", { minimumFractionDigits: 2 })}`;
  document
    .font(bold ? "Helvetica-Bold" : "Helvetica")
    .text(label, { continued: true });
  document.text(value, { align: "right" });
}

export default router;
