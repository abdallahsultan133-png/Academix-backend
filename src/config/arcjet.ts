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
        shield({
            mode: ARCJET_MODE,
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