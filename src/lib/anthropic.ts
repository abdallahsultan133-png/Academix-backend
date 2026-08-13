import Anthropic from "@anthropic-ai/sdk";

// Lazy — the key may not be set yet when this module first loads.
let anthropicClient: Anthropic | null = null;
export function getAnthropicClient(): Anthropic | null {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    if (!anthropicClient) anthropicClient = new Anthropic({ apiKey });
    return anthropicClient;
}
