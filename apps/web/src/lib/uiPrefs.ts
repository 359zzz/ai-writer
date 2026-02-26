import type { Lang } from "@/lib/i18n";

export type UiTheme = {
  id: string;
  name: string;
  /**
   * Primary UI accent used for active tabs and primary actions.
   * Format: "#RRGGBB"
   */
  accent: string;
  /**
   * Foreground text color on top of accent.
   * Format: "#RRGGBB"
   */
  accent_foreground: string;
};

export type UiPrefs = {
  version: 1;
  lang: Lang;
  theme_id: string;
  themes: UiTheme[];
};

export const UI_PREFS_STORAGE_KEY = "ai-writer.ui_prefs.v1";

export const DEFAULT_THEMES: UiTheme[] = [
  {
    id: "dawn",
    name: "破晓",
    accent: "#F97316",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "moon",
    name: "辉月",
    accent: "#6366F1",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "ice",
    name: "冰痕",
    accent: "#06B6D4",
    accent_foreground: "#0B1020",
  },
];

export const DEFAULT_UI_PREFS: UiPrefs = {
  version: 1,
  lang: "zh",
  theme_id: DEFAULT_THEMES[0]?.id ?? "dawn",
  themes: DEFAULT_THEMES,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en";
}

export function normalizeHexColor(input: string): string | null {
  const raw = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1] ?? "0";
    const g = raw[2] ?? "0";
    const b = raw[3] ?? "0";
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

function coerceTheme(raw: unknown): UiTheme | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
  const accent =
    typeof raw.accent === "string" ? normalizeHexColor(raw.accent) : null;
  const accentFg =
    typeof raw.accent_foreground === "string"
      ? normalizeHexColor(raw.accent_foreground)
      : null;

  if (!id || !name || !accent || !accentFg) return null;
  return { id, name, accent, accent_foreground: accentFg };
}

export function coerceUiPrefs(raw: unknown): UiPrefs {
  if (!isRecord(raw)) return DEFAULT_UI_PREFS;
  if (raw.version !== 1) return DEFAULT_UI_PREFS;

  const lang = isLang(raw.lang) ? raw.lang : DEFAULT_UI_PREFS.lang;
  const themesRaw = Array.isArray(raw.themes) ? raw.themes : [];
  const themes = themesRaw.map(coerceTheme).filter(Boolean) as UiTheme[];
  const finalThemes = themes.length > 0 ? themes : DEFAULT_THEMES;

  const themeId =
    typeof raw.theme_id === "string" ? raw.theme_id : DEFAULT_UI_PREFS.theme_id;
  const resolvedThemeId =
    finalThemes.some((t) => t.id === themeId) ? themeId : finalThemes[0]!.id;

  return { version: 1, lang, theme_id: resolvedThemeId, themes: finalThemes };
}

export function loadUiPrefs(): UiPrefs {
  if (typeof window === "undefined") return DEFAULT_UI_PREFS;
  try {
    const raw = window.localStorage.getItem(UI_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_UI_PREFS;
    return coerceUiPrefs(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

export function saveUiPrefs(prefs: UiPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore persistence errors (e.g., private mode or storage quota).
  }
}

export function resolveActiveTheme(prefs: UiPrefs): UiTheme {
  return prefs.themes.find((t) => t.id === prefs.theme_id) ?? prefs.themes[0]!;
}

export function applyUiTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--ui-accent", theme.accent);
  document.documentElement.style.setProperty(
    "--ui-accent-foreground",
    theme.accent_foreground,
  );
}

