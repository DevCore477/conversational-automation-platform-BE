/** Keys inside `{{ ... }}` — letters, digits, underscore, hyphen, dot. */
const PLACEHOLDER_KEY_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;

export function extractPlaceholderKeys(template: string): string[] {
  const keys = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_REGEX)) {
    const key = match[1].trim();
    if (key && PLACEHOLDER_KEY_PATTERN.test(key)) {
      keys.add(key);
    }
  }
  return [...keys];
}

export function lookupVariable(
  variables: Record<string, string>,
  key: string,
): string | undefined {
  if (variables[key] !== undefined) {
    return variables[key];
  }
  const lower = key.toLowerCase();
  const match = Object.keys(variables).find(k => k.toLowerCase() === lower);
  return match ? variables[match] : undefined;
}

/**
 * Replace `{{variable}}` placeholders using row variables.
 * Runs multiple passes so `{{message}}` → `Hello {{name}}` → `Hello Ali` works.
 */
export function renderPlaceholders(
  template: string,
  variables: Record<string, string> | undefined,
  maxPasses = 10,
): string {
  if (!variables || Object.keys(variables).length === 0) {
    return template;
  }

  let result = template;
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = result.replace(PLACEHOLDER_REGEX, (_, rawKey: string) => {
      const key = rawKey.trim();
      if (!key || !PLACEHOLDER_KEY_PATTERN.test(key)) {
        return `{{${rawKey}}}`;
      }
      const value = lookupVariable(variables, key);
      return value !== undefined ? value : `{{${key}}}`;
    });
    if (next === result) {
      break;
    }
    result = next;
  }
  return result;
}

export function findMissingPlaceholderKeys(
  template: string,
  variables: Record<string, string> | undefined,
): string[] {
  const resolved = renderPlaceholders(template, variables);
  return extractPlaceholderKeys(resolved);
}
