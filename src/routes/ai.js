import { Router } from "express";
import { Employee, LeaveType, AiLog, Holiday, Department } from "../models.js";
import { asyncRoute, authenticate } from "../middleware.js";
import { isValidIsoDate, localDateString } from "../services.js";
import { buildAnalytics } from "./analytics.js";
import { getLeaveBalances } from "./leaves.js";

const router = Router();
const requestTimes = new Map();
const policyText = `HCM Lite company policy rules:
- Office start defaults to 09:00 with a 15 minute grace period. Late status applies after the configured grace period.
- Half day applies when worked time is under 5 hours by default.
- The default weekend is Saturday and Sunday. Holidays are configured in the application.
- Default yearly leave quotas are annual 14 working days, sick 8, casual 10, and unpaid unlimited.
- Leave counts working days only, excluding configured weekends and public holidays. Overlapping or over-balance requests are rejected.
- Payroll gross is basic salary times 1.5 (basic plus 40 percent house rent and 10 percent medical); deductions include absent days, unpaid leave, half days at half the daily rate, and illustrative tax.
- Only Admin can finalize payroll. Finalized payroll is locked.
- The database is the source of truth. If a fact is not in these rules or returned by a permitted tool, say you do not know.
- Never disclose another employee's salary or private data to an Employee. Never create or change records from chat.`;

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_headcount",
      description: "Get active employee headcount, optionally by department.",
      parameters: {
        type: "object",
        properties: { department: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_attendance_summary",
      description:
        "Get attendance totals and attendance rate for a date range.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          department: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_late_comers",
      description:
        "Get employees ordered by number of late attendance records for a date range.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          department: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_leave_summary",
      description:
        "Summarize approved leave working days by type and department for a date range.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          department: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_leave_balance",
      description: "Get the current employee leave balance.",
      parameters: { type: "object", properties: { year: { type: "integer" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payroll_summary",
      description:
        "Get finalized payroll gross and net totals by month. HR and Admin only.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string" },
          department: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_employees",
      description:
        "Find employees by name, code, or department and return only permitted profile information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          department: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
];

function checkRateLimit(userId) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const recent = (requestTimes.get(userId) || []).filter(
    (timestamp) => timestamp > hourAgo,
  );
  if (recent.length >= 20) return false;
  recent.push(now);
  requestTimes.set(userId, recent);
  return true;
}

function defaultsForRange(args = {}) {
  const today = localDateString();
  return { from: args.from || `${today.slice(0, 7)}-01`, to: args.to || today };
}

function assertManagerAccess(user) {
  if (!["admin", "hr"].includes(user.role))
    throw new Error(
      "You do not have permission to view company-wide information.",
    );
}

async function callTool(name, args, user) {
  const { from, to } = defaultsForRange(args);
  const departmentFilter = args.department
    ? { department: args.department }
    : {};

  if (name === "get_headcount") {
    assertManagerAccess(user);
    const analytics = await buildAnalytics({
      role: user.role,
      employeeId: user.employeeId,
      from,
      to,
      department: args.department,
    });
    return {
      headcount: analytics.headcount,
      department: args.department || "all",
    };
  }

  if (name === "get_attendance_summary") {
    assertManagerAccess(user);
    const analytics = await buildAnalytics({
      role: user.role,
      employeeId: user.employeeId,
      from,
      to,
      department: args.department,
    });
    return { from, to, ...analytics.attendance };
  }

  if (name === "get_late_comers") {
    assertManagerAccess(user);
    const analytics = await buildAnalytics({
      role: user.role,
      employeeId: user.employeeId,
      from,
      to,
      department: args.department,
    });
    return analytics.topLateComers;
  }

  if (name === "get_leave_summary") {
    assertManagerAccess(user);
    const analytics = await buildAnalytics({
      role: user.role,
      employeeId: user.employeeId,
      from,
      to,
      department: args.department,
    });
    return {
      from,
      to,
      approvedWorkingDaysByType: analytics.leaveUtilization,
      approvedWorkingDaysByDepartment: analytics.leaveByDepartment,
    };
  }

  if (name === "get_my_leave_balance") {
    if (user.role !== "employee")
      throw new Error("This tool is for employee self-service.");
    const year = Number(args.year) || Number(localDateString().slice(0, 4));
    return { year, balances: await getLeaveBalances(user.employeeId, year) };
  }

  if (name === "get_payroll_summary") {
    assertManagerAccess(user);
    const month = args.month || localDateString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new Error("Use a valid month in YYYY-MM format.");
    const [year, monthNumber] = month.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(year, monthNumber, 0))
      .toISOString()
      .slice(0, 10);
    const analytics = await buildAnalytics({
      role: user.role,
      employeeId: user.employeeId,
      from: `${month}-01`,
      to: monthEnd,
      department: args.department,
    });
    return {
      month,
      gross: analytics.payroll.gross,
      net: analytics.payroll.net,
    };
  }

  if (name === "search_employees") {
    const query = String(args.query || "").trim();
    if (!query) return [];
    if (user.role === "employee") {
      const own = await Employee.findById(user.employeeId).lean();
      return own &&
        `${own.name} ${own.code}`.toLowerCase().includes(query.toLowerCase())
        ? [
            {
              name: own.name,
              code: own.code,
              department: own.department,
              designation: own.designation,
            },
          ]
        : [];
    }
    const pattern = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const filter = {
      ...departmentFilter,
      $or: [
        { name: pattern },
        { code: pattern },
        { email: pattern },
        { department: pattern },
      ],
    };
    const people = await Employee.find(filter)
      .select("name code department designation status")
      .limit(10)
      .lean();
    return people;
  }
  throw new Error(`Unknown AI tool: ${name}`);
}

async function generateDirectAnswer(question, user) {
  const q = String(question || "").toLowerCase();
  const sections = [];

  // 1. Headcount & active employees
  const asksHeadcount =
    q.includes("headcount") ||
    q.includes("total employee") ||
    q.includes("kitne employee") ||
    q.includes("kitne log") ||
    q.includes("active people") ||
    q.includes("team size") ||
    (q.includes("how many") && (q.includes("employee") || q.includes("people") || q.includes("member")));

  if (asksHeadcount) {
    if (["admin", "hr"].includes(user.role)) {
      try {
        const total = await Employee.countDocuments({ status: { $ne: "inactive" } });
        const depts = await Department.find({ active: { $ne: false } }).lean();
        const deptCounts = await Promise.all(
          depts.map(async (d) => {
            const count = await Employee.countDocuments({ department: d.name, status: { $ne: "inactive" } });
            return `• **${d.name}**: ${count} team member${count === 1 ? "" : "s"}`;
          }),
        );
        const deptText = deptCounts.length ? deptCounts.join("\n") : "• No active departments configured yet.";
        sections.push(`### 👥 Company Headcount\n\n**Total active employees:** ${total}\n\n**Department breakdown:**\n${deptText}`);
      } catch (e) {
        console.error("Direct headcount error:", e.message);
        sections.push("### 👥 Company Headcount\n\nUnable to retrieve active employee count at this moment.");
      }
    } else {
      sections.push("🔒 *Company-wide headcount statistics are restricted to HR and Administrator accounts.*");
    }
  }

  // 2. Attendance summary & rate
  const asksAttendance =
    q.includes("attendance") ||
    q.includes("late") ||
    q.includes("present") ||
    q.includes("absent") ||
    q.includes("hazri") ||
    q.includes("half day");

  if (asksAttendance) {
    if (["admin", "hr"].includes(user.role)) {
      try {
        const today = localDateString();
        const from = `${today.slice(0, 7)}-01`;
        const analytics = await buildAnalytics({
          role: user.role,
          employeeId: user.employeeId,
          from,
          to: today,
        });
        const att = analytics.attendance || {};
        sections.push(
          `### 📊 Attendance Summary (${from} to ${today})\n\n` +
          `• **Attendance Rate**: **${att.rate || 0}%**\n` +
          `• **Present Days**: ${att.present || 0}\n` +
          `• **Late Days**: ${att.late || 0}\n` +
          `• **Half Days**: ${att.halfDay || 0}\n` +
          `• **Absent Days**: ${att.absent || 0}\n` +
          `• **Approved Leave Days**: ${att.onLeave || 0}`
        );

        if (q.includes("late") || q.includes("who is late") || q.includes("late comer")) {
          const topLate = analytics.topLateComers || [];
          if (topLate.length) {
            const lines = topLate.slice(0, 5).map((l, i) => `${i + 1}. **${l.name}** (${l.department}) — ${l.count} late arrival${l.count === 1 ? "" : "s"}`);
            sections.push(`### ⏰ Top Late Comers\n\n${lines.join("\n")}`);
          }
        }
      } catch (e) {
        console.error("Direct attendance error:", e.message);
        sections.push("### 📊 Attendance Summary\n\nAttendance metrics are temporarily unavailable. Please verify your date range in the Attendance panel.");
      }
    } else {
      try {
        const today = localDateString();
        const from = `${today.slice(0, 7)}-01`;
        const myAttendance = await Attendance.find({
          employeeId: user.employeeId,
          date: { $gte: from, $lte: today },
        }).lean();
        const present = myAttendance.filter(r => r.status === "present").length;
        const late = myAttendance.filter(r => r.status === "late").length;
        const halfDay = myAttendance.filter(r => r.status === "half_day").length;
        sections.push(
          `### 📅 Your Attendance This Month (${from} to ${today})\n\n` +
          `• **Total Recorded Days**: ${myAttendance.length}\n` +
          `• **On Time**: ${present}\n` +
          `• **Late Arrivals**: ${late}\n` +
          `• **Half Days**: ${halfDay}`
        );
      } catch (e) {
        sections.push("You can view your detailed daily check-in logs under the **My attendance** tab.");
      }
    }
  }

  // 3. Leave balance & requests
  const asksLeave =
    (q.includes("leave") && (q.includes("balance") || q.includes("remaining") || q.includes("kitni") || q.includes("available") || q.includes("quota") || q.includes("utilization"))) ||
    q.includes("chhutti") ||
    q.includes("chutti");

  if (asksLeave) {
    if (user.role === "employee" && user.employeeId) {
      try {
        const year = Number(localDateString().slice(0, 4));
        const balances = await getLeaveBalances(user.employeeId, year);
        const lines = balances.map(
          (b) => `• **${b.type.toUpperCase()}**: ${b.remaining === null ? "Unlimited" : `${b.remaining} days remaining`} (Used: ${b.used} of ${b.quota || "unlimited"})`,
        );
        sections.push(`### 🌴 Your Leave Balance (${year})\n\n${lines.join("\n")}`);
      } catch (e) {
        console.error("Direct leave balance error:", e.message);
      }
    } else if (["admin", "hr"].includes(user.role)) {
      try {
        const today = localDateString();
        const analytics = await buildAnalytics({
          role: user.role,
          employeeId: user.employeeId,
          from: `${today.slice(0, 7)}-01`,
          to: today,
        });
        const types = Object.entries(analytics.leaveUtilization || {}).map(
          ([type, days]) => `• **${type.toUpperCase()}**: ${days} days approved this month`,
        );
        sections.push(`### 🌴 Leave Utilization (This Month)\n\n${types.length ? types.join("\n") : "No approved leaves recorded this month."}`);
      } catch (e) {
        console.error("Direct leave summary error:", e.message);
      }
    }
  }

  // 4. Upcoming Holidays
  const asksHolidays = q.includes("holiday") || q.includes("off day") || q.includes("public holiday") || q.includes("gazetted");
  if (asksHolidays) {
    try {
      const today = localDateString();
      const holidays = await Holiday.find({ date: { $gte: today } }).sort({ date: 1 }).limit(6).lean();
      if (holidays.length) {
        const list = holidays.map((h) => `• **${h.name}**: ${h.date}`);
        sections.push(`### 🏖️ Upcoming Public Holidays\n\n${list.join("\n")}`);
      } else {
        sections.push("### 🏖️ Upcoming Public Holidays\n\nThere are no upcoming holidays registered in your calendar.");
      }
    } catch (e) {
      console.error("Direct holidays error:", e.message);
    }
  }

  // 5. Office timing / grace period / workplace policy
  const asksPolicy =
    q.includes("timing") ||
    q.includes("policy") ||
    q.includes("grace") ||
    q.includes("office hours") ||
    q.includes("weekend") ||
    q.includes("work hours") ||
    q.includes("half-day rule") ||
    q.includes("rule");

  if (asksPolicy) {
    sections.push(`### 📋 Workplace Policies & Timings\n\n${policyText}`);
  }

  // 6. Payroll
  const asksPayroll = q.includes("payroll") || q.includes("salary") || q.includes("tankhwah") || q.includes("payslip");
  if (asksPayroll) {
    if (user.role === "employee") {
      sections.push("### 💵 Payslips & Salary\n\nYou can inspect and download all your finalized monthly payslips under the **Payslips** menu.");
    } else {
      try {
        const today = localDateString();
        const month = today.slice(0, 7);
        const [year, monthNumber] = month.split("-").map(Number);
        const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
        const analytics = await buildAnalytics({
          role: user.role,
          employeeId: user.employeeId,
          from: `${month}-01`,
          to: monthEnd,
        });
        const gross = Number((analytics.payroll?.gross || 0).toFixed(2));
        const net = Number((analytics.payroll?.net || 0).toFixed(2));
        sections.push(`### 💵 Payroll Overview (${month})\n\n• **Finalized Gross**: PKR ${gross.toLocaleString()}\n• **Finalized Net**: PKR ${net.toLocaleString()}`);
      } catch (e) {
        sections.push("### 💵 Payroll Overview\n\nPayroll details can be viewed and managed from the **Payroll** panel.");
      }
    }
  }

  if (sections.length > 0) {
    return sections.join("\n\n---\n\n");
  }

  return (
    "I am your **HCM Operations Assistant**. Here are some things you can ask me:\n\n" +
    "• *\"What is our overall headcount and attendance rate?\"*\n" +
    "• *\"Who are the top late comers this month?\"*\n" +
    "• *\"What are our upcoming public holidays?\"*\n" +
    "• *\"What are the company office hours and grace period?\"*\n" +
    (user.role === "employee" ? "• *\"What is my remaining leave balance?\"*\n" : "• *\"Show me company leave utilization this month.\"*\n")
  );
}

async function callModel(messages, tools, responseFormat) {
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  const baseUrl = (
    process.env.AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai"
  ).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gemini-3.5-flash-lite",
      messages,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`AI provider returned ${response.status}:`, errorText.slice(0, 150));
    throw new Error(`AI provider returned ${response.status}: ${errorText}`);
  }
  return response.json();
}

async function askWithTools(question, user) {
  const scope =
    user.role === "employee"
      ? "You have employee self-service scope. Do not disclose other people records or any salary."
      : `${user.role.toUpperCase()} scope applies. Use tools only for company data questions.`;
  const messages = [
    {
      role: "system",
      content: `${policyText}\n\n${scope}\nAnswer in plain language with clear bullet points where helpful. Understand English and Roman Urdu. Do not invent figures or make changes.`,
    },
    { role: "user", content: question },
  ];
  const usedTools = [];

  for (let round = 0; round < 4; round += 1) {
    let completion;
    try {
      completion = await callModel(messages, toolDefinitions);
    } catch (modelErr) {
      console.warn("Falling back to direct answer due to model error:", modelErr.message);
      return {
        answer: await generateDirectAnswer(question, user),
        tools: usedTools,
        outcome: "fallback",
      };
    }

    if (!completion) {
      return {
        answer: await generateDirectAnswer(question, user),
        tools: usedTools,
        outcome: "fallback",
      };
    }

    const message = completion.choices?.[0]?.message;
    if (!message) {
      return {
        answer: await generateDirectAnswer(question, user),
        tools: usedTools,
        outcome: "fallback",
      };
    }

    messages.push(message);
    if (!message.tool_calls?.length) {
      return {
        answer:
          message.content ||
          (await generateDirectAnswer(question, user)),
        tools: usedTools,
        outcome: "success",
      };
    }

    for (const toolCall of message.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || "{}");
      try {
        const result = await callTool(name, args, user);
        usedTools.push(name);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      } catch (error) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: error.message }),
        });
      }
    }
  }

  return {
    answer: await generateDirectAnswer(question, user),
    tools: usedTools,
    outcome: "fallback",
  };
}

function extractJson(content) {
  const cleaned = String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

router.post(
  "/ai/chat",
  authenticate,
  asyncRoute(async (req, res) => {
    const question = String(req.body.message || "").trim();
    if (!question)
      return res.status(422).json({ error: "Write a question first." });
    if (!checkRateLimit(req.user.id))
      return res.status(429).json({
        error: "You have reached the limit of 20 AI requests per hour.",
      });
    const started = Date.now();
    let result = null;
    try {
      result = await askWithTools(question, req.user);
    } catch (error) {
      console.warn("AI askWithTools error:", error?.message || error);
    }

    if (!result || !result.answer) {
      try {
        const direct = await generateDirectAnswer(question, req.user);
        result = { answer: direct, tools: [], outcome: "direct" };
      } catch (directErr) {
        console.error("AI generateDirectAnswer error:", directErr?.message || directErr);
        result = {
          answer: "I am your HCM operations assistant. You can ask me about company policies, office hours, upcoming holidays, attendance summaries, headcount, or your personal leave balance.",
          tools: [],
          outcome: "fallback",
        };
      }
    }

    try {
      await AiLog.create({
        userId: req.user.id,
        role: req.user.role,
        question,
        answer: result.answer,
        tools: result.tools || [],
        durationMs: Date.now() - started,
        outcome: result.outcome || "success",
      });
    } catch (logErr) {
      console.warn("AiLog save skipped:", logErr?.message || logErr);
    }

    res.json({ answer: result.answer, label: "AI-generated" });
  }),
);

router.post(
  "/ai/dashboard-summary",
  authenticate,
  asyncRoute(async (req, res) => {
    if (!["admin", "hr"].includes(req.user.role))
      return res
        .status(403)
        .json({ error: "Dashboard summaries are available to Admin and HR." });
    if (!checkRateLimit(req.user.id))
      return res.status(429).json({
        error: "You have reached the limit of 20 AI requests per hour.",
      });
    const today = localDateString();
    const from = String(req.body.from || `${today.slice(0, 7)}-01`);
    const to = String(req.body.to || today);
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to || to > today)
      return res
        .status(422)
        .json({ error: "Choose a valid dashboard date range." });
    const kpis = await buildAnalytics({
      role: req.user.role,
      employeeId: req.user.employeeId,
      from,
      to,
      department: req.body.department,
    });
    const started = Date.now();
    let bullets = [
      "AI is not configured. Add AI_API_KEY to generate insights from these dashboard figures.",
    ];
    let outcome = "fallback";
    try {
      const completion = await callModel([
        {
          role: "system",
          content:
            "Write 3 to 5 concise dashboard insight bullets. Use only the supplied KPI JSON. Do not infer causes or create missing numbers.",
        },
        { role: "user", content: JSON.stringify(kpis) },
      ]);
      if (completion?.choices?.[0]?.message?.content) {
        bullets = completion.choices[0].message.content
          .split("\n")
          .map((line) => line.replace(/^[-*•\s]+/, "").trim())
          .filter(Boolean)
          .slice(0, 5);
        outcome = "success";
      }
    } catch {
      bullets = [
        "The AI summary is temporarily unavailable. Your dashboard data is still up to date.",
      ];
      outcome = "error";
    }
    await AiLog.create({
      userId: req.user.id,
      role: req.user.role,
      question: `Dashboard summary: ${from} to ${to}`,
      answer: bullets.join("\n"),
      durationMs: Date.now() - started,
      outcome,
    });
    res.json({ bullets, label: "AI-generated" });
  }),
);

router.post(
  "/ai/smart-leave",
  authenticate,
  asyncRoute(async (req, res) => {
    if (req.user.role !== "employee")
      return res
        .status(403)
        .json({ error: "Smart leave is available to employees." });
    const sentence = String(req.body.message || "").trim();
    if (!sentence)
      return res.status(422).json({ error: "Describe the leave you need." });
    if (!checkRateLimit(req.user.id))
      return res.status(429).json({
        error: "You have reached the limit of 20 AI requests per hour.",
      });
    const types = (
      await LeaveType.find({ active: true }).select("name").lean()
    ).map(({ name }) => name);
    const started = Date.now();
    let parsed = null;
    let outcome = "fallback";

    if (process.env.AI_API_KEY) {
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        try {
          const completion = await callModel(
            [
              {
                role: "system",
                content: `Extract a leave request as JSON with keys type, startDate, endDate, reason. Dates must be ISO YYYY-MM-DD and interpreted relative to today ${localDateString()} in ${process.env.APP_TIME_ZONE || "Asia/Karachi"}. Valid types: ${types.join(", ")}. If uncertain, use the closest valid type and keep the reason concise. Return only JSON.`,
              },
              { role: "user", content: sentence },
            ],
            null,
            { type: "json_object" },
          );
          const candidate = extractJson(
            completion?.choices?.[0]?.message?.content,
          );
          if (
            types.includes(candidate.type) &&
            isValidIsoDate(candidate.startDate) &&
            isValidIsoDate(candidate.endDate) &&
            candidate.endDate >= candidate.startDate
          )
            parsed = candidate;
        } catch {
          // Invalid model output gets one retry, then the regular form is offered.
        }
      }
      if (parsed) outcome = "success";
    }

    const answer = parsed
      ? { prefilled: true, leave: parsed }
      : {
          prefilled: false,
          message:
            "I could not reliably read those dates. Please fill in the regular leave form.",
        };
    await AiLog.create({
      userId: req.user.id,
      role: req.user.role,
      question: sentence,
      answer: JSON.stringify(answer),
      durationMs: Date.now() - started,
      outcome,
    });
    res.json(answer);
  }),
);

export default router;
