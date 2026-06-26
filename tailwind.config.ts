import type { Config } from "tailwindcss";

// Colors are backed by CSS variables defined in src/app/globals.css so the
// whole app re-themes between light/dark by flipping html[data-theme]. Brand /
// ink / surface use RGB channel triplets (rgb(var(--x) / <alpha-value>)) so the
// `/<opacity>` modifier keeps working; accent surfaces are plain colors.
const config: Config = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./src/**/*.{ts,tsx}", "./src/app/globals.css"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
        },
        ink: {
          50: "rgb(var(--ink-50) / <alpha-value>)",
          100: "rgb(var(--ink-100) / <alpha-value>)",
          200: "rgb(var(--ink-200) / <alpha-value>)",
          300: "rgb(var(--ink-300) / <alpha-value>)",
          400: "rgb(var(--ink-400) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          2: "rgb(var(--surface-2) / <alpha-value>)",
        },
        accent: {
          mint: { bg: "var(--mint-bg)", fg: "var(--mint-fg)", icon: "var(--mint-icon)" },
          sky: { bg: "var(--sky-bg)", fg: "var(--sky-fg)", icon: "var(--sky-icon)" },
          violet: { bg: "var(--violet-bg)", fg: "var(--violet-fg)", icon: "var(--violet-icon)" },
          amber: { bg: "var(--amber-bg)", fg: "var(--amber-fg)", icon: "var(--amber-icon)" },
          rose: { bg: "var(--rose-bg)", fg: "var(--rose-fg)", icon: "var(--rose-icon)" },
        },
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
        card: "var(--shadow-card)",
        lifted: "var(--shadow-lifted)",
        pill: "var(--shadow-pill)",
      },
      backgroundImage: {
        "brand-gradient": "var(--brand-gradient)",
        "insight-gradient": "var(--insight-gradient)",
        "page-gradient": "var(--page-gradient)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
