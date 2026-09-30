import { Type, type Static } from "@sinclair/typebox";

const requestId = Type.String({
  pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$",
});
const singleLine = (maxLength: number) =>
  Type.String({ minLength: 1, maxLength, pattern: "^[^\\x00-\\x1f\\x7f]+$" });
const message = Type.String({ minLength: 1, maxLength: 12_000, pattern: "^[^\\x00]+$" });

/** Public intake never accepts an organization, user identity, or delivery state. */
export const CloudSupportInputSchema = Type.Object(
  {
    requestId,
    name: singleLine(120),
    email: Type.String({
      minLength: 3,
      maxLength: 254,
      pattern:
        /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/
          .source,
    }),
    subject: singleLine(200),
    message,
    source: Type.Union([Type.Literal("support"), Type.Literal("contact")]),
  },
  { additionalProperties: false },
);
export type CloudSupportInput = Static<typeof CloudSupportInputSchema>;

export const CloudSupportStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("resolved"),
]);
export const CloudSupportReplySchema = Type.Object(
  {
    requestId,
    message,
    resolve: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CloudSupportReply = Static<typeof CloudSupportReplySchema>;

export const CloudSupportIdSchema = Type.String({ pattern: "^SUP-[A-F0-9]{24}$" });
export const CloudSupportReceiptSchema = Type.Object(
  {
    id: CloudSupportIdSchema,
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type CloudSupportReceipt = Static<typeof CloudSupportReceiptSchema>;
