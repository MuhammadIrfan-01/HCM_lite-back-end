import { AsyncLocalStorage } from "node:async_hooks";
import { MongoClient } from "mongodb";

let client;
const transactions = new AsyncLocalStorage();
let database;

export async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI must be set in back-end/.env.");
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  database = client.db(process.env.MONGODB_DATABASE || undefined);
  await database.command({ ping: 1 });
  for (const [collection, indexes] of Object.entries({
    companies: [[{ normalizedName: 1 }, { unique: true }]],
    users: [[{ companyId: 1, email: 1 }, { unique: true }]],
    employees: [
      [{ companyId: 1, code: 1 }, { unique: true }],
      [{ companyId: 1, email: 1 }, { unique: true }],
    ],
    settings: [[{ companyId: 1, key: 1 }, { unique: true }]],
    departments: [[{ companyId: 1, name: 1 }, { unique: true }]],
    leaveTypes: [[{ companyId: 1, name: 1 }, { unique: true }]],
    holidays: [[{ companyId: 1, date: 1 }, { unique: true }]],
    attendance: [[{ companyId: 1, employeeId: 1, date: 1 }, { unique: true }]],
    payrollRuns: [[{ companyId: 1, month: 1 }, { unique: true }]],
    payslips: [[{ companyId: 1, runId: 1, employeeId: 1 }, { unique: true }]],
  })) {
    for (const [keys, options] of indexes) await database.collection(collection).createIndex(keys, options);
  }
  console.log(`Connected to MongoDB database: ${database.databaseName}`);
}

export function getCollection(name) {
  if (!database) throw new Error("MongoDB is not connected.");
  return database.collection(name);
}

export async function closeDatabase() {
  if (client) await client.close();
  database = undefined;
}

export async function withTransaction(callback) {
  if (!client) throw new Error("MongoDB is not connected.");
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await transactions.run(session, callback);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export function currentSession() {
  return transactions.getStore();
}

export function serializable(value) {
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === "ObjectId" || typeof value?.toHexString === "function") return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function" || key === "__v" || key === "id") continue;
    if (key.endsWith("Id") && child && typeof child === "object") {
      const raw = child._id ?? child.id ?? child;
      result[key] = (raw?._bsontype === "ObjectId" || typeof raw?.toHexString === "function") ? raw.toString() : String(raw);
      continue;
    }
    result[key] = serializable(child);
  }
  return result;
}
