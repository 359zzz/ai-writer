import type { Config } from "tailwindcss";

// NOTE:
// The app currently implements its own UI theme tokens (bg/surface/accent) via CSS
// variables + localStorage. Tailwind's default darkMode="media" can cause a mixed
// light/dark UI when the OS is in dark mode (dark: classes apply, but theme tokens
// remain light). We switch Tailwind to class-based dark mode so the UI stays
// consistent until we add an explicit in-app dark mode toggle.

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
