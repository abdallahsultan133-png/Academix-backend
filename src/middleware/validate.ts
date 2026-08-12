import type { Request, Response, NextFunction } from "express";
import type { ZodType } from "zod";

/**
 * Validates req.body against a zod schema. On success, req.body is replaced
 * with the parsed (and coerced/defaulted) data so downstream handlers can
 * trust its shape. On failure, responds 400 with per-field messages.
 */
export const validateBody = (schema: ZodType) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            return res.status(400).json({
                error: "Validation failed",
                details: result.error.issues.map((issue) => ({
                    path: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }
        req.body = result.data;
        next();
    };
};
