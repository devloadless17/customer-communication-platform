import {
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Film,
  Music,
  type LucideIcon,
} from "lucide-react";

/**
 * Pick a document glyph from a filename extension (and optional media kind), so
 * a doc-heavy thread / the Files tab is scannable by type instead of showing the
 * same generic FileText for everything. Falls back to FileText for unknowns.
 */
export function fileIconForName(
  name: string | null | undefined,
  mediaKind?: string,
): LucideIcon {
  const ext = (name?.split(".").pop() ?? "").toLowerCase();
  if (mediaKind === "audio" || ["mp3", "wav", "ogg", "m4a", "aac", "opus"].includes(ext)) {
    return Music;
  }
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return FileArchive;
  if (["xls", "xlsx", "csv", "numbers", "tsv"].includes(ext)) return FileSpreadsheet;
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return Film;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp"].includes(ext)) {
    return FileImage;
  }
  return FileText;
}
