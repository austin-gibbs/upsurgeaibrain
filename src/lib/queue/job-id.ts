// BullMQ 5+ rejects custom job ids that contain `:`.
// Keep every queue jobId colon-free so scheduler + dial enqueue never fail.

/** Replace `:` so BullMQ accepts the id. Idempotent. */
export function sanitizeBullmqJobId(id: string): string {
  return id.replace(/:/g, "-");
}
