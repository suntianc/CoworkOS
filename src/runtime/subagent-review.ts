/**
 * The Reviewer's conclusion, in the one shape Main can act on.
 *
 * A delegated Reviewer does not submit prose Main has to interpret: it calls
 * `submit_review`, the process records the conclusion, and the backend refuses
 * to project a Reviewer result that carries no valid conclusion. The same
 * validator runs in the extension (so a malformed submission is an error the
 * model can retry) and in the backend (so a completed record is re-checked
 * before it becomes Main's callback).
 */

export type ReviewVerdict = "pass" | "changes_requested";

export interface ReviewFinding {
  /** Where the finding is: a file path, a path:line, or a named area. */
  location: string;
  /** What was actually observed, and what supports it. */
  evidence: string;
  /** Whether this finding blocks acceptance. */
  blocking: boolean;
}

export interface ReviewConclusion {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["pass", "changes_requested"];
export const MAX_REVIEW_FINDINGS = 100;

export type ReviewValidation = { ok: true; review: ReviewConclusion } | { ok: false; errors: string[] };

/** Validate one submission or one stored record; every error names the field. */
export function parseReviewConclusion(value: unknown): ReviewValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, errors: ["conclusion must be an object with verdict and findings"] };
  const input = value as { verdict?: unknown; findings?: unknown };
  const verdict = input.verdict;
  if (verdict !== "pass" && verdict !== "changes_requested")
    errors.push('verdict must be "pass" or "changes_requested"');
  const rawFindings = input.findings;
  if (!Array.isArray(rawFindings)) {
    errors.push("findings must be an array");
    return { ok: false, errors };
  }
  if (rawFindings.length > MAX_REVIEW_FINDINGS)
    errors.push(`findings must contain at most ${MAX_REVIEW_FINDINGS} entries`);
  const findings: ReviewFinding[] = [];
  rawFindings.forEach((entry, index) => {
    const label = `findings[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object with location, evidence and blocking`);
      return;
    }
    const finding = entry as { location?: unknown; evidence?: unknown; blocking?: unknown };
    const location = typeof finding.location === "string" ? finding.location.trim() : "";
    const evidence = typeof finding.evidence === "string" ? finding.evidence.trim() : "";
    if (!location) errors.push(`${label}.location must be a non-empty string`);
    if (!evidence) errors.push(`${label}.evidence must be a non-empty string`);
    if (typeof finding.blocking !== "boolean") errors.push(`${label}.blocking must be true or false`);
    if (!location || !evidence || typeof finding.blocking !== "boolean") return;
    findings.push({ location, evidence, blocking: finding.blocking });
  });
  if (verdict === "changes_requested" && findings.length === 0)
    errors.push("changes_requested requires at least one finding");
  if (verdict === "pass" && findings.some((finding) => finding.blocking))
    errors.push("pass cannot carry a blocking finding");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, review: { verdict: verdict as ReviewVerdict, findings } };
}
