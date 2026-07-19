// Bootstrap placeholder (ISS-001) so the typecheck gate has a strict-mode input.
// Replaced by the real workspace packages in ISS-002.
export const REPO_NAME: string = 'poslatr';

export function issueBranch(issueNumber: number, slug: string): string {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new RangeError(`issueNumber must be a positive integer, got ${issueNumber}`);
  }
  return `feat/ISS-${String(issueNumber).padStart(3, '0')}-${slug}`;
}
