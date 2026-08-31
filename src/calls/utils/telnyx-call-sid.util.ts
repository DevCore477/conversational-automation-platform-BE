/** Telnyx Call Control ID is stored as our canonical call SID with this prefix (see outbound dial). */
export function toTelnyxCallSid(callControlId: string): string {
  return `TLX_${callControlId}`;
}

export function fromTelnyxCallSid(callSid: string): string | null {
  return callSid.startsWith('TLX_') ? callSid.slice(4) : null;
}
