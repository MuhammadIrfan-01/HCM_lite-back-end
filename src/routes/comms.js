import { Router } from "express";
import { Announcement, AuditLog, Notification } from "../models.js";
import { asyncRoute, authenticate, allowRoles } from "../middleware.js";
import { writeAudit } from "../services.js";

const router = Router();

router.get(
  "/announcements",
  authenticate,
  asyncRoute(async (_req, res) => {
    const items = await Announcement.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(
      items.map((item) => ({
        ...item,
        id: item._id.toString(),
        author: item.authorName,
        created_at: item.createdAt,
      })),
    );
  }),
);

router.post(
  "/announcements",
  authenticate,
  allowRoles("admin", "hr"),
  asyncRoute(async (req, res) => {
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();
    if (!title || !body)
      return res.status(422).json({ error: "Title and message are required." });
    const announcement = await Announcement.create({
      title,
      body,
      authorId: req.user.id,
      authorName: req.user.name,
    });
    await writeAudit(
      req.user,
      "create",
      "announcement",
      announcement.id,
      null,
      announcement.toJSON(),
    );
    res.status(201).json(announcement);
  }),
);

router.get(
  "/notifications",
  authenticate,
  asyncRoute(async (req, res) => {
    const notifications = await Notification.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(
      notifications.map((item) => ({
        ...item,
        id: item._id.toString(),
        read_at: item.readAt,
        created_at: item.createdAt,
      })),
    );
  }),
);

router.patch(
  "/notifications/:id/read",
  authenticate,
  asyncRoute(async (req, res) => {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!notification)
      return res.status(404).json({ error: "Notification not found." });
    res.json(notification);
  }),
);

router.get(
  "/audit",
  authenticate,
  allowRoles("admin"),
  asyncRoute(async (_req, res) => {
    const rows = await AuditLog.find()
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json(
      rows.map((row) => ({
        ...row,
        id: row._id.toString(),
        actor_name: row.actorName,
        created_at: row.createdAt,
        before_json: row.before,
        after_json: row.after,
      })),
    );
  }),
);

export default router;
