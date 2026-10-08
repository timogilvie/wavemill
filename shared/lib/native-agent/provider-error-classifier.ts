export type ProviderErrorKind =
  | 'provider-transient-error'
  | 'provider-credit-exhausted'
  | 'provider-config-error'
  | 'context-window-exceeded'
  | 'provider-response-incomplete'
  | 'provider-unknown-error';

export interface ProviderErrorClassification {
  kind: ProviderErrorKind;
  retryable: boolean;
}

export function classifyProviderError(errorMessage: string): ProviderErrorClassification {
  const detail = errorMessage.toLowerCase();

  if (
    /context[_ -]?length|context window|maximum context length|reduce the length|prompt.*too long|input.*too long/.test(detail)
  ) {
    return terminal('context-window-exceeded');
  }

  if (
    /(?:^|\D)402(?:\D|$)|payment required|can only afford|requires more credits|insufficient.*credits?|openrouter-credits-exhausted/.test(detail)
  ) {
    return terminal('provider-credit-exhausted');
  }

  if (
    /(?:^|\D)401(?:\D|$)|unauthori[sz]ed|invalid api key|authentication|permission denied|forbidden/.test(detail)
    || /is not a valid model id|invalid model|unknown model|model_not_found|invalid model id/.test(detail)
    || /invalid.*(?:parameter|param|request)|unsupported parameter|bad request.*(?:parameter|param)/.test(detail)
    || /(?:^|\D)404(?:\D|$).*endpoint|no endpoints found|tool use.*not supported|support tool use/.test(detail)
  ) {
    return terminal('provider-config-error');
  }

  if (/response incomplete:\s*\S/.test(detail)) {
    return terminal('provider-response-incomplete');
  }

  if (
    /finish_reason["' ]*:?["' ]*error|finish reason["' ]*:?["' ]*error|provider finish_reason: error/.test(detail)
    || /idle timeout|timed out waiting|upstream.*timeout|gateway timeout|timeout.*upstream/.test(detail)
    || /stream ended without|without finish_reason|truncated stream|connection.*(?:reset|closed)|socket hang up/.test(detail)
    || /(?:^|\D)(?:429|5\d\d)(?:\D|$)|rate limit|too many requests|server error|bad gateway|service unavailable|overloaded|upstream/.test(detail)
  ) {
    return { kind: 'provider-transient-error', retryable: true };
  }

  return { kind: 'provider-unknown-error', retryable: true };
}

function terminal(kind: ProviderErrorKind): ProviderErrorClassification {
  return { kind, retryable: false };
}
