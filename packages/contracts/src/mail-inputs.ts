/** JSON inputs for mail administration. Provisioning streams stay in the UI. */
import { Type } from "@sinclair/typebox";
import { ResourceIdSchema } from "./deployment-resources";
import { CreateBackupPolicySchema } from "./backups";

const optionalText = Type.Optional(Type.String());
const optionalCount = Type.Optional(Type.Integer({ minimum: 0 }));
const nullableText = Type.Union([Type.String(), Type.Null()]);
const domainFields = {
  description: optionalText,
  maxMailboxes: optionalCount,
  maxAliases: optionalCount,
  defaultQuotaMB: optionalCount,
};
const mailboxFields = {
  name: optionalText,
  quotaMB: optionalCount,
};
const inboundFields = {
  name: Type.String({ minLength: 1 }),
  scope: Type.Union([Type.Literal("mailbox"), Type.Literal("domain"), Type.Literal("all")]),
  target: Type.Optional(nullableText),
  channelIds: Type.Array(ResourceIdSchema),
  enabled: Type.Optional(Type.Boolean()),
  fromPattern: Type.Optional(nullableText),
  subjectPattern: Type.Optional(nullableText),
  maxSpamScore: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
};

export const MailRequestSchemas = {
  server: Type.Object({ serverId: ResourceIdSchema }),
  status: Type.Object({ serverId: Type.Optional(ResourceIdSchema) }),
  health: Type.Object({ refreshReachability: Type.Optional(Type.Boolean()) }),
  certificate: Type.Object({ autoRenew: Type.Boolean() }, { additionalProperties: false }),
  domainFilter: Type.Object({ domain: optionalText }),
  logs: Type.Object({ lines: Type.Optional(Type.Integer({ minimum: 1 })) }),
  createDomain: Type.Object({ domain: Type.String({ minLength: 1 }), ...domainFields }),
  updateDomain: Type.Object({ ...domainFields, active: Type.Optional(Type.Boolean()) }),
  deleteDomain: Type.Object({ cascade: Type.Optional(Type.Boolean({ default: false })) }),
  createMailbox: Type.Object({
    localPart: Type.String({ minLength: 1 }),
    domain: Type.String({ minLength: 1 }),
    password: Type.String({ minLength: 1 }),
    ...mailboxFields,
  }),
  updateMailbox: Type.Object({
    ...mailboxFields,
    password: optionalText,
    active: Type.Optional(Type.Boolean()),
  }),
  deleteMailbox: Type.Object({ hard: Type.Optional(Type.Boolean({ default: false })) }),
  createAlias: Type.Object({
    domain: Type.String({ minLength: 1 }),
    localPart: optionalText,
    isCatchAll: Type.Optional(Type.Boolean()),
    destination: Type.String({ minLength: 1 }),
  }),
  updateAlias: Type.Object({ active: Type.Boolean() }),
  saveBackupPolicy: Type.Object({
    destinationId: ResourceIdSchema,
    messageData: Type.Optional(Type.Boolean({ default: false })),
    keys: Type.Optional(Type.Boolean({ default: true })),
    cronExpression: CreateBackupPolicySchema.properties.cronExpression,
    retainCount: CreateBackupPolicySchema.properties.retainCount,
    retainDays: CreateBackupPolicySchema.properties.retainDays,
  }),
  testEmail: Type.Object({ to: Type.String({ minLength: 1 }), fromDomain: optionalText }),
  createInboundRule: Type.Object(inboundFields),
  updateInboundRule: Type.Partial(Type.Object({ ...inboundFields, pausedReason: Type.Null() })),
  deployWebmail: Type.Object({
    mailServerId: ResourceIdSchema,
    hostname: Type.String({ minLength: 1 }),
    target: Type.Union([
      Type.Object({ kind: Type.Literal("self"), serverId: ResourceIdSchema }),
      Type.Object({ kind: Type.Literal("cloud") }),
    ]),
    replaceLegacy: Type.Optional(Type.Boolean({ default: false })),
  }),
} as const;
