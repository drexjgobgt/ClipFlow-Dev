import { useMemo } from "react";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";

interface Props {
  clips: ClipMetadata[];
}

function StatBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] px-3.5 py-3">
      <div className="text-[11px] font-semibold tracking-wide text-[#475569]">{label}</div>
      <div className="mt-1 font-mono text-[18px] font-semibold text-[#0f172a]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#475569]">{sub}</div>}
    </div>
  );
}

export default function StatsPanel({ clips }: Props) {
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;

  const stats = useMemo(() => {
    const totalBytes = clips.reduce((a, c) => a + c.size_bytes, 0);
    const totalSeconds = clips.reduce((a, c) => a + c.duration_seconds, 0);
    const thisWeek = clips.filter((c) => c.created_unix_ms >= weekAgo);
    const thisWeekBytes = thisWeek.reduce((a, c) => a + c.size_bytes, 0);

    const byGame = new Map<string, { clips: number; bytes: number }>();
    for (const c of clips) {
      const key = c.game ?? "General";
      const e = byGame.get(key) ?? { clips: 0, bytes: 0 };
      e.clips += 1;
      e.bytes += c.size_bytes;
      byGame.set(key, e);
    }
    const rows = [...byGame.entries()]
      .map(([game, v]) => ({ game, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
    const maxBytes = Math.max(...rows.map((r) => r.bytes), 1);

    return { totalBytes, totalSeconds, thisWeek: thisWeek.length, thisWeekBytes, rows, maxBytes };
  }, [clips, weekAgo]);

  return (
    <section className="panel rounded-xl p-5 space-y-4">
      <div className="border-b border-[#d3d9e0] pb-3">
        <h3 className="text-[13px] font-semibold text-[#0f172a]">
          Library Statistics
        </h3>
        <p className="text-[11px] text-[#475569] mt-0.5">
          Overview of recorded gameplay storage and tagged games
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatBox
          label="Total Saved Clips"
          value={String(clips.length)}
          sub={formatDuration(stats.totalSeconds)}
        />
        <StatBox
          label="Disk Storage Used"
          value={formatBytes(stats.totalBytes)}
          sub="output directory"
        />
        <StatBox
          label="Recorded This Week"
          value={String(stats.thisWeek)}
          sub={formatBytes(stats.thisWeekBytes)}
        />
        <StatBox
          label="Games Tagged"
          value={String(stats.rows.filter((r) => r.game !== "General").length)}
          sub="per-game folders"
        />
      </div>

      <div className="border-t border-[#d3d9e0] pt-4">
        <div className="text-[11px] font-semibold tracking-wide text-[#475569]">
          Storage Usage by Game
        </div>
        {stats.rows.length === 0 ? (
          <p className="mt-2 text-[12px] text-[#475569]">
            No clips recorded yet. Storage breakdown appears after saving your first clip.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {stats.rows.map((r) => (
              <li key={r.game}>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="truncate font-medium text-[#0f172a]">
                    {r.game}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-[#475569]">
                    {r.clips} {r.clips === 1 ? "clip" : "clips"} · {formatBytes(r.bytes)}
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#e9ecef]">
                  <div
                    className="h-full rounded-full bg-[#2563eb]"
                    style={{ width: `${(r.bytes / stats.maxBytes) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="border-t border-[#d3d9e0] pt-3 text-[11px] leading-relaxed text-[#475569]">
        Clips saved with game organization active are automatically sorted into Videos\ClipFlow\&lt;game&gt;\ subfolders.
      </p>
    </section>
  );
}
