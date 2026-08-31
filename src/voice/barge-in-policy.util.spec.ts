import { evaluateBargeInEligibility, looksLikeIncompleteUtterance } from './barge-in-policy.util';

describe('evaluateBargeInEligibility', () => {
  const tuning = { bargeInGraceMs: 700, bargeInMinChars: 12, now: 10_000 };

  it('rejects when the caller is already being explicitly waited on', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: true,
        callEnding: false,
        turnState: 'agent-speaking',
        agentSpeakingSince: 0,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(result).toEqual({ eligible: false, reason: 'waiting_for_user' });
  });

  it('rejects once the call is ending', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: true,
        turnState: 'agent-speaking',
        agentSpeakingSince: 0,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(result.reason).toBe('call_ending');
  });

  it('rejects when the agent is not currently speaking', () => {
    const result = evaluateBargeInEligibility(
      { isWaitingForUser: false, callEnding: false, turnState: 'waiting-for-user' },
      'this is a long enough phrase',
      tuning,
    );
    expect(result.reason).toBe('not_speaking');
  });

  it('rejects when interruption_sensitivity is explicitly disabled', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        interruptionSensitivity: 0,
        agentSpeakingSince: 0,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(result.reason).toBe('sensitivity_zero');
  });

  it('falls back to node-level sensitivity when no explicit override is set', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        nodeInterruptionSensitivity: 0,
        agentSpeakingSince: 0,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(result.reason).toBe('sensitivity_zero');
  });

  it('rejects during the onset grace window (echo guard)', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        agentSpeakingSince: 9_500,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(result.reason).toBe('within_onset_grace');
  });

  it('shrinks the grace window for a high explicit interruption_sensitivity', () => {
    // A sensitivity of 1.0 halves the 700ms default grace window to 350ms. 300ms in is still
    // within that shrunk window.
    const stillTooSoon = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        interruptionSensitivity: 1,
        agentSpeakingSince: 9_700,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(stillTooSoon.reason).toBe('within_onset_grace');

    const pastShrunkGrace = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        interruptionSensitivity: 1,
        agentSpeakingSince: 9_600,
      },
      'this is a long enough phrase',
      tuning,
    );
    expect(pastShrunkGrace.eligible).toBe(true);
  });

  it('rejects short tokens as likely echo/noise', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        agentSpeakingSince: 0,
      },
      'yes',
      tuning,
    );
    expect(result.reason).toBe('too_short');
  });

  it('accepts a clear barge-in past the grace window with enough length', () => {
    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: false,
        callEnding: false,
        turnState: 'agent-speaking',
        agentSpeakingSince: 0,
      },
      'wait, actually I need something else',
      tuning,
    );
    expect(result).toEqual({ eligible: true });
  });
});

describe('looksLikeIncompleteUtterance', () => {
  it('flags a transcript trailing off on a conjunction', () => {
    expect(looksLikeIncompleteUtterance('I need a table for four and')).toBe(true);
  });

  it('flags a bare filler word', () => {
    expect(looksLikeIncompleteUtterance('um')).toBe(true);
  });

  it('does not flag a sentence ending in terminal punctuation', () => {
    expect(looksLikeIncompleteUtterance('I need a table for four.')).toBe(false);
  });

  it('does not flag an ordinary complete utterance', () => {
    expect(looksLikeIncompleteUtterance('book me a table for four')).toBe(false);
  });

  it('treats empty input as complete (nothing to hold)', () => {
    expect(looksLikeIncompleteUtterance('   ')).toBe(false);
  });
});
