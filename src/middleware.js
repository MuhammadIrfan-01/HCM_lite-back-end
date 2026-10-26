import "dotenv/config";
import crypto from "node:crypto";
import { User } from "./models.js";
import { runWithTenant } from "./tenant-context.js";

const JWT_SECRET = process.env.JWT_SECRET;

function createToken(payload) {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      sub: payload.id,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function readToken(token) {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) throw new Error("Invalid token");

  const signingInput = `${header}.${body}`;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(signingInput)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp < Date.now() / 1000) throw new Error("Token expired");
  return payload;
}

export function issueToken(user) {
  return createToken({ id: user.id || user._id });
}

export async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in to continue." });

  let claims;
  try {
    claims = readToken(token);
  } catch {
    return res
      .status(401)
      .json({ error: "Your session expired. Please sign in again." });
  }

  let user;
  try {
    user = await User.findOne({ _id: claims.sub, active: true }).lean();
  } catch (error) {
    return next(error);
  }
  if (!user)
    return res
      .status(401)
      .json({ error: "Your account is inactive or no longer exists." });

  req.user = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId?.toString() || null,
    mustChangePassword: user.mustChangePassword,
    companyId: user.companyId?.toString() || null,
  };
  const canChangePassword =
    req.path.endsWith("/auth/change-password") || req.path.endsWith("/auth/me");
  if (user.mustChangePassword && !canChangePassword) {
    return res.status(403).json({
      error: "Change your temporary password before using HCM Lite.",
    });
  }
  if (!user.companyId) {
    return res
      .status(403)
      .json({ error: "This account is not assigned to a company workspace." });
  }
  return runWithTenant(user.companyId, () => next());
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: "You do not have permission to do that." });
    }
    return next();
  };
}

export function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

export function notFound(_req, res) {
  res.status(404).json({ error: "The requested resource was not found." });
}

export function errorHandler(error, req, res, _next) {
  console.error(`[API ${req.method} ${req.originalUrl}]`, error);
  if (res.headersSent) return;
  if (error?.code === 11000) {
    return res
      .status(409)
      .json({ error: "A record with this value already exists." });
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(422).json({ error: error.message });
  }
  if (
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return res.status(error.status).json({ error: error.message });
  }
  return res
    .status(500)
    .json({ error: "Something went wrong. Please try again." });
}
