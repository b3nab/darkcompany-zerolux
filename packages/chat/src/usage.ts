/** A number shortened to `digits` decimals, without trailing zeros. */
const short = (value: number, digits: number) =>
  String(Number(value.toFixed(digits)));

/** A token count as people read it: 950, 1.5k, 42k, 1.2M. */
export function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500)
    return `${short(tokens / 1000, tokens < 9_950 ? 1 : 0)}k`;
  return `${short(tokens / 1_000_000, 1)}M`;
}

/** A cost in dollars: $0.42, $12.30; under half a cent, <$0.01. */
export const usdCost = (usd: number) =>
  usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`;

/** A share as a whole percentage: 0.214 is 21%. */
export const percent = (share: number) => `${Math.round(share * 100)}%`;
