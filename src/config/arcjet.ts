import arcjet, {
    shield,
    detectBot,
    slidingWindow,
} from "@arcjet/node";

if (!process.env.ARCJET_KEY && process.env.NODE_ENV !== "test") {
    throw new Error("ARCJET_KEY env is required");
}

// ARCJET_MODE=LIVE|DRY_RUN overrides the default. Without an explicit override,
// requests are actually blocked in production and only logged (DRY_RUN) in dev/test,
// so security is never silently disabled in prod but local development isn't rate-limited.
export const ARCJET_MODE: "LIVE" | "DRY_RUN" =
    process.env.ARCJET_MODE === "LIVE"
        ? "LIVE"
        : process.env.ARCJET_MODE === "DRY_RUN"
            ? "DRY_RUN"
            : process.env.NODE_ENV === "production"
                ? "LIVE"
                : "DRY_RUN";

const aj = arcjet({
    key: process.env.ARCJET_KEY!,

    rules: [
        // Shield pattern-matches request bodies/params/headers for SQLi/XSS-style
        // signatures and is prone to false positives on ordinary app traffic (JSON
        // bodies, filter/sort query params, etc). Running it in DRY_RUN always —
        // regardless of ARCJET_MODE — means it still logs to the Arcjet dashboard
        // for review, but never blocks a real logged-in user over a false alarm.
        // Flip to `mode: ARCJET_MODE` once findings have been reviewed and rules
        // tuned (e.g. via shield's allow/deny config) for this app's real traffic.
        shield({
            mode: "DRY_RUN",
        }),

        detectBot({
            mode: ARCJET_MODE,
            allow: [
                "CATEGORY:SEARCH_ENGINE",
                "CATEGORY:PREVIEW",
            ],
        }),

        slidingWindow({
            mode: ARCJET_MODE,
            interval: "30s",
            max: 1000,
        }),
    ],
});

export default aj;