import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import { submissions } from "../db/schema/app.js";
import { getAnthropicClient } from "./anthropic.js";

// Screen anything past a few words — a two-sentence answer can be AI-written
// just as easily as an essay.
const MIN_CONTENT_LENGTH = 20;
const MODEL_INPUT_LIMIT = 12000;

// IMPORTANT: this is a *review-assist signal*, not proof. No detector — this one
// included — can reliably separate AI-assisted text from human text, and every
// one of them also false-flags real student writing (formal or non-native
// writers most of all). A score here only routes a submission to a human grader
// for a closer look; it must never auto-penalise. The grading UI reflects that.
//
// Two passes feed the stored score, and we keep the higher of the two:
//   1. deterministicScreen()  — regex + stylometry, always runs, no API key
//   2. modelScreen()          — an LLM judgement, only when ANTHROPIC_API_KEY set
// Until the key is set, pass 1 carries everything.

// ── Pass 1a: verbatim tells ──────────────────────────────────────────────────
// Phrases an assistant emits that a student leaves in when pasting without
// editing. A hit here is about as close to conclusive as a rule can get.
const HARD_TELLS: RegExp[] = [
    /\bas an? (?:AI|LLM|large language model|language model)\b/i,
    /\bas an? AI\b[\s\S]{0,60}\bI (?:can(?:not|['’]t)|do not have|don['’]t have|am unable)\b/i,
    /\bI(?:['’]m| am) sorry,?\s+but I (?:can(?:not|['’]t)|am unable)\b/i,
    /\bI can(?:not|['’]t) (?:fulfil{1,2}|assist with|help with|comply|provide that)\b/i,
    /\b(?:knowledge|training) (?:cut[- ]?off|cutoff)\b/i,
    /\bmy (?:last )?(?:knowledge )?(?:update|training)\b[\s\S]{0,20}\b(?:20\d\d|is in)\b/i,
    /\bI (?:do not|don['’]t) have (?:access to )?real[- ]time\b/i,
    /^\s*(?:certainly|sure|absolutely|great question)[!,.]\s+(?:here(?:['’]s| is)|I(?:['’]ll| will)|below)/im,
    /\bhere(?:['’]s| is) (?:a|an|the) (?:possible |sample |draft |revised |polished )?(?:essay|response|answer|version|rewrite|draft|paragraph)\b/i,
    /\b(?:feel free to|please) (?:adjust|modify|customize|customise|tweak|expand on|let me know)\b/i,
    /\bI hope this helps\b/i,
    /\blet me know if you(?: need| have|['’]d like)\b/i,
];

// ── Pass 1b: soft phrase clichés ─────────────────────────────────────────────
// Individually weak — plenty of people write this way — but collectively a tell.
const PHRASE_CLICHES: { re: RegExp; label: string }[] = [
    { re: /\b(?:delve|delving) into\b/i, label: '"delve into"' },
    { re: /\b(?:rich |vibrant )?tapestry\b/i, label: '"tapestry"' },
    { re: /\b(?:multifaceted|multi-faceted)\b/i, label: '"multifaceted"' },
    { re: /\bit(?:['’]s| is) (?:important|worth|crucial|essential) to (?:note|remember|consider|understand)\b/i, label: '"it is important to note"' },
    { re: /\bin (?:today['’]s|the modern|this digital) (?:world|society|age|era|landscape)\b/i, label: 'generic "in today’s world" framing' },
    { re: /\bplays? an? (?:crucial|pivotal|vital|significant|key|central|important) role\b/i, label: '"plays a crucial role"' },
    { re: /\ba (?:wide|broad) (?:range|array|variety) of\b/i, label: '"a wide range of"' },
    { re: /\bwhen it comes to\b/i, label: '"when it comes to"' },
    { re: /\bit (?:is|remains) (?:crucial|essential|imperative) to\b/i, label: '"it is essential to"' },
    { re: /\bshed(?:ding)? light on\b/i, label: '"shed light on"' },
    { re: /\bnavigat(?:e|ing) the (?:complexities|landscape|challenges)\b/i, label: '"navigate the complexities"' },
];

// AI models reach for these far more than students do.
const AI_VOCAB = /\b(?:delve|tapestry|multifaceted|nuanced|intricate|intricacies|realm|landscape|underscore[sd]?|testament|robust|leverage[sd]?|foster[s]?|holistic|paradigm|synerg(?:y|ies)|pivotal|cornerstone|beacon|embark|elevate|seamless(?:ly)?|meticulous(?:ly)?|profound|myriad|comprehensive|encompass(?:es|ing)?|facilitate[sd]?|endeavor)\b/gi;

// Formal connectives that AI over-uses at the *start* of sentences.
const CONNECTIVE_OPENERS = /(?:^|(?<=[.!?]["')\]]?\s))(However|Moreover|Furthermore|Additionally|Consequently|Therefore|Nevertheless|Nonetheless|Notably|Importantly|Ultimately|Indeed|Thus|Hence|Similarly|In addition|In contrast|On the other hand|As a result|For instance|For example)\b/g;

const HEDGES = /\b(?:it is (?:worth|important|essential|crucial) to (?:note|remember|consider|understand)|generally speaking|broadly speaking|in general|it can be (?:seen|argued|said|viewed)|serves? as an?|a myriad of|it should be noted)\b/gi;

const CONTRACTIONS = /\b(?:can['’]t|won['’]t|don['’]t|doesn['’]t|didn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|haven['’]t|hasn['’]t|hadn['’]t|wouldn['’]t|shouldn['’]t|couldn['’]t|ain['’]t|i['’]m|you['’]re|we['’]re|they['’]re|it['’]s|that['’]s|there['’]s|he['’]s|she['’]s|i['’]ve|you['’]ve|we['’]ve|they['’]ve|i['’]d|you['’]d|i['’]ll|you['’]ll|we['’]ll|they['’]ll|let['’]s|gonna|wanna|kinda|dunno)\b/gi;
const EXPANDED_FORMS = /\b(?:cannot|will not|do not|does not|did not|is not|are not|was not|were not|have not|has not|had not|would not|should not|could not|it is|that is|there is|we are|they are|you are|I am)\b/g;

// Zero-width space / non-joiner / joiner / word-joiner / BOM. Built from char
// codes so no invisible characters live in this source file; students rarely
// type these, but they ride along when AI output is pasted from some editors.
const ZERO_WIDTH = new RegExp(
    "[" + String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff) + "]",
);

export type RuleFinding = { score: number; notes: string[] };

const count = (re: RegExp, text: string): number => (text.match(re) ?? []).length;

function splitSentences(text: string): string[] {
    return text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z0-9"'(])/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Structural / stylometric signals — the part that catches AI text with no
 * telltale phrases at all. Each signal adds points; several unrelated signals
 * firing together adds a bit more. Capped well below "certain" because
 * deterministic style analysis alone can't earn that.
 */
export function stylometry(text: string): { points: number; notes: string[] } {
    const notes: string[] = [];
    let points = 0;
    let categories = 0;
    const add = (p: number, note: string) => {
        points += p;
        categories += 1;
        notes.push(note);
    };

    // Zero-width characters are diagnostic at any length — almost always pasted
    // machine output — so this runs before the too-short gate below.
    if (ZERO_WIDTH.test(text)) add(20, "invisible unicode characters (typical of pasted AI output)");

    const wordCount = count(/[A-Za-z][A-Za-z'’-]*/g, text);
    if (wordCount < 25) return { points: Math.min(points, 78), notes };

    const sentences = splitSentences(text);

    // 1. Uniform sentence length (low "burstiness"). Human prose swings between
    //    short and long; AI prose is even.
    if (sentences.length >= 5) {
        const lens = sentences.map((s) => count(/[A-Za-z][A-Za-z'’-]*/g, s)).filter((n) => n > 0);
        const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
        const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
        const cv = mean > 0 ? sd / mean : 1;
        if (cv < 0.33) add(16, "near-identical sentence lengths");
        else if (cv < 0.48) add(8, "unusually uniform sentence lengths");
    }

    // 2. Zero contractions in a body that repeatedly spells the forms out.
    if (wordCount >= 60 && count(CONTRACTIONS, text) === 0 && count(EXPANDED_FORMS, text) >= 3) {
        add(14, "no contractions despite a conversational topic");
    }

    // 3. Formal connective openers.
    const openers = count(CONNECTIVE_OPENERS, text);
    if (openers >= 5) add(18, `${openers} formal connective sentence-openers`);
    else if (openers >= 3) add(10, `${openers} formal connective sentence-openers`);

    // 4. Hedging / filler phrasing.
    const hedges = count(HEDGES, text);
    if (hedges >= 3) add(14, "frequent hedging / filler phrasing");
    else if (hedges >= 1) points += 5;

    // 5. AI-favoured vocabulary cluster.
    const vocab = count(AI_VOCAB, text);
    if (vocab >= 4) add(16, "dense cluster of AI-favoured vocabulary");
    else if (vocab >= 2) add(8, "AI-favoured vocabulary");

    // 6. Phrase clichés (pass 1b), folded in as one category.
    const cliches = PHRASE_CLICHES.filter((c) => c.re.test(text)).map((c) => c.label);
    if (cliches.length >= 2) add(14, `AI-cliché phrasing: ${cliches.slice(0, 4).join(", ")}`);
    else if (cliches.length === 1) points += 6;

    // 7. Listicle / heading structure inside what should be prose.
    const bullets = count(/^\s*(?:\d+\.|[-*•])\s+\S/gm, text);
    if (/\*\*[^*\n]{3,80}\*\*/.test(text) || /^#{1,4}\s+\S/m.test(text) || bullets >= 3) {
        add(10, "bulleted / heading structure");
    }

    // 8. Formulaic conclusion opener.
    if (/(?:^|\n)\s*(?:In conclusion|In summary|To summari[sz]e|To sum up|Overall|To conclude|In closing)\b/i.test(text)) {
        add(8, 'formulaic conclusion opener');
    }

    // 9. Mechanically perfect casing + terminal punctuation over a long body,
    //    with no casual lowercase "i".
    if (wordCount >= 90 && sentences.length >= 6) {
        const proper = sentences.filter((s) => /^["'(]?[A-Z0-9]/.test(s) && /[.!?]["')\]]?$/.test(s)).length;
        if (proper / sentences.length >= 0.97 && !/\bi\b/.test(text)) {
            points += 8;
            notes.push("mechanically consistent casing and punctuation");
        }
    }

    // Independent-category bump.
    if (categories >= 4) points += 12;
    else if (categories >= 3) points += 6;

    return { points: Math.min(points, 78), notes };
}

/**
 * Pass 1: deterministic screen. Runs with or without an API key. A verbatim
 * assistant phrase short-circuits high; otherwise the score is built from
 * stylometry + phrase clichés and capped below "certain".
 */
export function ruleScreen(text: string): RuleFinding {
    if (HARD_TELLS.some((re) => re.test(text))) {
        return { score: 97, notes: ["contains phrasing an AI assistant emits verbatim"] };
    }

    const stylo = stylometry(text);
    if (stylo.points <= 0) return { score: 0, notes: [] };

    return {
        score: Math.min(85, stylo.points),
        notes: [`style/structure: ${stylo.notes.join("; ")}`],
    };
}

// ── Pass 2: model judgement ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an academic-integrity assistant helping a teacher triage which submissions to read closely. Estimate the likelihood that the student text below was written, outlined, translated, or substantially rewritten with help from an AI language model.

Weigh stylistic and structural cues: unnatural uniformity, generic or hedging phrasing, textbook-perfect structure with no personal voice, a register inconsistent with typical student writing, over-comprehensive coverage, or absence of the small errors and idiosyncrasies human drafts usually carry. Partial AI assistance (an AI-written outline, an AI translation, an AI "polish" pass) still counts as AI-involved.

Calibration: 0 = confidently human, 100 = confidently AI. When you genuinely cannot tell human from AI, do NOT default to a low score - return 45-60 so a human checks. Reserve scores under 20 for text with clear signs of human authorship (specific personal detail, uneven voice, localised references, natural minor errors).

Respond with ONLY a JSON object, no other text, in this exact shape:
{"score": <integer 0-100>, "summary": "<one concise sentence of reasoning; name the specific cues>"}`;

type ModelFinding = { score: number; summary: string | null };

async function modelScreen(text: string): Promise<ModelFinding | null> {
    const client = getAnthropicClient();
    if (!client) return null;

    try {
        const message = await client.messages.create({
            model: "claude-opus-5",
            max_tokens: 300,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: text.slice(0, MODEL_INPUT_LIMIT) }],
        });

        const replyText = message.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();

        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; summary?: unknown };
        const score = Math.round(Number(parsed.score));
        if (!Number.isFinite(score)) return null;

        return {
            score: Math.max(0, Math.min(100, score)),
            summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 400) : null,
        };
    } catch (e) {
        console.error("AI detection (model pass) failed for submission text:", e);
        return null;
    }
}

/**
 * Fire-and-forget: screens a submission's text for likely AI involvement and
 * writes an advisory score + one-line reasoning onto the row. Never throws — on
 * failure it leaves the previous value in place.
 *
 * Sensitivity-biased by design: the stored score is the MAX of the deterministic
 * pass and the model pass, so a signal from either one surfaces. This over-flags
 * some human writing; that trade-off is intentional because the score only
 * routes a submission to a human grader, it never penalises anyone.
 *
 * Blind spot: file-only submissions (PDF / DOCX uploads with no typed content)
 * are NOT screened here — there is no text to read. The grading pane shows the
 * teacher an explicit "not screened, review manually" note for those.
 */
export async function runAiDetection(submissionId: number, content: string): Promise<void> {
    const text = content.trim();
    if (text.length < MIN_CONTENT_LENGTH) return;

    const rule = ruleScreen(text);
    const model = await modelScreen(text);

    // Nothing from either pass → leave the row untouched rather than stamping a
    // misleading 0.
    if (!model && rule.score === 0) return;

    const finalScore = Math.max(rule.score, model?.score ?? 0);

    const parts: string[] = [];
    if (model?.summary) parts.push(model.summary);
    if (rule.notes.length > 0) parts.push(`Automated check — ${rule.notes.join("; ")}.`);
    if (parts.length === 0) parts.push("Flagged by automated screening; no specific cue recorded.");
    const summary = parts.join(" ").slice(0, 500);

    try {
        await db.update(submissions)
            .set({ aiScore: finalScore, aiSummary: summary })
            .where(eq(submissions.id, submissionId));
    } catch (e) {
        console.error("AI detection failed to persist for submission", submissionId, e);
    }
}
