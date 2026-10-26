import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Employee, User, Department } from "../models.js";
import { asyncRoute, authenticate, allowRoles } from "../middleware.js";
import { getSetting, isValidIsoDate, writeAudit } from "../services.js";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function employeeJson(employee, includeSalary = true) {
  const value = employee.toObject ? employee.toObject() : employee;
  const result = {
    ...value,
    id: value._id?.toString() || value.id,
    joining_date: value.joiningDate,
    basic_salary: value.basicSalary,
  };
  delete result._id;
  delete result.__v;
  if (!includeSalary) {
    delete result.basicSalary;
    delete result.allowances;
  }
  return result;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;
  const input = String(text || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"' && insideQuotes && input[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      insideQuotes = !insideQuotes;
    } else if (character === "," && !insideQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !insideQuotes) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) =>
    header
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  return rows.map((values, index) => ({
    row: index + 2,
    record: Object.fromEntries(
      headers.map((header, column) => [header, values[column] || ""]),
    ),
  }));
}

async function checkCsvRows(parsedRows) {
  const knownDepartments = new Set(
    (await Department.find({ active: true }).select("name").lean()).map(
      ({ name }) => name.toLowerCase(),
    ),
  );
  const existingCodes = new Set(
    (await Employee.find().select("code").lean()).map(({ code }) =>
      code.toLowerCase(),
    ),
  );
  const [employeeEmails, accountEmails] = await Promise.all([
    Employee.find().select("email").lean(),
    User.find().select("email").lean(),
  ]);
  const existingEmails = new Set(
    [...employeeEmails, ...accountEmails].map(({ email }) =>
      email.toLowerCase(),
    ),
  );
  const seenCodes = new Set();
  const seenEmails = new Set();

  return parsedRows.map(({ row, record }) => {
    const errors = [];
    const required = [
      "code",
      "name",
      "email",
      "department",
      "designation",
      "joining_date",
      "basic_salary",
    ];
    for (const field of required) {
      if (!record[field])
        errors.push({ field, reason: "Required value is missing." });
    }
    const code = record.code.toLowerCase();
    const email = record.email.toLowerCase();
    if (record.email && !emailPattern.test(email))
      errors.push({ field: "email", reason: "Email address is invalid." });
    if (record.code && (existingCodes.has(code) || seenCodes.has(code)))
      errors.push({
        field: "code",
        reason: "Employee code is already in use.",
      });
    if (record.email && (existingEmails.has(email) || seenEmails.has(email)))
      errors.push({ field: "email", reason: "Email is already in use." });
    if (
      record.department &&
      !knownDepartments.has(record.department.toLowerCase())
    )
      errors.push({
        field: "department",
        reason: "Department does not exist.",
      });
    if (record.joining_date && !isValidIsoDate(record.joining_date))
      errors.push({
        field: "joining_date",
        reason: "Use an ISO date in YYYY-MM-DD format.",
      });
    if (
      record.basic_salary &&
      (!Number.isFinite(Number(record.basic_salary)) ||
        Number(record.basic_salary) <= 0)
    ) {
      errors.push({
        field: "basic_salary",
        reason: "Salary must be greater than zero.",
      });
    }
    if (
      record.allowances &&
      (!Number.isFinite(Number(record.allowances)) ||
        Number(record.allowances) < 0)
    ) {
      errors.push({
        field: "allowances",
        reason: "Allowances must be zero or more.",
      });
    }
    if (record.code) seenCodes.add(code);
    if (record.email) seenEmails.add(email);
    return { row, record, errors };
  });
}

router.get(
  "/employees",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const query = String(req.query.q || "").trim();
    const department = String(req.query.department || "").trim();
    const filter = {};
    if (department) filter.department = department;
    if (req.query.status) filter.status = req.query.status;
    if (query)
      filter.$or = [
        { name: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { code: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        {
          email: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        },
      ];

    const [items, total] = await Promise.all([
      Employee.find(filter)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Employee.countDocuments(filter),
    ]);
    let usersByEmployee = new Map();
    if (req.user.role === "admin" && items.length) {
      const accounts = await User.find({
        role: "employee",
        employeeId: { $in: items.map((employee) => employee._id) },
      })
        .select("_id employeeId active")
        .lean();
      usersByEmployee = new Map(
        accounts.map((account) => [account.employeeId.toString(), account]),
      );
    }
    res.json({
      items: items.map((employee) => {
        const result = employeeJson(employee);
        const account = usersByEmployee.get(employee.id);
        return req.user.role === "admin"
          ? {
              ...result,
              loginUserId: account?._id.toString() || null,
              loginActive: account?.active ?? false,
            }
          : result;
      }),
      total,
      page,
      limit,
    });
  }),
);

router.get(
  "/employees/me",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const employee = await Employee.findById(req.user.employeeId);
    if (!employee)
      return res.status(404).json({ error: "Employee profile not found." });
    res.json(employeeJson(employee, false));
  }),
);

router.post(
  "/employees/:id/reset-password",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (req, res) => {
    const employee = await Employee.findById(req.params.id).select(
      "name email",
    );
    if (!employee)
      return res.status(404).json({ error: "Employee not found." });
    const user = await User.findOne({
      employeeId: employee.id,
      role: "employee",
    });
    if (!user)
      return res.status(404).json({ error: "Employee login not found." });
    const temporaryPassword = crypto.randomBytes(12).toString("base64url");
    user.passwordHash = await bcrypt.hash(temporaryPassword, 12);
    user.mustChangePassword = true;
    await user.save();
    await writeAudit(req.user, "reset_password", "user", user.id, null, {
      employeeId: employee.id,
      email: employee.email,
    });
    res.json({ temporaryPassword });
  }),
);

router.get(
  "/employees/:id",
  authenticate,
  asyncRoute(async (req, res) => {
    if (req.user.role === "employee" && req.user.employeeId !== req.params.id) {
      return res
        .status(403)
        .json({ error: "You can only view your own employee profile." });
    }
    const employee = await Employee.findById(req.params.id);
    if (!employee)
      return res.status(404).json({ error: "Employee not found." });
    res.json(employeeJson(employee, req.user.role !== "employee"));
  }),
);

router.post(
  "/employees",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const code = String(req.body.code || "")
      .trim()
      .toUpperCase();
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const department = String(req.body.department || "").trim();
    const designation = String(req.body.designation || "").trim();
    const joiningDate = String(req.body.joiningDate || "").trim();
    const basicSalary = Number(req.body.basicSalary);
    const allowances = Number(req.body.allowances || 0);
    const fields = [code, name, email, department, designation, joiningDate];
    if (fields.some((field) => !field)) {
      return res.status(422).json({ error: "Complete all required fields." });
    }
    if (!emailPattern.test(email))
      return res.status(422).json({ error: "Enter a valid email address." });
    if (!isValidIsoDate(joiningDate))
      return res
        .status(422)
        .json({ error: "Enter a valid joining date in YYYY-MM-DD format." });
    if (!Number.isFinite(basicSalary) || basicSalary <= 0) {
      return res
        .status(422)
        .json({ error: "Salary must be greater than zero." });
    }
    if (!Number.isFinite(allowances) || allowances < 0) {
      return res
        .status(422)
        .json({ error: "Allowances must be zero or more." });
    }
    const departmentPattern = new RegExp(
      `^${department.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
    let matchedDepartment = await Department.findOne({
      name: departmentPattern,
      active: true,
    });
    if (!matchedDepartment) {
      const allActive = await Department.find({ active: true }).lean();
      matchedDepartment = allActive.find(
        (d) =>
          d.name.trim().toLowerCase() === department.trim().toLowerCase() ||
          String(d.id || d._id) === department,
      );
    }
    if (!matchedDepartment) {
      return res.status(422).json({
        error: "Choose a department that exists in organization setup.",
      });
    }
    const resolvedDepartment = matchedDepartment.name;

    const duplicateEmployee = await Employee.exists({
      $or: [{ code }, { email }],
    });
    if (duplicateEmployee || (await User.exists({ email }))) {
      return res.status(409).json({
        error: "That employee code or email is already in use.",
      });
    }

    const temporaryPassword = crypto.randomBytes(12).toString("base64url");
    let employee;
    try {
      employee = await Employee.create({
        code,
        name,
        email,
        companyName: await getSetting("company_name", ""),
        createdBy: req.user.id,
        createdByName: req.user.name,
        department: resolvedDepartment,
        designation,
        joiningDate,
        basicSalary,
        allowances,
        gender: String(req.body.gender || "").trim(),
        phone: String(req.body.phone || "").trim(),
        address: String(req.body.address || "").trim(),
      });
      await User.create({
        name: employee.name,
        email: employee.email,
        passwordHash: await bcrypt.hash(temporaryPassword, 12),
        role: "employee",
        employeeId: employee.id,
        mustChangePassword: true,
      });
    } catch (error) {
      if (employee) await employee.deleteOne();
      if (error.code === 11000) {
        return res.status(409).json({
          error: "That employee code or email is already in use.",
        });
      }
      throw error;
    }

    await writeAudit(
      req.user,
      "create",
      "employee",
      employee.id,
      null,
      employeeJson(employee),
    );
    res
      .status(201)
      .json({ employee: employeeJson(employee), temporaryPassword });
  }),
);

router.put(
  "/employees/:id",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const employee = await Employee.findById(req.params.id);
    if (!employee)
      return res.status(404).json({ error: "Employee not found." });
    const before = employeeJson(employee);
    const editableFields = [
      "name",
      "email",
      "department",
      "designation",
      "joiningDate",
      "exitDate",
      "basicSalary",
      "allowances",
      "gender",
      "phone",
      "address",
      "status",
    ];
    for (const field of editableFields) {
      if (req.body[field] !== undefined) employee[field] = req.body[field];
    }
    if (req.body.email !== undefined) {
      const email = String(req.body.email).trim().toLowerCase();
      if (!emailPattern.test(email))
        return res.status(422).json({ error: "Enter a valid email address." });
      if (
        await User.exists({
          email,
          employeeId: { $ne: employee.id },
        })
      ) {
        return res
          .status(409)
          .json({ error: "An account already uses this email address." });
      }
      employee.email = email;
    }
    if (req.body.joiningDate && !isValidIsoDate(req.body.joiningDate))
      return res
        .status(422)
        .json({ error: "Joining date must use YYYY-MM-DD." });
    if (req.body.exitDate && !isValidIsoDate(req.body.exitDate))
      return res
        .status(422)
        .json({ error: "Last working day must use YYYY-MM-DD." });
    if (employee.exitDate && employee.exitDate < employee.joiningDate) {
      return res
        .status(422)
        .json({ error: "Last working day cannot be before the joining date." });
    }
    if (req.body.department) {
      const depInput = String(req.body.department).trim();
      const departmentPattern = new RegExp(
        `^${depInput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      );
      let matchedDepartment = await Department.findOne({
        name: departmentPattern,
        active: true,
      });
      if (!matchedDepartment) {
        const allActive = await Department.find({ active: true }).lean();
        matchedDepartment = allActive.find(
          (d) =>
            d.name.trim().toLowerCase() === depInput.toLowerCase() ||
            String(d.id || d._id) === depInput,
        );
      }
      if (!matchedDepartment) {
        return res.status(422).json({
          error: "Choose a department that exists in organization setup.",
        });
      }
      employee.department = matchedDepartment.name;
    }
    await employee.save();
    await User.updateOne(
      { employeeId: employee.id },
      { $set: { name: employee.name, email: employee.email } },
    );
    await writeAudit(
      req.user,
      "update",
      "employee",
      employee.id,
      before,
      employeeJson(employee),
    );
    res.json(employeeJson(employee));
  }),
);

router.patch(
  "/employees/me",
  authenticate,
  allowRoles("employee"),
  asyncRoute(async (req, res) => {
    const employee = await Employee.findById(req.user.employeeId);
    if (!employee)
      return res.status(404).json({ error: "Employee profile not found." });
    const before = { phone: employee.phone, address: employee.address };
    if (req.body.phone !== undefined) employee.phone = String(req.body.phone);
    if (req.body.address !== undefined)
      employee.address = String(req.body.address);
    await employee.save();
    await writeAudit(req.user, "update", "employee", employee.id, before, {
      phone: employee.phone,
      address: employee.address,
    });
    res.json({ phone: employee.phone, address: employee.address });
  }),
);

router.post(
  "/employees/import/dry-run",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const parsedRows = parseCsv(req.body.csv);
    if (!parsedRows.length)
      return res
        .status(422)
        .json({ error: "CSV file is empty or has no data rows." });
    const rows = await checkCsvRows(parsedRows);
    res.json({
      totalRows: rows.length,
      validRows: rows.filter(({ errors }) => !errors.length).length,
      rows: rows.map(({ row, errors }) => ({ row, errors })),
    });
  }),
);

router.post(
  "/employees/import",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const rows = await checkCsvRows(parseCsv(req.body.csv));
    const invalid = rows.filter(({ errors }) => errors.length);
    if (invalid.length)
      return res.status(422).json({
        error: "Fix the dry-run errors before importing.",
        rows: invalid.map(({ row, errors }) => ({ row, errors })),
      });

    const companyName = await getSetting("company_name", "");
    const created = [];
    for (const { record } of rows) {
      const temporaryPassword = crypto.randomBytes(12).toString("base64url");
      const employee = await Employee.create({
        code: record.code,
        name: record.name,
        email: record.email,
        companyName,
        createdBy: req.user.id,
        createdByName: req.user.name,
        department: record.department,
        designation: record.designation,
        joiningDate: record.joining_date,
        basicSalary: Number(record.basic_salary),
        allowances: Number(record.allowances || 0),
      });
      try {
        await User.create({
          name: employee.name,
          email: employee.email,
          passwordHash: await bcrypt.hash(temporaryPassword, 12),
          role: "employee",
          employeeId: employee.id,
          mustChangePassword: true,
        });
      } catch (error) {
        await employee.deleteOne();
        throw error;
      }
      created.push({ employee: employeeJson(employee), temporaryPassword });
      await writeAudit(
        req.user,
        "create",
        "employee",
        employee.id,
        null,
        employeeJson(employee),
      );
    }
    res.status(201).json({ created });
  }),
);

router.get(
  "/employees/export.csv",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (_req, res) => {
    const employees = await Employee.find().sort({ name: 1 }).lean();
    const columns = [
      ["code", "code"],
      ["name", "name"],
      ["email", "email"],
      ["department", "department"],
      ["designation", "designation"],
      ["joining_date", "joiningDate"],
      ["basic_salary", "basicSalary"],
      ["allowances", "allowances"],
      ["gender", "gender"],
      ["phone", "phone"],
      ["address", "address"],
      ["status", "status"],
    ];
    const escapeCell = (value) =>
      '"' + String(value ?? "").replace(/"/g, '""') + '"';
    const csv = [
      columns.map(([header]) => header).join(","),
      ...employees.map((employee) =>
        columns.map(([, key]) => escapeCell(employee[key])).join(","),
      ),
    ].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="hcm-employees.csv"',
    );
    res.send(csv);
  }),
);

export default router;
