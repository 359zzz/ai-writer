import type { Lang } from "@/lib/i18n";

export type UiTheme = {
  id: string;
  name: string;
  /**
   * App background color token.
   * Format: "#RRGGBB"
   */
  bg: string;
  /**
   * Panel/surface color token.
   * Format: "#RRGGBB"
   */
  surface: string;
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

export type UiBackgroundPrefs = {
  enabled: boolean;
  image_data_url: string | null;
  opacity: number; // 0..1
  blur_px: number; // 0..50
};

export type UiBrandPrefs = {
  logo_data_url: string | null;
};

export type UiPrefs = {
  version: 2;
  lang: Lang;
  theme_id: string;
  themes: UiTheme[];
  background: UiBackgroundPrefs;
  brand: UiBrandPrefs;
};

export const UI_PREFS_STORAGE_KEY_V1 = "ai-writer.ui_prefs.v1";
export const UI_PREFS_STORAGE_KEY = "ai-writer.ui_prefs.v2";

export const DEFAULT_THEMES: UiTheme[] = [
  {
    id: "dawn",
    name: "破晓",
    bg: "#FFFFFF",
    surface: "#FFF4CC",
    accent: "#EF4444",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "moon",
    name: "辉月",
    bg: "#F3F4FF",
    surface: "#E0E7FF",
    accent: "#6366F1",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "ice",
    name: "冰痕",
    bg: "#F0FDFF",
    surface: "#CCFBF1",
    accent: "#06B6D4",
    accent_foreground: "#0B1020",
  },
];

export const DEFAULT_UI_PREFS: UiPrefs = {
  version: 2,
  lang: "zh",
  theme_id: DEFAULT_THEMES[0]?.id ?? "dawn",
  themes: DEFAULT_THEMES,
  background: {
    enabled: false,
    image_data_url: null,
    opacity: 0.22,
    blur_px: 14,
  },
  brand: {
    logo_data_url: null,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en";
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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

type UiThemeV1 = {
  id: string;
  name: string;
  accent: string;
  accent_foreground: string;
};

function coerceThemeV1(raw: unknown): UiThemeV1 | null {
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

function coerceThemeV2(raw: unknown): UiTheme | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
  const bg = typeof raw.bg === "string" ? normalizeHexColor(raw.bg) : null;
  const surface =
    typeof raw.surface === "string" ? normalizeHexColor(raw.surface) : null;
  const accent =
    typeof raw.accent === "string" ? normalizeHexColor(raw.accent) : null;
  const accentFg =
    typeof raw.accent_foreground === "string"
      ? normalizeHexColor(raw.accent_foreground)
      : null;

  if (!id || !name || !bg || !surface || !accent || !accentFg) return null;
  return { id, name, bg, surface, accent, accent_foreground: accentFg };
}

function coerceBackground(raw: unknown): UiBackgroundPrefs {
  if (!isRecord(raw)) return DEFAULT_UI_PREFS.background;
  const enabled = Boolean(raw.enabled);
  const image =
    typeof raw.image_data_url === "string" && raw.image_data_url.trim()
      ? raw.image_data_url
      : null;
  const opacity = clampNumber(Number(raw.opacity), 0, 1);
  const blurPx = clampNumber(Number(raw.blur_px), 0, 50);
  return { enabled, image_data_url: image, opacity, blur_px: blurPx };
}

function coerceBrand(raw: unknown): UiBrandPrefs {
  if (!isRecord(raw)) return DEFAULT_UI_PREFS.brand;
  const logo =
    typeof raw.logo_data_url === "string" && raw.logo_data_url.trim()
      ? raw.logo_data_url
      : null;
  return { logo_data_url: logo };
}

export function coerceUiPrefs(raw: unknown): UiPrefs {
  if (!isRecord(raw)) return DEFAULT_UI_PREFS;

  // v2 (current)
  if (raw.version === 2) {
    const lang = isLang(raw.lang) ? raw.lang : DEFAULT_UI_PREFS.lang;
    const themesRaw = Array.isArray(raw.themes) ? raw.themes : [];
    const themes = themesRaw.map(coerceThemeV2).filter(Boolean) as UiTheme[];
    const finalThemes = themes.length > 0 ? themes : DEFAULT_THEMES;

    const themeId =
      typeof raw.theme_id === "string"
        ? raw.theme_id
        : DEFAULT_UI_PREFS.theme_id;
    const resolvedThemeId =
      finalThemes.some((t) => t.id === themeId) ? themeId : finalThemes[0]!.id;

    const background = coerceBackground(raw.background);
    const brand = coerceBrand(raw.brand);

    return {
      version: 2,
      lang,
      theme_id: resolvedThemeId,
      themes: finalThemes,
      background,
      brand,
    };
  }

  // v1 (migrate)
  if (raw.version === 1) {
    const lang = isLang(raw.lang) ? raw.lang : DEFAULT_UI_PREFS.lang;
    const themesRaw = Array.isArray(raw.themes) ? raw.themes : [];
    const themesV1 = themesRaw.map(coerceThemeV1).filter(Boolean) as UiThemeV1[];
    const finalThemes: UiTheme[] =
      themesV1.length > 0
        ? themesV1.map((t) => ({
            id: t.id,
            name: t.name,
            bg: "#FFFFFF",
            surface: "#FFFFFF",
            accent: t.accent,
            accent_foreground: t.accent_foreground,
          }))
        : DEFAULT_THEMES;

    const themeId =
      typeof raw.theme_id === "string"
        ? raw.theme_id
        : DEFAULT_UI_PREFS.theme_id;
    const resolvedThemeId =
      finalThemes.some((t) => t.id === themeId) ? themeId : finalThemes[0]!.id;

    return {
      ...DEFAULT_UI_PREFS,
      lang,
      theme_id: resolvedThemeId,
      themes: finalThemes,
    };
  }

  return DEFAULT_UI_PREFS;
}

export function loadUiPrefs(): UiPrefs {
  if (typeof window === "undefined") return DEFAULT_UI_PREFS;
  try {
    const rawV2 = window.localStorage.getItem(UI_PREFS_STORAGE_KEY);
    if (rawV2) return coerceUiPrefs(JSON.parse(rawV2) as unknown);

    // Migrate from v1 key when present.
    const rawV1 = window.localStorage.getItem(UI_PREFS_STORAGE_KEY_V1);
    if (!rawV1) return DEFAULT_UI_PREFS;
    const prefs = coerceUiPrefs(JSON.parse(rawV1) as unknown);
    try {
      window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore
    }
    return prefs;
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
  document.documentElement.style.setProperty("--ui-bg", theme.bg);
  document.documentElement.style.setProperty("--ui-surface", theme.surface);
  document.documentElement.style.setProperty("--ui-accent", theme.accent);
  document.documentElement.style.setProperty(
    "--ui-accent-foreground",
    theme.accent_foreground,
  );
}
