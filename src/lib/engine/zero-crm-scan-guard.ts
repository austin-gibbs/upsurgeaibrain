// Guard against stripping local enroll tags when CRM unexpectedly returns zero contacts.
export const ZERO_CRM_SCAN_GUARD_THRESHOLD = 10;

export function shouldGuardZeroCrmScan(
  crmContactCount: number,
  localEnrolledCount: number,
  threshold: number = ZERO_CRM_SCAN_GUARD_THRESHOLD
): boolean {
  return crmContactCount === 0 && localEnrolledCount >= threshold;
}
