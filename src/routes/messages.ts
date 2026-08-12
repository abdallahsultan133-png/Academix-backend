import express from "express";
import { and, desc, eq, or, sql, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { sendMessageSchema } from "../lib/schemas.js";

const router = express.Router();

// GET /api/messages/conversations — list of recent conversations for current user
router.get("/conversations", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id!;

        // Get unique conversation partners with latest message + unread count
        const rows = await db.execute(sql`
            SELECT
                CASE WHEN sender_id = ${userId} THEN receiver_id ELSE sender_id END AS partner_id,
                MAX(created_at) AS last_at,
                (SELECT content FROM messages m2
                    WHERE (m2.sender_id = ${userId} AND m2.receiver_id = CASE WHEN sender_id = ${userId} THEN receiver_id ELSE sender_id END)
                       OR (m2.receiver_id = ${userId} AND m2.sender_id = CASE WHEN sender_id = ${userId} THEN receiver_id ELSE sender_id END)
                    ORDER BY m2.created_at DESC LIMIT 1) AS last_message,
                COUNT(*) FILTER (WHERE receiver_id = ${userId} AND read = false) AS unread_count
            FROM messages
            WHERE sender_id = ${userId} OR receiver_id = ${userId}
            GROUP BY partner_id
            ORDER BY last_at DESC
        `);

        const partnerIds = (rows.rows as { partner_id: string }[]).map((r) => r.partner_id);
        if (partnerIds.length === 0) return res.json({ data: [] });

        const partners = await db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image, role: user.role })
            .from(user)
            .where(or(...partnerIds.map((id) => eq(user.id, id))));

        const partnerMap = Object.fromEntries(partners.map((p) => [p.id, p]));

        const conversations = (rows.rows as { partner_id: string; last_at: string; last_message: string; unread_count: number }[]).map((r) => ({
            partner: partnerMap[r.partner_id],
            lastMessage: r.last_message,
            lastAt: r.last_at,
            unreadCount: Number(r.unread_count),
        }));

        res.json({ data: conversations });
    } catch (e) {
        console.error("GET /messages/conversations error:", e);
        res.status(500).json({ error: "Failed to load conversations" });
    }
});

// GET /api/messages/thread/:partnerId — full message thread with another user
router.get("/thread/:partnerId", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id!;
        const partnerId = String(req.params.partnerId ?? "");
        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

        const thread = await db
            .select({
                id: messages.id,
                content: messages.content,
                senderId: messages.senderId,
                read: messages.read,
                createdAt: messages.createdAt,
                sender: { id: user.id, name: user.name, image: user.image },
            })
            .from(messages)
            .innerJoin(user, eq(messages.senderId, user.id))
            .where(
                or(
                    and(eq(messages.senderId, userId), eq(messages.receiverId, partnerId)),
                    and(eq(messages.senderId, partnerId), eq(messages.receiverId, userId))
                )
            )
            .orderBy(desc(messages.createdAt))
            .limit(limit);

        // Mark received messages as read
        await db.update(messages)
            .set({ read: true })
            .where(and(eq(messages.senderId, partnerId), eq(messages.receiverId, userId), eq(messages.read, false)));

        res.json({ data: thread.reverse() }); // oldest first for chat UI
    } catch (e) {
        console.error("GET /messages/thread error:", e);
        res.status(500).json({ error: "Failed to load messages" });
    }
});

// POST /api/messages — send a message
router.post("/", requireAuth, validateBody(sendMessageSchema), async (req, res) => {
    try {
        const senderId = req.user!.id!;
        const { receiverId, content } = req.body as { receiverId: string; content: string };

        if (receiverId === senderId) return res.status(400).json({ error: "Cannot message yourself" });

        const [msg] = await db.insert(messages).values({
            senderId,
            receiverId,
            content: content.trim(),
            read: false,
        }).returning();

        res.status(201).json({ data: msg });
    } catch (e) {
        console.error("POST /messages error:", e);
        res.status(500).json({ error: "Failed to send message" });
    }
});

// GET /api/messages/unread-count
router.get("/unread-count", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id!;
        const result = await db
            .select({ count: sql<number>`count(*)` })
            .from(messages)
            .where(and(eq(messages.receiverId, userId), eq(messages.read, false)));
        const count = result[0]?.count ?? 0;
        res.json({ count });
    } catch (e) {
        res.status(500).json({ error: "Failed to get unread count" });
    }
});

export default router;
