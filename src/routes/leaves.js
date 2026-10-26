import { Router } from "express";
import {
  Employee,
  LeaveRequest,
  LeaveType,
  Notification,
  User,
} from "../models.js";
import { asyncRoute, authenticate, allowRoles } from "../middleware.js";
import {
  isValidIsoDate,
  localDateString,
  workingDays,
  writeAudit,
} from "../services.js";

const router = Router();

async function daysByYear(startDate, endDate) {
  const parts = new Map();
  const current = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (current <= end) {
    const year = current.getUTCFullYear();
    const firstDay = `${year}-01-01`;
    const lastDay = `${year}-12-31`;
    const bucketStart = current.toISOString().slice(0, 10);
    const bucketEnd = new Date(
      Math.min(end.getTime(), Date.parse(`${lastDay}T12:00:00Z`)),
    )
      .toISOString()
      .slice(0, 10);
    parts.set(year, { start: bucketStart, end: bucketEnd, firstDay, lastDay });
    current.setUTCFullYear(year + 1, 0, 1);
  }
  const totals = new Map();
  for (const [year, range] of parts)
    totals.set(year, await workingDays(range.start, range.end));
  return totals;
}

export async function getLeaveBalances(
  employeeId,
  year = new Date().getFullYear(),
) {
  const types = await LeaveType.find({ active: true }).sort({ name: 1 }).lean();
  const balances = [];
  for (const type of types) {
    const approved = await LeaveRequest.find({
      employeeId,
      type: type.name,
      status: "approved",
      startDate: { $lte: `${year}-12-31` },
      endDate: { $gte: `${year}-01-01` },
    })
      .select("startDate endDate")
      .lean();
    let used = 0;
    for (const request of approved) {
      const clippedStart =
        request.startDate < `${year}-01-01`
          ? `${year}-01-01`
          : request.startDate;
      const clippedEnd =
        request.endDate > `${year}-12-31` ? `${year}-12-31` : request.endDate;
      used += await workingDays(clippedStart, clippedEnd);
    }
    balances.push({
      type: type.name,
      quota: type.quota,
      used,
      remaining: type.quota === 0 ? null : Math.max(0, type.quota - used),
      paid: type.paid,
    });
  }
  return balances;
}

router.get(
  "/leaves/balance",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json({
      year,
      balances: await getLeaveBalances(req.user.employeeId, year),
    });
  }),
);

router.get(
  "/leaves",
  authenticate,
  asyncRoute(async (req, res) => {
    const filter = {};
    if (req.user.role === "employee") filter.employeeId = req.user.employeeId;
    else if (req.query.employeeId)
      filter.employeeId = String(req.query.employeeId);
    if (req.query.status) filter.status = req.query.status;
    const requests = await LeaveRequest.find(filter)
      .populate("employeeId", "name code department")
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    res.json(
      requests.map((request) => ({
        ...request,
        id: request._id.toString(),
        employee_id: request.employeeId?._id?.toString(),
        name: request.employeeId?.name,
        code: request.employeeId?.code,
        department: request.employeeId?.department,
        start_date: request.startDate,
        end_date: request.endDate,
      })),
    );
  }),
);

router.post(
  "/leaves",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const type = String(req.body.type || "").toLowerCase();
    const startDate = String(req.body.startDate || "");
    const endDate = String(req.body.endDate || "");
    const reason = String(req.body.reason || "").trim();
    if (
      !isValidIsoDate(startDate) ||
      !isValidIsoDate(endDate) ||
      endDate < startDate ||
      !reason
    ) {
      return res
        .status(422)
        .json({ error: "Choose a valid leave type, date range, and reason." });
    }

    const leaveType = await LeaveType.findOne({
      name: type,
      active: true,
    }).lean();
    if (!leaveType)
      return res.status(422).json({ error: "Choose an active leave type." });
    const days = await workingDays(startDate, endDate);
    if (days < 1)
      return res
        .status(422)
        .json({ error: "The selected dates contain no working days." });

    const overlap = await LeaveRequest.exists({
      employeeId: req.user.employeeId,
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    });
    if (overlap)
      return res.status(422).json({
        error: "This request overlaps another pending or approved request.",
      });

    if (leaveType.quota > 0) {
      const yearlyDays = await daysByYear(startDate, endDate);
      for (const [year, requestDays] of yearlyDays) {
        const approved = await LeaveRequest.find({
          employeeId: req.user.employeeId,
          type,
          status: { $in: ["approved", "pending"] },
          startDate: { $lte: `${year}-12-31` },
          endDate: { $gte: `${year}-01-01` },
        })
          .select("startDate endDate")
          .lean();
        let alreadyRequested = 0;
        for (const request of approved) {
          const requestStart =
            request.startDate < `${year}-01-01`
              ? `${year}-01-01`
              : request.startDate;
          const requestEnd =
            request.endDate > `${year}-12-31`
              ? `${year}-12-31`
              : request.endDate;
          alreadyRequested += await workingDays(requestStart, requestEnd);
        }
        if (alreadyRequested + requestDays > leaveType.quota) {
          return res.status(422).json({
            error: `This request exceeds your ${year} ${type} leave balance.`,
          });
        }
      }
    }

    const leave = await LeaveRequest.create({
      employeeId: req.user.employeeId,
      type,
      startDate,
      endDate,
      days,
      reason,
    });
    await writeAudit(
      req.user,
      "create",
      "leave_request",
      leave.id,
      null,
      leave.toJSON(),
    );
    res.status(201).json({
      ...leave.toJSON(),
      start_date: leave.startDate,
      end_date: leave.endDate,
    });
  }),
);

router.post(
  "/leaves/:id/cancel",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const leave = await LeaveRequest.findOne({
      _id: req.params.id,
      employeeId: req.user.employeeId,
    });
    if (!leave)
      return res.status(404).json({ error: "Leave request not found." });
    if (!["pending", "approved"].includes(leave.status))
      return res
        .status(409)
        .json({ error: "This request can no longer be cancelled." });
    if (leave.status === "approved" && leave.startDate <= localDateString()) {
      return res.status(409).json({
        error: "Approved leave can only be cancelled before it starts.",
      });
    }
    const before = leave.toJSON();
    leave.status = "cancelled";
    await leave.save();
    await writeAudit(
      req.user,
      "cancel",
      "leave_request",
      leave.id,
      before,
      leave.toJSON(),
    );
    res.json(leave);
  }),
);

router.patch(
  "/leaves/:id/review",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!["approved", "rejected"].includes(status))
      return res.status(422).json({ error: "Choose approve or reject." });
    const comment =
      String(req.body.comment || "").trim() ||
      (status === "approved" ? "Approved" : "Rejected");
    const leave = await LeaveRequest.findById(req.params.id).populate(
      "employeeId",
      "name",
    );
    if (!leave)
      return res.status(404).json({ error: "Leave request not found." });
    if (leave.status !== "pending")
      return res
        .status(409)
        .json({ error: "This request has already been reviewed." });
    const before = leave.toJSON();
    const employeeId =
      leave.employeeId?.id ||
      leave.employeeId?._id ||
      leave.employeeId?.toString() ||
      leave.employeeId;
    leave.status = status;
    leave.comment = comment;
    leave.reviewedBy = req.user.id;
    leave.employeeId = employeeId;
    await leave.save();
    await writeAudit(
      req.user,
      status,
      "leave_request",
      leave.id || leave._id?.toString(),
      before,
      leave.toJSON(),
    );

    const employeeUser = await User.findOne({ employeeId })
      .select("_id")
      .lean();
    if (employeeUser) {
      await Notification.create({
        userId: employeeUser._id,
        message: `Your ${leave.type} leave request for ${leave.startDate} to ${leave.endDate} was ${status}.`,
      });
    }
    res.json(leave);
  }),
);

router.get(
  "/leave-types",
  authenticate,
  asyncRoute(async (_req, res) => {
    const types = await LeaveType.find({ active: { $ne: false } })
      .sort({ name: 1 })
      .lean();
    res.json(types.map((type) => ({ ...type, id: type._id.toString() })));
  }),
);

export default router;
