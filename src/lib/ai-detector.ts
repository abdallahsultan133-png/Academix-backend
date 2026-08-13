import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import { submissions } from "../db/schema/app.js";
import { getAnthropicClient } from "./anthropic.js";

const MIN_CONTENT_LENGTH = 40;

const SYSTEM_PROMPT = `You are an academic-integrity assistant. Estimate the likelihood that the student-submitted text below was generated (or heavily rewritten) by an AI language model, based on stylistic and structural cues such as unnatural uniformity, generic phrasing, or a tone inconsistent with typical student writing.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"score": <integer 0-100, 0 = definitely human-written, 100 = definitely AI-generated>, "summary": "<one concise sentence explaining the reasoning>"}`;

/**
 * Fire-and-forget: analyzes a submission's text content for likely AI
 * authorship and writes the result onto the row once it completes. Never
 * throws — a failed or unconfigured detector just leaves aiScore/aiSummary
 * null rather than blocking or failing the submission itself.
 */
export async function runAiDetection(submissionId: number, content: string): Promise<void> {
    const text = content.trim();
    if (text.length < MIN_CONTENT_LENGTH) return;

    const client = getAnthropicClient();
    if (!client) return;

    try {
        const message = await client.messages.create({
            model: "claude-opus-5",
            max_tokens: 300,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: text.slice(0, 6000) }],
        });

        const replyText = message.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();

        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; summary?: unknown };
        const score = Math.round(Number(parsed.score));
        if (!Number.isFinite(score)) return;
        const clampedScore = Math.max(0, Math.min(100, score));
        const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : null;

        await db.update(submissions)
            .set({ aiScore: clampedScore, aiSummary: summary })
            .where(eq(submissions.id, submissionId));
    } catch (e) {
        console.error("AI detection failed for submission", submissionId, e);
    }
}
