import { z } from "zod";

export const agentTokenNameSchema = z
  .string()
  .trim()
  .min(1, "Name the token, e.g. after the agent or machine that uses it.")
  .max(80, "Keep the name under 80 characters.")
  .regex(/^[^\p{Cc}]+$/u, "The name cannot contain control characters.");

/** An agent token as the management routes report it; never its secret. */
export const agentTokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["write", "read"]),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export type AgentTokenInfo = z.infer<typeof agentTokenInfoSchema>;

/** The one response that carries a token: the reply to creating it. */
export const createdAgentTokenSchema = z.object({
  token: z.string().startsWith("wbat_"),
  info: agentTokenInfoSchema,
});

export type CreatedAgentToken = z.infer<typeof createdAgentTokenSchema>;
