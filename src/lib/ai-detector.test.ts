import { describe, expect, it } from "vitest";
import { ruleScreen, stylometry } from "./ai-detector.js";

// ruleScreen + stylometry are the deterministic, no-API-key half of AI
// screening. They are intentionally sensitivity-biased: better to send a clean
// submission for a second read than to let an AI-assisted one through
// unflagged. These tests pin that bias down.

describe("ruleScreen — verbatim assistant phrasing (near-conclusive)", () => {
    const hardTellSamples = [
        "As an AI language model, I cannot share personal opinions, but here is an essay.",
        "As a large language model, I don't have access to real-time data.",
        "Certainly! Here's a well-structured response to your prompt.",
        "I'm sorry, but I cannot fulfil that request as stated.",
        "Here is a revised paragraph. Feel free to adjust the wording to your voice.",
        "My knowledge cutoff is 2023, so I may be missing recent developments.",
        "I hope this helps! Let me know if you need anything else.",
    ];

    for (const sample of hardTellSamples) {
        it(`flags: ${JSON.stringify(sample.slice(0, 42))}...`, () => {
            const { score, notes } = ruleScreen(sample);
            expect(score).toBeGreaterThanOrEqual(95);
            expect(notes.join(" ")).toMatch(/verbatim/i);
        });
    }
});

describe("ruleScreen — plain human writing stays low", () => {
    it("scores zero for short, personal, casual writing", () => {
        const text =
            "i think the french revolution happened cuz people were broke and hungry. " +
            "my grandpa used to tell me stories about how his village dealt with famine.";
        expect(ruleScreen(text).score).toBe(0);
    });

    it("does not let a lone stylistic quirk (an em dash) dominate", () => {
        const text = "The result was surprising - we did not expect the reaction to reverse.";
        expect(ruleScreen(text).score).toBeLessThanOrEqual(10);
    });

    it("keeps a single cliché phrase well short of a flag", () => {
        const text =
            "When it comes to my science project I built a small volcano with baking soda " +
            "and vinegar and it fizzed over the table which my mum was not happy about.";
        expect(ruleScreen(text).score).toBeLessThanOrEqual(15);
    });
});

describe("stylometry — structural signals catch AI text with no telltale phrases", () => {
    it("flags uniform, connective-heavy, contraction-free prose", () => {
        const text =
            "The Industrial Revolution transformed manufacturing across Europe. " +
            "Furthermore, it changed how people lived and worked in growing cities. " +
            "Moreover, it created new social classes with competing interests. " +
            "Additionally, it accelerated technological innovation in many fields. " +
            "Consequently, governments began to regulate labour and industry. " +
            "Therefore, its effects are still visible in the modern economy.";
        const { points, notes } = stylometry(text);
        expect(points).toBeGreaterThanOrEqual(25);
        expect(notes.join(" ")).toMatch(/connective|uniform|contraction/i);
    });

    it("raises a review-level score when clichés and structure stack", () => {
        const text =
            "In today's world, it is important to note that technology plays a crucial role. " +
            "Furthermore, we must delve into this multifaceted tapestry of innovation. " +
            "Moreover, the implications are profound and comprehensive. " +
            "In conclusion, the impact is significant.";
        const { score, notes } = ruleScreen(text);
        expect(score).toBeGreaterThan(20);
        expect(score).toBeLessThanOrEqual(85); // deterministic-only never reads as "certain"
        expect(notes.join(" ")).toMatch(/style\/structure/i);
    });

    it("flags pasted invisible unicode characters", () => {
        const zw = String.fromCharCode(0x200b);
        const text =
            "The mitochondria is the powerhouse of the cell and produces energy" + zw +
            " for the organism through a process called cellular respiration.";
        expect(stylometry(text).notes.join(" ")).toMatch(/invisible unicode/i);
    });

    it("ignores very short text (too little to analyse structurally)", () => {
        expect(stylometry("Photosynthesis makes food from light.").points).toBe(0);
    });
});

describe("ruleScreen — a verbatim tell always outweighs style signals", () => {
    it("returns the high hard-tell score even amid stylistic markers", () => {
        const text =
            "As an AI language model, in today's world it is important to note this " +
            "multifaceted tapestry. In conclusion, here is your essay.";
        expect(ruleScreen(text).score).toBeGreaterThanOrEqual(95);
    });
});
