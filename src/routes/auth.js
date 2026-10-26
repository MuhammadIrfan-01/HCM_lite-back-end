import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Company, LeaveType, Setting, User } from "../models.js";
import { runWithTenant } from "../tenant-context.js";
import {
  asyncRoute,
  authenticate,
  allowRoles,
  issueToken,
} from "../middleware.js";
import { getSetting, setSetting, writeAudit } from "../services.js";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (user) => ({
  id: user.id || user._id.toString(),
  name: user.name,
  email: user.email,
  role: user.role,
  employeeId: user.employeeId?.toString() || null,
  mustChangePassword: Boolean(user.mustChangePassword),
  companyId: user.companyId?.toString() || null,
});

router.get(
  "/setup/status",
  asyncRoute(async (_req, res) => {
    res.json({
      complete: Boolean(await Company.exists({})),
      company: "",
    });
  }),
);

router.post(
  "/auth/admin-signup",
  asyncRoute(async (req, res) => {
    const company = String(req.body.company || "").trim();
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const officeStart = String(req.body.officeStart || "09:00");
    const graceMinutes = Number(req.body.graceMinutes ?? 15);
    if (!company || !name || !emailPattern.test(email) || password.length < 10)
      return res.status(422).json({
        error:
          "Enter a company, admin name, valid email, and password with at least 10 characters.",
      });
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(officeStart) ||
      !Number.isInteger(graceMinutes) ||
      graceMinutes < 0 ||
      graceMinutes > 180
    )
      return res
        .status(422)
        .json({ error: "Check the office start time and grace period." });
    const normalizedName = company.toLowerCase();
    if (await Company.exists({ normalizedName }))
      return res
        .status(409)
        .json({ error: "A company already uses this name." });

    let companyRecord;
    try {
      companyRecord = await Company.create({
        name: company,
        normalizedName,
      });
      const user = await User.create({
        name,
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: "admin",
        companyId: companyRecord._id,
      });
      await runWithTenant(companyRecord._id, async () => {
        await Promise.all([
          setSetting("company_name", company),
          setSetting("office_start", officeStart),
          setSetting("office_end", "17:00"),
          setSetting("grace_minutes", graceMinutes),
          setSetting("weekend", [0, 6]),
          setSetting("half_day_hours", 5),
          setSetting("office_radius_meters", 150),
          LeaveType.bulkWrite(
            ["annual", "sick", "casual", "unpaid"].map((leaveName) => ({
              updateOne: {
                filter: { name: leaveName, companyId: companyRecord._id },
                update: {
                  $setOnInsert: {
                    name: leaveName,
                    quota:
                      leaveName === "annual"
                        ? 14
                        : leaveName === "sick"
                          ? 8
                          : leaveName === "casual"
                            ? 10
                            : 0,
                    paid: leaveName !== "unpaid",
                    companyId: companyRecord._id,
                  },
                },
                upsert: true,
              },
            })),
          ),
        ]);
      });
      res
        .status(201)
        .json({ token: issueToken(user), user: publicUser(user), company });
    } catch (error) {
      if (companyRecord) {
        await Promise.allSettled([
          User.deleteMany({ companyId: companyRecord._id }),
          Setting.deleteMany({ companyId: companyRecord._id }),
          LeaveType.deleteMany({ companyId: companyRecord._id }),
          Company.deleteOne({ _id: companyRecord._id }),
        ]);
      }
      throw error;
    }
  }),
);

router.post(
  "/auth/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const role = String(req.body.role || "");
    const company = String(req.body.company || "")
      .trim()
      .toLowerCase();
    if (!["admin", "hr", "employee"].includes(role))
      return res.status(422).json({ error: "Choose Admin, HR, or Employee." });
    if (!company)
      return res.status(422).json({ error: "Enter your company name." });
    const companyRecord = await Company.findOne({
      normalizedName: company,
      active: true,
    }).lean();
    const user = companyRecord
      ? await User.findOne({
          email,
          role,
          companyId: companyRecord._id,
          active: true,
        })
      : null;
    if (
      !user ||
      user.role !== role ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    res.json({
      token: issueToken(user),
      user: publicUser(user),
      company: companyRecord.name,
    });
  }),
);

router.get(
  "/auth/me",
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({ user: req.user, company: await getSetting("company_name", "") });
  }),
);

router.post(
  "/auth/change-password",
  authenticate,
  asyncRoute(async (req, res) => {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    const user = await User.findById(req.user.id);

    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    if (newPassword.length < 10) {
      return res
        .status(422)
        .json({ error: "New password must be at least 10 characters." });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.mustChangePassword = false;
    await user.save();
    await writeAudit(req.user, "change_password", "user", user.id, null, {
      changed: true,
    });
    res.json({ ok: true });
  }),
);

router.get(
  "/users/hr",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (_req, res) => {
    const users = await User.find({ role: "hr" })
      .select("name email active createdAt")
      .sort({ name: 1 })
      .lean();
    res.json(
      users.map((user) => ({
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        active: user.active,
        createdAt: user.createdAt,
      })),
    );
  }),
);

router.post(
  "/users/hr",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    if (!name || !emailPattern.test(email) || password.length < 10)
      return res.status(422).json({
        error:
          "Enter a name, valid work email, and password with at least 10 characters.",
      });
    if (await User.exists({ email })) {
      return res
        .status(409)
        .json({ error: "An account already uses this email address." });
    }

    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: "hr",
    });
    await writeAudit(req.user, "create", "user", user.id, null, {
      name,
      email,
      role: "hr",
    });
    res.status(201).json({ user: publicUser(user) });
  }),
);

router.patch(
  "/users/:id/active",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role === "admin")
      return res.status(404).json({ error: "Account not found." });
    if (typeof req.body.active !== "boolean")
      return res
        .status(422)
        .json({ error: "Account status must be active or inactive." });
    const before = { active: user.active };
    user.active = req.body.active;
    await user.save();
    await writeAudit(
      req.user,
      user.active ? "activate" : "deactivate",
      "user",
      user.id,
      before,
      { active: user.active },
    );
    res.json({ id: user.id, active: user.active });
  }),
);

router.post(
  "/users/:id/reset-password",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user || user.role === "admin")
      return res.status(404).json({ error: "Account not found." });
    const temporaryPassword = crypto.randomBytes(12).toString("base64url");
    user.passwordHash = await bcrypt.hash(temporaryPassword, 12);
    user.mustChangePassword = true;
    await user.save();
    await writeAudit(req.user, "reset_password", "user", user.id, null, {
      reset: true,
    });
    res.json({ temporaryPassword });
  }),
);

export default router;
