import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { currentSession, getCollection, serializable } from "./storage.js";
import { currentTenantId } from "./tenant-context.js";

const collectionNames = { Company: "companies", User: "users", Employee: "employees", Setting: "settings", Department: "departments", LeaveType: "leaveTypes", Holiday: "holidays", PayrollRun: "payrollRuns", Payslip: "payslips" };
const names = ["Company", "User", "Employee", "Setting", "Department", "Designation", "LeaveType", "Holiday", "Attendance", "AttendanceCorrection", "LeaveRequest", "PayrollRun", "Payslip", "Announcement", "Notification", "AuditLog", "AiLog"];
const defaults = {
  User: (d) => Object.assign(d, { active: d.active ?? true, mustChangePassword: d.mustChangePassword ?? false, employeeId: d.employeeId ?? null }),
  Company: (d) => Object.assign(d, { ...d, active: d.active ?? true }),
  Employee: (d) => Object.assign(d, { allowances: 0, exitDate: "", gender: "", phone: "", address: "", status: "active", ...d }),
  Attendance: (d) => Object.assign(d, { checkOut: null, status: "present", source: "web", correction: { status: "none" }, photo: d.photo ?? null, ...d }),
  AttendanceCorrection: (d) => Object.assign(d, { status: "pending", ...d }),
  LeaveRequest: (d) => Object.assign(d, { status: "pending", comment: "", ...d }),
  LeaveType: (d) => Object.assign(d, { active: d.active ?? true, paid: d.paid ?? true, quota: d.quota ?? 0, ...d }),
  Holiday: (d) => Object.assign(d, { active: d.active ?? true, ...d }),
  Department: (d) => Object.assign(d, { active: d.active ?? true, ...d }),
  Designation: (d) => Object.assign(d, { active: d.active ?? true, ...d }),
  PayrollRun: (d) => Object.assign(d, { status: "draft", totalGross: 0, totalNet: 0, ...d }),
  Notification: (d) => Object.assign(d, { readAt: null, ...d }),
};

function clone(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof ObjectId || v?._bsontype === "ObjectId" || typeof v?.toHexString === "function") {
    return v.toString();
  }
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof RegExp) return new RegExp(v.source, v.flags);
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v === "object") {
    const out = {};
    for (const [k, child] of Object.entries(v)) {
      out[k] = clone(child);
    }
    return out;
  }
  return v;
}

const companyScoped = new Set(names.filter((n) => n !== "Company"));

function isBsonId(v) {
  return v instanceof ObjectId || v?._bsontype === "ObjectId" || typeof v?.toHexString === "function";
}

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof RegExp) &&
    !isBsonId(v) &&
    !Buffer.isBuffer(v)
  );
}

function normalizeQueryFilter(filter) {
  if (!filter || !isPlainObject(filter)) {
    if (Array.isArray(filter)) return filter.map(normalizeQueryFilter);
    return filter;
  }
  const result = {};
  for (const [key, value] of Object.entries(filter)) {
    if ((key === "_id" || key.endsWith("Id")) && typeof value === "string" && ObjectId.isValid(value) && String(new ObjectId(value)) === value) {
      result[key] = { $in: [value, new ObjectId(value)] };
    } else if (isPlainObject(value) || Array.isArray(value)) {
      result[key] = normalizeQueryFilter(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function scoped(name, filter = {}) {
  const companyId = currentTenantId();
  const normalized = normalizeQueryFilter(filter);
  if (!companyScoped.has(name) || !companyId) return normalized;
  if (normalized.companyId !== undefined && String(normalized.companyId) === String(companyId)) return normalized;
  return { $and: [normalized, { companyId }] };
}

function normalizeDocument(value) {
  if (Array.isArray(value)) return value.map(normalizeDocument);
  if (!value || typeof value !== "object" || value instanceof RegExp || value instanceof Date) return value;
  if (value instanceof ObjectId || value?._bsontype === "ObjectId" || typeof value?.toHexString === "function") {
    return value.toString();
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = normalizeDocument(child);
  if (out._id !== undefined) out.id = String(out._id);
  return out;
}

function attach(model, value) {
  if (!value) return null;
  const doc = normalizeDocument(clone(value));
  Object.defineProperty(doc, "save", { enumerable: false, value: async function () {
    this.updatedAt = new Date().toISOString();
    const values = serializable(this);
    delete values._id;
    delete values.id;
    const rawId = this._id || this.id;
    const filter = ObjectId.isValid(rawId) && String(new ObjectId(rawId)) === String(rawId)
      ? { _id: { $in: [String(rawId), new ObjectId(rawId)] } }
      : { _id: String(rawId) };
    await model.collection.updateOne(scoped(model.modelName, filter), { $set: values }, { session: currentSession() });
    return this;
  }});
  Object.defineProperty(doc, "deleteOne", { enumerable: false, value: async function () {
    const rawId = this._id || this.id;
    const filter = ObjectId.isValid(rawId) && String(new ObjectId(rawId)) === String(rawId)
      ? { _id: { $in: [String(rawId), new ObjectId(rawId)] } }
      : { _id: String(rawId) };
    return model.collection.deleteOne(scoped(model.modelName, filter), { session: currentSession() });
  }});
  Object.defineProperty(doc, "toJSON", { enumerable: false, value: function () { const out = normalizeDocument(serializable(this)); delete out._id; return out; }});
  return doc;
}
function applyUpdate(document, update, inserting = false) {
  const next = clone(document);
  const set = update?.$set || (Object.keys(update || {}).some((k) => k.startsWith("$")) ? {} : update || {});
  for (const [key, value] of Object.entries(set)) {
    if (key.includes(".")) { const parts = key.split("."); let ref = next; for (const p of parts.slice(0, -1)) ref = ref[p] ||= {}; ref[parts.at(-1)] = clone(value); }
    else next[key] = clone(value);
  }
  if (inserting) Object.assign(next, clone(update?.$setOnInsert || {}));
  for (const key of Object.keys(update?.$unset || {})) delete next[key];
  for (const [key, amount] of Object.entries(update?.$inc || {})) next[key] = Number(next[key] || 0) + Number(amount);
  next.updatedAt = new Date().toISOString();
  return next;
}

class Query {
  constructor(model, filter, mode) { this.model = model; this.filter = filter; this.mode = mode; this.options = {}; this.selection = ""; this.sorting = null; this.max = null; this.offset = 0; this.populations = []; }
  lean() { this.options.lean = true; return this; }
  select(value) { this.selection = value; return this; }
  sort(value) { this.sorting = value; return this; }
  limit(value) { this.max = Number(value); return this; }
  skip(value) { this.offset = Number(value); return this; }
  populate(pathOrOptions, selection) { this.populations.push(typeof pathOrOptions === "string" ? { path: pathOrOptions, select: selection } : pathOrOptions); return this; }
  session(session) { this.sessionValue = session; return this; }
  countDocuments() { this.mode = "count"; return this; }
  async exec() {
    const collection = this.model.collection;
    const filter = scoped(this.model.modelName, this.filter);
    const session = this.sessionValue || currentSession();
    const sessionOpt = session ? { session } : {};
    if (this.mode === "count") return collection.countDocuments(filter, sessionOpt);
    if (this.mode === "exists") { const found = await collection.findOne(filter, { projection: { _id: 1 }, ...sessionOpt }); return found ? { _id: found._id } : null; }
    let cursor = collection.find(filter, sessionOpt);
    if (this.sorting) cursor = cursor.sort(this.sorting);
    if (this.offset) cursor = cursor.skip(this.offset);
    if (this.max != null) cursor = cursor.limit(this.max);
    let records = await cursor.toArray();
    if (this.mode === "one") records = records.slice(0, 1);
    const output = [];
    for (let record of records) {
      record = clone(record);
      if (this.selection) {
        const fields = this.selection.split(/\s+/).filter(Boolean);
        const included = fields.filter((f) => !f.startsWith("-"));
        if (included.length) { const projected = { _id: record._id }; for (const f of included) if (f !== "_id" && record[f] !== undefined) projected[f] = record[f]; record = projected; }
        for (const f of fields.filter((x) => x.startsWith("-"))) delete record[f.slice(1)];
      }
      for (const pop of this.populations) {
        const refModel = pop.path === "employeeId" ? models.Employee : pop.path === "runId" ? models.PayrollRun : null;
        if (refModel && record[pop.path] != null && typeof record[pop.path] !== "object") record[pop.path] = await refModel.findById(record[pop.path]).select(pop.select || "").lean();
      }
      output.push(this.options.lean ? normalizeDocument(record) : attach(this.model, record));
    }
    return this.mode === "one" ? output[0] || null : output;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
}

const models = {};
function createModel(modelName) {
  const collectionName = collectionNames[modelName] || modelName[0].toLowerCase() + modelName.slice(1);
  const model = { modelName,
    get collection() { return getCollection(collectionName); },
    find: (filter = {}) => new Query(model, filter, "many"),
    findOne: (filter = {}) => new Query(model, filter, "one"),
    findById: (id) => new Query(model, { _id: String(id) }, "one"),
    exists: (filter = {}) => new Query(model, filter, "exists"),
    countDocuments: (filter = {}) => new Query(model, filter, "count"),
    async create(input) {
      const now = new Date().toISOString();
      let doc = { _id: String(input._id || crypto.randomUUID()), createdAt: input.createdAt || now, updatedAt: now, ...clone(input) };
      if (modelName !== "Company") doc.companyId ??= currentTenantId();
      if (defaults[modelName]) doc = defaults[modelName](doc);
      const s = currentSession();
      const sOpt = s ? { session: s } : {};
      await model.collection.insertOne(serializable(doc), sOpt);
      return attach(model, doc);
    },
    async insertMany(inputs) { const out = []; for (const input of inputs) out.push(await model.create(input)); return out; },
    async bulkWrite(operations = []) { const s = currentSession(); const ops = operations.map((o) => ({ updateOne: { ...o.updateOne, filter: scoped(modelName, o.updateOne.filter), upsert: o.updateOne.upsert } })); return model.collection.bulkWrite(ops, s ? { session: s } : {}); },
    async updateOne(filter, update, options = {}) { const s = currentSession(); return model.collection.updateOne(scoped(modelName, filter), update, { ...options, ...(s ? { session: s } : {}) }); },
    async updateMany(filter, update) { const s = currentSession(); return model.collection.updateMany(scoped(modelName, filter), update, s ? { session: s } : {}); },
    async findOneAndUpdate(filter, update, options = {}) {
      if (options.upsert) {
        update = update || {};
        const setKeys = new Set(Object.keys(update.$set || {}));
        const modelDefaults = defaults[modelName] ? defaults[modelName]({}) : {};
        const setOnInsert = {
          _id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ...(modelName !== "Company" && currentTenantId() ? { companyId: currentTenantId() } : {}),
        };
        for (const [k, v] of Object.entries(modelDefaults)) {
          if (!setKeys.has(k)) setOnInsert[k] = v;
        }
        if (update.$setOnInsert) {
          for (const [k, v] of Object.entries(update.$setOnInsert)) {
            if (!setKeys.has(k)) setOnInsert[k] = v;
          }
        }
        update.$setOnInsert = setOnInsert;
      }
      const opts = { returnDocument: options.new === false ? "before" : "after", upsert: Boolean(options.upsert), includeResultMetadata: false, session: currentSession() };
      const result = await model.collection.findOneAndUpdate(scoped(modelName, filter), update, opts);
      if (result || !options.upsert) return attach(model, result);
      return attach(model, await model.collection.findOne(scoped(modelName, filter), { session: currentSession() }));
    },
    async deleteOne(filter = {}) { return model.collection.deleteOne(scoped(modelName, filter), { session: currentSession() }); },
    async deleteMany(filter = {}) { return model.collection.deleteMany(scoped(modelName, filter), { session: currentSession() }); },
  };
  return model;
}
for (const name of names) models[name] = createModel(name);
export const { Company, User, Employee, Setting, Department, Designation, LeaveType, Holiday, Attendance, AttendanceCorrection, LeaveRequest, PayrollRun, Payslip, Announcement, Notification, AuditLog, AiLog } = models;
