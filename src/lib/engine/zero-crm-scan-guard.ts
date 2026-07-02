// Guard against stripping local enroll tags when CRM scan looks broken or incomplete.
export const ZERO_CRM_SCAN_GUARD_THRESHOLD = 10;
/** CRM count below this fraction of local enrolled contacts is treated as suspicious. */
export const LOW_CRM_SCAN_RATIO = 0.25;

export function shouldGuardZeroCrmScan(
  crmContactCount: number,
  localEnrolledCount: number,
  threshold: number = ZERO_CRM_SCAN_GUARD_THRESHOLD
): boolean {
  return crmContactCount === 0 && localEnrolledCount >= threshold;
}

export function shouldGuardSuspiciousLowCrmScan(
  crmContactCount: number,
  localEnrolledCount: number,
  threshold: number = ZERO_CRM_SCAN_GUARD_THRESHOLD,
  minRatio: number = LOW_CRM_SCAN_RATIO
): boolean {
  if (localEnrolledCount < threshold || crmContactCount === 0) return false;
  return crmContactCount < localEnrolledCount * minRatio;
}

export function shouldGuardCrmScan(
  crmContactCount: number,
  localEnrolledCount: number,
  threshold: number = ZERO_CRM_SCAN_GUARD_THRESHOLD,
  minRatio: number = LOW_CRM_SCAN_RATIO
): boolean {
  return (
    shouldGuardZeroCrmScan(crmContactCount, localEnrolledCount, threshold) ||
    shouldGuardSuspiciousLowCrmScan(
      crmContactCount,
      localEnrolledCount,
      threshold,
      minRatio
    )
  );
}
