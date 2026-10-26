import { Router } from "express";
import {
  Company,
  Department,
  Designation,
  Holiday,
  LeaveType,
} from "../models.js";
import { asyncRoute, authenticate, allowRoles } from "../middleware.js";
import {
  getOrganizationSettings,
  setSetting,
  writeAudit,
  isValidIsoDate,
} from "../services.js";

const router = Router();
const canViewSetup = [authenticate];
const canManageSetup = [authenticate, allowRoles("admin", "hr")];

router.get(
  "/settings",
  ...canViewSetup,
  asyncRoute(async (_req, res) => {
    res.json(await getOrganizationSettings());
  }),
);

router.put(
  "/settings",
  ...canManageSetup,
  asyncRoute(async (req, res) => {
    const before = await getOrganizationSettings();
    let companyRecord;
    if (req.body.company !== undefined) {
      const companyName = String(req.body.company).trim();
      if (!companyName)
        return res.status(422).json({ error: "Company name is required." });
      companyRecord = await Company.findById(req.user.companyId);
      if (!companyRecord)
        return res.status(404).json({ error: "Company workspace not found." });
      const normalizedName = companyName.toLowerCase();
      if (
        normalizedName !== companyRecord.normalizedName &&
        (await Company.exists({
          normalizedName,
          _id: { $ne: companyRecord._id },
        }))
      ) {
        return res
          .status(409)
          .json({ error: "A company already uses this name." });
      }
    }
    const allowed = {
      company: "company_name",
      officeStart: "office_start",
      officeEnd: "office_end",
      graceMinutes: "grace_minutes",
      halfDayHours: "half_day_hours",
      weekend: "weekend",
      officeLatitude: "office_latitude",
      officeLongitude: "office_longitude",
      officeRadiusMeters: "office_radius_meters",
    };

    for (const [field, key] of Object.entries(allowed)) {
      if (req.body[field] === undefined) continue;
      const value = req.body[field];
      if (field === "officeStart" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        return res
          .status(422)
          .json({ error: "Office start must use HH:MM format." });
      }
      if (field === "officeEnd" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        return res
          .status(422)
          .json({ error: "Office end must use HH:MM format." });
      }
      if (
        field === "graceMinutes" &&
        (!Number.isInteger(Number(value)) || value < 0 || value > 180)
      ) {
        return res
          .status(422)
          .json({ error: "Grace period must be between 0 and 180 minutes." });
      }
      if (
        field === "halfDayHours" &&
        (!Number.isFinite(Number(value)) || value <= 0 || value > 12)
      ) {
        return res
          .status(422)
          .json({ error: "Half-day hours must be between 0 and 12." });
      }
      if (
        field === "weekend" &&
        (!Array.isArray(value) ||
          value.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
      ) {
        return res
          .status(422)
          .json({ error: "Weekend must be a list of weekdays from 0 to 6." });
      }
      if (
        field === "officeLatitude" &&
        value !== null &&
        (!Number.isFinite(Number(value)) || Math.abs(value) > 90)
      ) {
        return res
          .status(422)
          .json({ error: "Latitude must be between -90 and 90." });
      }
      if (
        field === "officeLongitude" &&
        value !== null &&
        (!Number.isFinite(Number(value)) || Math.abs(value) > 180)
      ) {
        return res
          .status(422)
          .json({ error: "Longitude must be between -180 and 180." });
      }
      if (
        field === "officeRadiusMeters" &&
        (!Number.isFinite(Number(value)) || value < 10 || value > 10_000)
      ) {
        return res.status(422).json({
          error: "Office radius must be between 10 and 10,000 meters.",
        });
      }
    }

    if (companyRecord && req.body.company !== undefined) {
      companyRecord.name = String(req.body.company).trim();
      companyRecord.normalizedName = companyRecord.name.toLowerCase();
      await companyRecord.save();
    }
    for (const [field, key] of Object.entries(allowed)) {
      if (req.body[field] === undefined) continue;
      let value = req.body[field];
      if (field === "company") value = String(value).trim();
      if (field === "weekend") value = value.map(Number);
      if (
        ["graceMinutes", "halfDayHours", "officeRadiusMeters"].includes(field)
      )
        value = Number(value);
      if (["officeLatitude", "officeLongitude"].includes(field))
        value = value === null || value === "" ? null : Number(value);
      await setSetting(key, value);
    }

    const after = await getOrganizationSettings();
    await writeAudit(
      req.user,
      "update",
      "settings",
      "organization",
      before,
      after,
    );
    res.json(after);
  }),
);

const resources = [
  {
    path: "/departments",
    Model: Department,
    label: "department",
    roles: ["admin", "hr"],
  },
  {
    path: "/designations",
    Model: Designation,
    label: "designation",
    roles: ["admin", "hr"],
  },
  {
    path: "/leave-types",
    Model: LeaveType,
    label: "leave type",
    roles: ["admin", "hr"],
  },
];

for (const { path, Model, label, roles } of resources) {
  const canManageResource = [
    authenticate,
    allowRoles(...(roles || ["admin", "hr"])),
  ];

  router.get(
    path,
    ...canViewSetup,
    asyncRoute(async (_req, res) => {
      res.json(
        await Model.find({ active: { $ne: false } })
          .sort({ name: 1 })
          .lean(),
      );
    }),
  );

  router.post(
    path,
    ...canManageResource,
    asyncRoute(async (req, res) => {
      const name = String(req.body.name || "")
        .trim()
        .toLowerCase();
      if (!name)
        return res.status(422).json({ error: `Enter a ${label} name.` });
      const values = { name, active: true };
      if (Model === Department)
        values.description = String(req.body.description || "").trim();
      if (Model === Designation)
        values.department = String(req.body.department || "").trim();
      if (Model === LeaveType) {
        values.quota = req.body.quota === "" ? 0 : Number(req.body.quota);
        values.paid = Boolean(req.body.paid);
        if (!Number.isFinite(values.quota) || values.quota < 0)
          return res.status(422).json({ error: "Quota must be zero or more." });
      }
      const record = await Model.create(values);
      await writeAudit(
        req.user,
        "create",
        label,
        record.id,
        null,
        record.toJSON(),
      );
      res.status(201).json(record);
    }),
  );

  router.put(
    `${path}/:id`,
    ...canManageResource,
    asyncRoute(async (req, res) => {
      const record = await Model.findById(req.params.id);
      if (!record)
        return res.status(404).json({ error: `${label} not found.` });
      const before = record.toJSON();
      if (req.body.name !== undefined)
        record.name = String(req.body.name).trim().toLowerCase();
      if (req.body.description !== undefined && Model === Department)
        record.description = String(req.body.description).trim();
      if (req.body.department !== undefined && Model === Designation)
        record.department = String(req.body.department).trim();
      if (req.body.quota !== undefined && Model === LeaveType) {
        const quota = Number(req.body.quota);
        if (!Number.isFinite(quota) || quota < 0)
          return res.status(422).json({ error: "Quota must be zero or more." });
        record.quota = quota;
      }
      if (req.body.paid !== undefined && Model === LeaveType)
        record.paid = Boolean(req.body.paid);
      await record.save();
      await writeAudit(
        req.user,
        "update",
        label,
        record.id,
        before,
        record.toJSON(),
      );
      res.json(record);
    }),
  );

  router.delete(
    `${path}/:id`,
    ...canManageResource,
    asyncRoute(async (req, res) => {
      const record = await Model.findById(req.params.id);
      if (!record)
        return res.status(404).json({ error: `${label} not found.` });
      const before = record.toJSON();
      record.active = false;
      await record.save();
      await writeAudit(
        req.user,
        "deactivate",
        label,
        record.id,
        before,
        record.toJSON(),
      );
      res.json({ ok: true });
    }),
  );
}

router.get(
  "/holidays",
  ...canViewSetup,
  asyncRoute(async (_req, res) => {
    res.json(await Holiday.find().sort({ date: 1 }).lean());
  }),
);

router.post(
  "/holidays",
  ...canManageSetup,
  asyncRoute(async (req, res) => {
    const date = String(req.body.date || "");
    const name = String(req.body.name || "").trim();
    if (!isValidIsoDate(date) || !name)
      return res
        .status(422)
        .json({ error: "Provide a valid date and holiday name." });
    const holiday = await Holiday.create({ date, name });
    await writeAudit(
      req.user,
      "create",
      "holiday",
      holiday.id,
      null,
      holiday.toJSON(),
    );
    res.status(201).json(holiday);
  }),
);

router.delete(
  "/holidays/:id",
  ...canManageSetup,
  asyncRoute(async (req, res) => {
    const holiday = await Holiday.findById(req.params.id);
    if (!holiday) return res.status(404).json({ error: "Holiday not found." });
    await holiday.deleteOne();
    await writeAudit(
      req.user,
      "delete",
      "holiday",
      holiday.id,
      holiday.toJSON(),
    );
    res.json({ ok: true });
  }),
);

export default router;
