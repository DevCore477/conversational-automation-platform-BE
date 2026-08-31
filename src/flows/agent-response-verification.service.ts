import { Injectable, Logger } from '@nestjs/common';

import { OpenAIClient } from '../clients/openai/openai.client';
import { OpenAIModel } from '../common/enums';
import type {
  AgentResponseVerificationInput,
  AgentResponseVerificationResult,
} from './types/agent-response-verification.types';

@Injectable()
export class AgentResponseVerificationService {
  private readonly logger = new Logger(AgentResponseVerificationService.name);

  constructor(private readonly openaiClient: OpenAIClient) {}

  /**
   * Verifies the AI-generated response and, if invalid, returns a corrected response
   * (suggestion from verifier or LLM-corrected). Never returns null — always returns
   * a string so the agent has something to say.
   */
  async verifyAndCorrect(input: AgentResponseVerificationInput): Promise<string> {
    const result = await this.verify(input);
    if (result.valid) return input.generatedResponse;

    if (result.suggestion && result.suggestion.trim().length >= 3) {
      this.logger.debug(`Using verifier suggestion (issues: ${result.issues.join(', ')})`);
      return result.suggestion.trim();
    }

    const corrected = await this.correctResponse(input.generatedResponse, result.issues, input);
    if (corrected && corrected.trim().length >= 3) {
      this.logger.debug('Using LLM-corrected response');
      return corrected.trim();
    }

    return input.generatedResponse;
  }

  /**
   * Verifies an AI-generated agent response against user input and flow context.
   * Checks structure, language, appropriateness (e.g. asks for missing info when user gave only part),
   * and human-like quality. Returns validation result and optional suggestion.
   */
  async verify(input: AgentResponseVerificationInput): Promise<AgentResponseVerificationResult> {
    const {
      generatedResponse,
      userInput,
      nodeContext,
      slotName,
      language = 'en',
      generationType,
      recentTurns = [],
    } = input;

    const recentContext =
      recentTurns.length > 0
        ? `Recent turns:\n${recentTurns.map(t => `${t.role}: ${t.text}`).join('\n')}\n\n`
        : '';

    const langInstruction =
      language === 'no'
        ? 'The response MUST be in Norwegian (Bokmål). If it is in English or mixed, mark invalid and suggest a Norwegian version.'
        : 'The response should be in English (or the expected call language).';

    const prompt = `You are a quality checker for a phone agent's AI-generated responses.

AGENT'S CURRENT STEP CONTEXT (what the agent needs from the user):
"${nodeContext}"
${slotName ? `Slot being collected: ${slotName}` : ''}

USER'S LAST INPUT:
"${userInput}"

AI-GENERATED AGENT RESPONSE TO VALIDATE:
"${generatedResponse}"

${recentContext}

VALIDATION RULES:
1. Structure: The response must be well-formed, coherent, and one or two short sentences. No broken grammar or run-on sentences.
2. Language: ${langInstruction}
3. Appropriateness:
   - If the agent asked for TWO things (e.g. doctor name AND time) and the user gave only ONE (e.g. only "Dr. Bilal" or only "2 pm"), the response must ACKNOWLEDGE what they said and ask specifically for the MISSING part (e.g. "You said Dr. Bilal — which time slot works for you?"). If it ignores the partial answer or asks for everything again without acknowledging, mark invalid.
   - If the user asked for something specific (e.g. "what's Dr. X's availability?"), the response should address that or redirect clearly.
   - If the user gave nothing useful or went off-topic, the response should rephrase the full question or redirect; it should not answer an unrelated question.
4. Agent behavior: The response must sound like a helpful phone agent: polite, clear, and focused on the current step. No robotic or repetitive phrasing unless appropriate.

Generation type: ${generationType}

Output a JSON object only, no other text:
{
  "valid": true or false,
  "issues": ["issue 1", "issue 2"] (empty array if valid),
  "suggestion": "optional improved response if invalid"
}`;

    try {
      const raw = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content:
              'You output only a single JSON object with keys: valid (boolean), issues (array of strings), suggestion (optional string). No markdown, no explanation.',
          },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.1, maxTokens: 400 },
      );

      const parsed = this.parseVerificationResult(raw);
      if (parsed && !parsed.valid && parsed.issues.length > 0) {
        this.logger.debug(`Agent response verification failed: ${parsed.issues.join('; ')}`);
      }
      return parsed ?? { valid: true, issues: [] };
    } catch (err) {
      this.logger.warn('Verification request failed, allowing response', err);
      return { valid: true, issues: [] };
    }
  }

  /**
   * Asks the LLM to produce a corrected response that addresses the verification issues.
   */
  private async correctResponse(
    originalResponse: string,
    issues: string[],
    input: AgentResponseVerificationInput,
  ): Promise<string> {
    if (!issues.length) return originalResponse;

    const prompt = `You are fixing a phone agent's response that failed quality checks.

CONTEXT (what the agent needs from the user or script):
"${input.nodeContext}"

USER'S LAST INPUT:
"${input.userInput}"

ORIGINAL AGENT RESPONSE (has issues):
"${originalResponse}"

ISSUES TO FIX:
${issues.map((i, n) => `${String(n + 1)}. ${i}`).join('\n')}

${input.language === 'no' ? 'Output the corrected response in Norwegian (Bokmål) only.' : 'Output the corrected response in the same language as expected for the call.'}

Rules: Address every issue. Keep the response short (1-2 sentences). Sound natural and helpful. Output ONLY the corrected response, no quotes or explanation.`;

    try {
      const raw = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content:
              'You output only the corrected agent response. No preamble, no quotes, no explanation.',
          },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.2, maxTokens: 200 },
      );
      const trimmed = raw.trim();
      return trimmed.length >= 3 ? trimmed : originalResponse;
    } catch (err) {
      this.logger.warn('CorrectResponse failed, using original', err);
      return originalResponse;
    }
  }

  private parseVerificationResult(raw: string): AgentResponseVerificationResult | null {
    const trimmed = raw.trim();
    const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
    if (!jsonMatch) return null;
    try {
      const obj = JSON.parse(jsonMatch[0]) as {
        valid?: boolean;
        issues?: string[];
        suggestion?: string;
      };
      return {
        valid: obj.valid === true,
        issues: Array.isArray(obj.issues) ? obj.issues : [],
        suggestion:
          typeof obj.suggestion === 'string' && obj.suggestion.trim()
            ? obj.suggestion.trim()
            : undefined,
      };
    } catch {
      return null;
    }
  }
}
