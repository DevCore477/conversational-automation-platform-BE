export interface WhatsAppTokenProvider {
  getValidToken(): Promise<string>;
  recoverFromAuthFailure(): Promise<string>;
}

export class StaticWhatsAppTokenProvider implements WhatsAppTokenProvider {
  constructor(private readonly accessToken: string) {}

  async getValidToken(): Promise<string> {
    return this.accessToken;
  }

  async recoverFromAuthFailure(): Promise<string> {
    return this.accessToken;
  }
}
