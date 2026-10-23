import { memo, useCallback, useEffect, useState } from "react";
import { clipflow } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration, formatRelativeTime } from "../lib/format";
import { cacheThumbnail, getCachedThumbnail } from "../lib/thumbCache";
import { cn } from "../utils/cn";
import { gapFor, useVirtualGrid } from "../hooks/useVirtualGrid";

/** Gallery thumbnails are decoded lazily per visible card and cached in `thumbCache`. */

interface Props {
  clips: ClipMetadata[];
  loading?: boolean;
  compact?: boolean;
  /** Total count of all clips in the library (before filtering) */
  totalClipsCount?: number;
  onResetFilters?: () => void;
  /** Paths currently selected (multi-select), as a Set for O(1) lookups. */
  selectedPaths?: ReadonlySet<string>;
  /** When on, a plain card click selects instead of opening the trimmer. */
  selectMode?: boolean;
  onOpen: (clip: ClipMetadata) => void;
  onSelect: (clip: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (clip: ClipMetadata) => void;
  onReveal: (clip: ClipMetadata) => void;
  onOpenExternal: (clip: ClipMetadata) => void;
  onDelete: (clip: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
}

function IconButton({
  title,
  onClick,
  danger,
  highlight,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md border text-[11px] backdrop-blur-sm transition-colors duration-150",
        danger
          ? "border-red-500/40 bg-[#f1f3f5]/95 text-red-600 hover:border-red-400 hover:bg-red-500/25"
          : highlight
            ? "border-amber-400/50 bg-[#f1f3f5]/95 text-amber-700 hover:border-amber-400 hover:bg-amber-400/25"
            : "border-[#bcc5cf] bg-[#f1f3f5]/95 text-[#475569] hover:border-[#2563eb]/70 hover:bg-[#eceff2] hover:text-slate-900",
      )}
    >
      {children}
    </button>
  );
}

const ClipCard = memo(function ClipCard({
  clip,
  compact,
  selected,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: {
  clip: ClipMetadata;
  compact?: boolean;
  selected: boolean;
  selectMode: boolean;
  onOpen: (c: ClipMetadata) => void;
  onSelect: (c: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (c: ClipMetadata) => void;
  onReveal: (c: ClipMetadata) => void;
  onOpenExternal: (c: ClipMetadata) => void;
  onDelete: (c: ClipMetadata) => void;
  onToggleFavorite: (c: ClipMetadata) => void;
}) {
  const [thumb, setThumb] = useState(clip.thumbnail);

  useEffect(() => {
    if (clip.thumbnail) {
      setThumb(clip.thumbnail);
      return;
    }
    let alive = true;
    let requested = false;
    const load = () => {
      if (!alive || requested || document.visibilityState !== "visible") return;
      const cached = getCachedThumbnail(clip.path);
      if (cached) {
        setThumb(cached);
        requested = true;
        return;
      }
      requested = true;
      void clipflow
        .getClipThumbnail(clip.path, 1)
        .then((t) => {
          if (!alive || !t) return;
          cacheThumbnail(clip.path, t);
          setThumb(t);
        })
        .catch(() => {
          // Allow a retry the next time the deck becomes visible.
          requested = false;
        });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [clip.path, clip.thumbnail]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (selectMode || mods.ctrl || mods.shift) {
        onSelect(clip, mods);
      } else {
        onOpen(clip);
      }
    },
    [clip, onOpen, onSelect, selectMode],
  );

  return (
    <article
      className={cn(
        "panel panel-hover group relative cursor-pointer overflow-hidden rounded-xl transition-all duration-150",
        selected
          ? "border-[#2563eb] ring-2 ring-[#2563eb]/40 bg-[#e4ebf7]"
          : "hover:border-[#a9b6c7]",
      )}
      onClick={handleClick}
    >
      {/* Thumbnail Viewport */}
      <div className="relative aspect-video w-full overflow-hidden bg-surface-elevated">
        {thumb ? (
          <img
            src={thumb}
            alt={clip.title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-surface-elevated">
            <span className="font-mono text-[10px] text-text-muted">THUMBNAIL…</span>
          </div>
        )}

        {/* Play affordance — decoding starts only in the trimmer, never on hover */}
        <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur-sm">
            <svg viewBox="0 0 16 16" className="ml-0.5 h-4 w-4 fill-current">
              <path d="M4 2.8v10.4L13 8 4 2.8z" />
            </svg>
          </span>
        </span>

        {/* Readability scrim */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />

        {/* Game badge */}
        {clip.game && (
          <span className="absolute left-2.5 top-2.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-white border border-white/10">
            {clip.game.toUpperCase()}
          </span>
        )}

        {/* Duration badge */}
        <span className="absolute bottom-2 left-2.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white border border-white/10">
          {formatDuration(clip.duration_seconds)}
        </span>

        {/* Audio availability badge */}
        {clip.has_audio && (
          <span
            className="absolute bottom-2 left-16 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white border border-white/10 flex items-center gap-1"
            title="Recorded with game audio"
          >
            <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 fill-current">
              <path d="M11.536 14.01A8.473 8.473 0 0 0 14.026 8a8.47 8.47 0 0 0-2.49-6.01l-.708.707A7.476 7.476 0 0 1 13.025 8c0 2.071-.84 3.946-2.197 5.303l.708.707z" />
              <path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06z" />
            </svg>
            Audio
          </span>
        )}

        {/* Format / resolution badge */}
        <span className="absolute bottom-2 right-2.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white border border-white/10">
          {clip.height}p{clip.fps}
        </span>

        {/* Favorite indicator */}
        {clip.favorite && (
          <span
            className="absolute left-2.5 top-8 rounded bg-amber-500/95 px-1.5 py-0.5 font-mono text-[9px] font-bold text-black"
            title="Favorited clip"
          >
            ★
          </span>
        )}

        {/* Action button overlay */}
        <div
          className={cn(
            "absolute right-2 top-2 flex items-center gap-1 transition-opacity duration-150",
            selectMode ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {(selectMode || selected) && (
            <IconButton
              title={selected ? "Deselect clip" : "Select clip"}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(clip, { ctrl: true, shift: false });
              }}
            >
              <span className="font-mono text-[12px]">{selected ? "✓" : "☐"}</span>
            </IconButton>
          )}

          <IconButton
            title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
            highlight={clip.favorite}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(clip);
            }}
          >
            <span>{clip.favorite ? "★" : "☆"}</span>
          </IconButton>

          <IconButton
            title="Open in external player"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExternal(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current">
              <path d="M4 3.5v9l8-4.5-8-4.5z" />
            </svg>
          </IconButton>

          <IconButton
            title="Copy video file to clipboard"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 11V3a1 1 0 0 1 1-1h8" />
            </svg>
          </IconButton>

          <IconButton
            title="Reveal in Explorer"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </IconButton>

          <IconButton
            title="Delete clip"
            danger
            onClick={(e) => {
              e.stopPropagation();
              onDelete(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <path d="M3 4h10M6 4V2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V4M5 4v9a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 11 13V4" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Card Content Footer */}
      <div className={compact ? "px-2.5 py-2" : "px-3 py-2.5"}>
        <div className="h-5 truncate text-[13px] font-medium text-[#0f172a]">{clip.title}</div>
        <div className="mt-1 flex h-4 items-center gap-1 overflow-hidden">
          {clip.tags.length > 0 && (
            <>
              {clip.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="shrink-0 rounded border border-[#d3d9e0] bg-[#eceff2] px-1.5 py-px font-mono text-[9px] text-[#475569]"
                >
                  #{t}
                </span>
              ))}
              {clip.tags.length > 3 && (
                <span className="shrink-0 font-mono text-[9px] text-[#475569]">
                  +{clip.tags.length - 3}
                </span>
              )}
            </>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-[#475569]">
          <span>{formatRelativeTime(clip.created_unix_ms)}</span>
          <span>{formatBytes(clip.size_bytes)}</span>
        </div>
      </div>
    </article>
  );
});

const GalleryGrid = memo(function GalleryGrid({
  clips,
  loading,
  compact,
  totalClipsCount,
  onResetFilters,
  selectedPaths,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: Props) {
  const gap = gapFor(!!compact);
  const { cols, rowPitch, totalHeight, startRow, endRow, containerRef, rowRef } =
    useVirtualGrid({ itemCount: clips.length, compact: !!compact });

  const gridClass = compact
    ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

  let content: React.ReactNode;
  if (loading) {
    content = (
      <div className={gridClass}>
        {Array.from({ length: compact ? 8 : 6 }).map((_, i) => (
          <div key={i} className="panel h-[190px] animate-pulse rounded-xl bg-[#eceff2]" />
        ))}
      </div>
    );
  } else if (clips.length === 0) {
    if (totalClipsCount && totalClipsCount > 0) {
      content = (
        <div className="panel flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#d3d9e0] bg-[#eceff2] text-[#475569]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </div>
          <div className="text-[14px] font-semibold text-[#0f172a]">
            No clips match your search
          </div>
          <p className="max-w-sm text-[12px] leading-relaxed text-[#475569]">
            No recorded clips match the current search query or game filters.
          </p>
          {onResetFilters && (
            <button
              type="button"
              onClick={onResetFilters}
              className="mt-1 rounded-lg border border-[#2563eb]/40 bg-[#2563eb]/10 px-3.5 py-1.5 text-[12px] font-medium text-[#2563eb] hover:bg-[#2563eb]/20 transition-colors"
            >
              Clear Search & Filters
            </button>
          )}
        </div>
      );
    } else {
      content = (
        <div className="panel flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#d3d9e0] bg-[#eceff2] text-[#475569]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.5">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M7 4v16M17 4v16M2 12h20M2 8h5M2 16h5M17 8h5M17 16h5" />
            </svg>
          </div>
          <div className="text-[14px] font-semibold text-[#0f172a]">
            No clips recorded yet
          </div>
          <p className="max-w-sm text-[12px] leading-relaxed text-[#475569]">
            The rolling buffer is active in memory. Press{" "}
            <kbd className="rounded border border-[#bcc5cf] bg-[#eceff2] px-1.5 py-0.5 font-mono text-[11px] text-[#0f172a]">
              Alt + C
            </kbd>{" "}
            at any time while playing to save the last replay moments instantly.
          </p>
        </div>
      );
    }
  } else {
    const rows: React.ReactNode[] = [];
    for (let r = startRow; r < endRow; r++) {
      const from = r * cols;
      rows.push(
        <div
          key={r}
          ref={r === startRow ? rowRef : undefined}
          className="absolute left-0 right-0 grid"
          style={{
            top: r * rowPitch,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {clips.slice(from, from + cols).map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              compact={compact}
              selected={selectedPaths?.has(clip.path) ?? false}
              selectMode={!!selectMode}
              onOpen={onOpen}
              onSelect={onSelect}
              onCopy={onCopy}
              onReveal={onReveal}
              onOpenExternal={onOpenExternal}
              onDelete={onDelete}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>,
      );
    }
    content = rows;
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight || undefined }}>
      {content}
    </div>
  );
});

export default GalleryGrid;
