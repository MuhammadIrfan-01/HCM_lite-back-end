import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDatabase, disconnectDatabase } from "./db.js";
import { errorHandler, notFound } from "./middleware.js";
import authRoutes from "./routes/auth.js";
import organizationRoutes from "./routes/organization.js";
import employeeRoutes from "./routes/employees.js";
import attendanceRoutes from "./routes/attendance.js";
import leaveRoutes from "./routes/leaves.js";
import payrollRoutes from "./routes/payroll.js";
import analyticsRoutes from "./routes/analytics.js";
import communicationRoutes from "./routes/comms.js";
import aiRoutes from "./routes/ai.js";

const app = express();
const port = Number(process.env.PORT || 4001);

app.disable("x-powered-by");
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "HCM Lite API" });
});

app.use("/api", authRoutes);
app.use("/api", organizationRoutes);
app.use("/api", employeeRoutes);
app.use("/api", attendanceRoutes);
app.use("/api", leaveRoutes);
app.use("/api", payrollRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", communicationRoutes);
app.use("/api", aiRoutes);
app.use(notFound);
app.use(errorHandler);

let server;
try {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to a random value of at least 32 characters in back-end/.env.",
    );
  }
  await connectDatabase();
  server = app.listen(port, () =>
    console.log(`HCM Lite API listening on http://localhost:${port}`),
  );
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use by another process. Stop the running process or kill port ${port} and try again.`,
      );
    } else {
      console.error(`Server error: ${error.message}`);
    }
    process.exit(1);
  });
} catch (error) {
  console.error(`Could not start HCM Lite API: ${error.message}`);
  process.exitCode = 1;
}

async function shutDown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
  process.exit(0);
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
