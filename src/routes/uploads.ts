import express from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/require-auth.js";

const router = express.Router();

// POST /api/uploads/sign — signs whatever params the Cloudinary upload widget
// sends (folder, timestamp, source, etc.) so the widget can do a *signed*
// upload instead of relying on an unsigned preset anyone could hit directly.
// Cloudinary's rule: sign exactly the params the widget will send, sorted by
// key, joined as "key=value&key=value", secret appended, SHA1 hashed.
router.post("/sign", requireAuth, (req, res) => {
    try {
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        if (!apiSecret) {
            return res.status(500).json({ error: "Cloudinary is not configured on the server." });
        }

        const { paramsToSign } = req.body as { paramsToSign?: Record<string, string | number> };
        if (!paramsToSign || typeof paramsToSign !== "object") {
            return res.status(400).json({ error: "paramsToSign is required" });
        }

        const toSign = Object.keys(paramsToSign)
            .sort()
            .map((key) => `${key}=${paramsToSign[key]}`)
            .join("&");

        const signature = crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");

        res.json({ signature });
    } catch (e) {
        console.error("POST /uploads/sign error:", e);
        res.status(500).json({ error: "Failed to sign upload" });
    }
});

export default router;
