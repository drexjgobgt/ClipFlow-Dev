/**
 * Frontend mirror of the Rust `is_integrated_gpu` heuristic, used when the
 * engine is idle (before a start) so Settings can still explain the 720p/30
 * cap on a laptop iGPU. The engine's own detection stays authoritative while
 * it is running.
 */
export function isIntegratedAdapter(adapter: string | undefined | null): boolean {
  const n = (adapter ?? "").toLowerCase();
  if (n.length === 0) return false;
  // Intel Arc is a discrete GPU; do not downclock it.
  if (n.includes("arc")) return false;
  return (
    n.includes("intel") ||
    n.includes("iris") ||
    n.includes("uhd graphics") ||
    n.includes("hd graphics") ||
    (n.includes("radeon") && n.includes("graphics"))
  );
}
