import Twilio from 'twilio';

export class TwilioClient {
  private readonly client: ReturnType<typeof Twilio>;
  constructor(accountSid: string, authToken: string) {
    this.client = Twilio(accountSid, authToken);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const account = await this.client.api.accounts(this.client.accountSid).fetch();
      return !!account.sid;
    } catch (e: unknown) {
      const err = e as { code?: unknown; message?: unknown };
      console.error('Twilio health check failed:', err.code, err.message);
      throw e;
    }
  }

  /** Account balance (currency and amount as returned by Twilio). Not all accounts expose balance. */
  async getAccountBalance(): Promise<{ balance: string; currency: string }> {
    const row = await this.client.balance.fetch();
    return { balance: row.balance, currency: row.currency };
  }

  async call(to: string, from: string, url: string): Promise<string> {
    const call = await this.client.calls.create({
      to,
      from,
      url,
      method: 'POST',
    });
    return call.sid;
  }

  /**
   * Replace live call TwiML (e.g. leave &lt;Connect&gt;&lt;Stream&gt; and bridge to a human via Dial).
   */
  async redirectCallToUrl(callSid: string, url: string): Promise<void> {
    await this.client.calls(callSid).update({
      url,
      method: 'POST',
    });
  }

  /** End an active call from the server (e.g. after playing a one-way message). */
  async endCall(callSid: string): Promise<void> {
    await this.client.calls(callSid).update({ status: 'completed' });
  }

  /** Fetch current call status from Twilio (e.g. "queued" | "ringing" | "in-progress" | "completed" | "busy" | "failed" | "no-answer" | "canceled"). */
  async getCallStatus(callSid: string): Promise<string> {
    const call = await this.client.calls(callSid).fetch();
    return call.status;
  }
}
