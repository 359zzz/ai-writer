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
   * Primary foreground text color used across the app.
   * Format: "#RRGGBB"
   */
  text: string;
  /**
   * Secondary/muted text color used for labels/hints.
   * Format: "#RRGGBB"
   */
  muted: string;
  /**
   * Control background color (inputs/selects/textareas/buttons).
   * Format: "#RRGGBB"
   */
  control: string;
  /**
   * Foreground text color inside controls.
   * Format: "#RRGGBB"
   */
  control_text: string;
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
    // Revert to the original v1.x palette (accent-driven, neutral background).
    bg: "#FAFAFA",
    surface: "#FFFFFF",
    text: "#0B1020",
    muted: "#52525B",
    control: "#FFFFFF",
    control_text: "#0B1020",
    accent: "#F97316",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "moon",
    name: "辉月",
    bg: "#FAFAFA",
    surface: "#FFFFFF",
    text: "#0B1020",
    muted: "#52525B",
    control: "#FFFFFF",
    control_text: "#0B1020",
    accent: "#6366F1",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "ice",
    name: "冰痕",
    bg: "#FAFAFA",
    surface: "#FFFFFF",
    text: "#0B1020",
    muted: "#52525B",
    control: "#FFFFFF",
    control_text: "#0B1020",
    accent: "#06B6D4",
    accent_foreground: "#0B1020",
  },
];

type UiThemeCore = Pick<
  UiTheme,
  "id" | "bg" | "surface" | "accent" | "accent_foreground"
>;

// Legacy defaults shipped in v1.2.0 (kept for automatic migration only).
const LEGACY_THEMES_V120: UiThemeCore[] = [
  {
    id: "dawn",
    bg: "#FFFFFF",
    surface: "#FFF4CC",
    accent: "#EF4444",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "moon",
    bg: "#F3F4FF",
    surface: "#E0E7FF",
    accent: "#6366F1",
    accent_foreground: "#FFFFFF",
  },
  {
    id: "ice",
    bg: "#F0FDFF",
    surface: "#CCFBF1",
    accent: "#06B6D4",
    accent_foreground: "#0B1020",
  },
];

function themesMatchByIdAndColors(a: UiThemeCore[], b: UiThemeCore[]): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(b.map((t) => [t.id, t] as const));
  for (const t of a) {
    const other = map.get(t.id);
    if (!other) return false;
    if (t.bg !== other.bg) return false;
    if (t.surface !== other.surface) return false;
    if (t.accent !== other.accent) return false;
    if (t.accent_foreground !== other.accent_foreground) return false;
  }
  return true;
}

function maybeMigrateLegacyDefaults(themes: UiTheme[]): UiTheme[] {
  // If the user never customized themes (still the v1.2.0 built-ins), adopt the
  // reverted "classic" defaults so the UI updates automatically.
  const core = themes.map((t) => ({
    id: t.id,
    bg: t.bg,
    surface: t.surface,
    accent: t.accent,
    accent_foreground: t.accent_foreground,
  }));
  if (themesMatchByIdAndColors(core, LEGACY_THEMES_V120)) return DEFAULT_THEMES;
  return themes;
}

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

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const v = normalizeHexColor(hex);
  if (!v) return null;
  const r = Number.parseInt(v.slice(1, 3), 16);
  const g = Number.parseInt(v.slice(3, 5), 16);
  const b = Number.parseInt(v.slice(5, 7), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const toLinear = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pickReadableText(bgHex: string): string {
  const lum = relativeLuminance(bgHex);
  // A simple heuristic; good enough for auto-defaults and migrations.
  if (lum !== null && lum < 0.45) return "#FFFFFF";
  return "#0B1020";
}

function defaultMutedForText(textHex: string): string {
  // Keep muted readable on both light and dark themes.
  const lum = relativeLuminance(textHex);
  if (lum !== null && lum < 0.45) return "#A1A1AA";
  return "#52525B";
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
  const text = typeof raw.text === "string" ? normalizeHexColor(raw.text) : null;
  const muted =
    typeof raw.muted === "string" ? normalizeHexColor(raw.muted) : null;
  const control =
    typeof raw.control === "string" ? normalizeHexColor(raw.control) : null;
  const controlText =
    typeof raw.control_text === "string"
      ? normalizeHexColor(raw.control_text)
      : null;
  const accent =
    typeof raw.accent === "string" ? normalizeHexColor(raw.accent) : null;
  const accentFg =
    typeof raw.accent_foreground === "string"
      ? normalizeHexColor(raw.accent_foreground)
      : null;

  if (!id || !name || !bg || !surface || !accent || !accentFg) return null;

  const finalText = text ?? pickReadableText(surface);
  const finalMuted = muted ?? defaultMutedForText(finalText);
  const finalControl = control ?? surface;
  const finalControlText = controlText ?? pickReadableText(finalControl);

  return {
    id,
    name,
    bg,
    surface,
    text: finalText,
    muted: finalMuted,
    control: finalControl,
    control_text: finalControlText,
    accent,
    accent_foreground: accentFg,
  };
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
    const finalThemes = maybeMigrateLegacyDefaults(
      themes.length > 0 ? themes : DEFAULT_THEMES,
    );

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
            bg: "#FAFAFA",
            surface: "#FFFFFF",
            text: pickReadableText("#FFFFFF"),
            muted: defaultMutedForText(pickReadableText("#FFFFFF")),
            control: "#FFFFFF",
            control_text: pickReadableText("#FFFFFF"),
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
  document.documentElement.style.setProperty("--ui-text", theme.text);
  document.documentElement.style.setProperty("--ui-muted", theme.muted);
  document.documentElement.style.setProperty("--ui-control", theme.control);
  document.documentElement.style.setProperty(
    "--ui-control-text",
    theme.control_text,
  );
  document.documentElement.style.setProperty("--ui-accent", theme.accent);
  document.documentElement.style.setProperty(
    "--ui-accent-foreground",
    theme.accent_foreground,
  );
}
