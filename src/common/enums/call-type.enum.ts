export const CallType = ['inbound', 'outbound', 'both'] as const;

export type CallTypeValue = (typeof CallType)[number];
