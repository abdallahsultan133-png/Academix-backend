import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from '../db/schema/auth.js'
import { sendWelcomeEmail } from "./email.js";

// Only register the Google provider once real credentials are present —
// betterAuth() throws at startup if a social provider is configured with an
// empty clientId/clientSecret, so this keeps the server booting cleanly
// before the user adds GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET to .env.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: [process.env.FRONTEND_URL!],

    // Frontend (Netlify) and backend (Railway) are separate domains, so the
    // session cookie must be SameSite=None to be sent on cross-site fetch
    // requests — the default "lax" is only sent on top-level navigations.
    advanced: {
        defaultCookieAttributes: {
            sameSite: "none",
            secure: true,
        },
    },
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
    }),

    emailAndPassword: {
        enabled: true,
    },

    account: {
        accountLinking: {
            enabled: true,
            // This app has no email-verification flow, so every existing
            // email/password account has emailVerified: false. Better Auth's
            // default (require the local account to already be verified
            // before trusting the IdP's email as proof of ownership) would
            // make Google sign-in permanently unable to link to any existing
            // account. Since sign-up here isn't open to untrusted strangers
            // (accounts are provisioned/managed by school staff), we accept
            // that tradeoff rather than leave linking broken.
            requireLocalEmailVerified: false,
        },
    },

    ...(googleClientId && googleClientSecret
        ? {
              socialProviders: {
                  google: {
                      clientId: googleClientId,
                      clientSecret: googleClientSecret,
                  },
              },
          }
        : {}),

    session: {
        cookieCache: {
            enabled: true,
        },
    },

    databaseHooks: {
        user: {
            create: {
                after: async (newUser) => {
                    void sendWelcomeEmail({
                        to: newUser.email,
                        name: newUser.name,
                        frontendUrl: process.env.FRONTEND_URL!,
                    });
                },
            },
        },
    },

    user: {
        additionalFields: {
            // input: false — role must never be settable by the client at sign-up.
            // Without this, anyone could POST { role: "admin" } to /sign-up/email and
            // self-promote to admin. New accounts always start as "student"; promoting
            // someone to teacher/admin/etc. must go through PATCH /api/users/:id/role.
            role: {
                type: 'string', required: true, defaultValue: 'student', input: false,
            },
            imageCldPubId: {
                type: 'string', required: false, input: true,
            },
        }
    }
});
