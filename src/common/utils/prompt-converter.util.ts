export class PromptConverter {
  /**
   * Converts structured JSON config to natural language prompt for LLM
   */
  static convertToNaturalLanguage(config: any): string {
    const sections: string[] = [];

    // 1. Agent Identity and Purpose
    if (config.agent_name && config.purpose) {
      sections.push(`You are ${config.agent_name}. ${config.purpose}`);
    }

    // 2. Company Context
    if (config.context) {
      sections.push('\n## COMPANY INFORMATION:');
      Object.entries(config.context).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          sections.push(`${this.capitalize(key)}: ${value.join(', ')}`);
        } else if (value) {
          sections.push(`${this.capitalize(key)}: ${value}`);
        }
      });
    }

    // 3. Conversation Rules
    if (config.global_rules) {
      sections.push('\n## CONVERSATION RULES:');

      if (config.global_rules.voice) {
        const voice = config.global_rules.voice;
        if (voice.max_words_per_turn) {
          sections.push(`- Keep responses under ${voice.max_words_per_turn} words`);
        }
        if (voice.ask_one_question_only) {
          sections.push('- Ask only ONE question at a time');
        }
        if (voice.confirm_critical_details_once) {
          sections.push('- Always confirm critical details before finalizing');
        }
        if (voice.interruptible) {
          sections.push('- Be brief and natural. Allow interruptions.');
        }
      }

      if (config.global_rules.handoff_policy) {
        sections.push('\n## TRANSFER TO HUMAN IF:');
        const policy = config.global_rules.handoff_policy;
        if (policy.transfer_if_requested) {
          sections.push('- User requests to speak with someone');
        }
        if (policy.transfer_if_angry_or_urgent) {
          sections.push('- User sounds angry or situation is urgent');
        }
        if (policy.transfer_if_sensitive) {
          sections.push('- Topic is sensitive or requires human judgment');
        }
      }

      if (config.global_rules.memory?.capture_fields) {
        sections.push(
          `\n## INFORMATION TO CAPTURE:\n${config.global_rules.memory.capture_fields.map((f: string) => `- ${f}`).join('\n')}`,
        );
      }
    }

    // 4. State Machine as Conversation Flow
    if (config.state_machine?.states) {
      sections.push('\n## CONVERSATION FLOW:');

      const states = config.state_machine.states;

      // Group states by function
      const stateGroups = this.groupStates(states);

      Object.entries(stateGroups).forEach(([groupName, stateList]) => {
        sections.push(`\n### ${groupName}:`);
        stateList.forEach((state: any, index: number) => {
          if (state.say) {
            sections.push(`${index + 1}. Say: "${state.say}"`);
          }
          if (state.action) {
            sections.push(`   Then: ${this.actionToDescription(state.action)}`);
          }
          if (state.capture) {
            sections.push(`   Capture: ${state.capture.join(', ')}`);
          }
        });
      });
    }

    sections.push(
      '\n## GUIDELINES:\n- Be natural and conversational\n- Follow the flow above but adapt to user needs\n- Always confirm before finalizing\n- Transfer to human when appropriate\n- Keep responses brief and clear',
    );

    return sections.join('\n');
  }

  /**
   * Groups states by their purpose for better prompt organization
   */
  private static groupStates(states: Record<string, any>): Record<string, any[]> {
    const groups: Record<string, any[]> = {
      GREETING: [],
      BOOKING: [],
      RESCHEDULING: [],
      CANCELLATION: [],
      INFORMATION: [],
      TRANSFER: [],
      CLOSING: [],
    };

    Object.entries(states).forEach(([key, state]) => {
      if (key.includes('GREETING') || key === 'S0_GREETING') {
        groups.GREETING.push(state);
      } else if (
        key.includes('BOOK') ||
        key.startsWith('S1') ||
        key.startsWith('S2') ||
        key.startsWith('S3')
      ) {
        groups.BOOKING.push(state);
      } else if (
        key.includes('RESCHEDULE') ||
        key.startsWith('S4') ||
        key.startsWith('S5') ||
        key.startsWith('S6')
      ) {
        groups.RESCHEDULING.push(state);
      } else if (key.includes('CANCEL') || key.startsWith('S7') || key.startsWith('S8')) {
        groups.CANCELLATION.push(state);
      } else if (
        key.includes('HOURS') ||
        key.includes('LOCATION') ||
        key.includes('SERVICES') ||
        key === 'S9_HOURS_LOCATION' ||
        key === 'S10_SERVICES_PRICING'
      ) {
        groups.INFORMATION.push(state);
      } else if (key.includes('TRANSFER') || key === 'S11_TRANSFER_HUMAN') {
        groups.TRANSFER.push(state);
      } else if (
        key.includes('CLOSING') ||
        key.includes('END') ||
        key === 'S13_CLOSING' ||
        key === 'S_END'
      ) {
        groups.CLOSING.push(state);
      }
    });

    // Remove empty groups
    Object.keys(groups).forEach(key => {
      if (groups[key].length === 0) {
        delete groups[key];
      }
    });

    return groups;
  }

  /**
   * Converts action names to human-readable descriptions
   */
  private static actionToDescription(action: string): string {
    const actionMap: Record<string, string> = {
      check_calendar_availability: 'Check if requested time is available',
      create_calendar_event: 'Create the appointment',
      reschedule_calendar_event: 'Reschedule the existing appointment',
      cancel_calendar_event: 'Cancel the appointment',
      transfer_to_human: 'Transfer call to human agent',
    };

    return actionMap[action] || action;
  }

  /**
   * Capitalizes first letter
   */
  private static capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
  }

  /**
   * Checks if string is valid JSON
   */
  static isJsonString(str: string): boolean {
    if (typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;

    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Auto-converts script if it's JSON, otherwise returns as-is
   */
  static autoConvert(script: string): string {
    if (this.isJsonString(script)) {
      try {
        const config = JSON.parse(script);
        const converted = this.convertToNaturalLanguage(config);
        console.log('📝 Converted JSON prompt to natural language');
        return converted;
      } catch (error) {
        console.warn('⚠️ Failed to convert JSON prompt, using as-is');
        return script;
      }
    }
    return script;
  }
}
