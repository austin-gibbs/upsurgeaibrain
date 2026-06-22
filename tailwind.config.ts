import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "./src/app/globals.css"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          200: "#b8d0ff",
          500: "#2f6bff",
          600: "#1f54e6",
          700: "#1842b4",
        },
        ink: {
          50: "#f7f8fb",
          100: "#f1f3f8",
          200: "#e4e8f0",
          300: "#cdd4e0",
          400: "#94a0b4",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        accent: {
          mint: { bg: "#ecfdf5", fg: "#059669", icon: "#10b981" },
          sky: { bg: "#eff6ff", fg: "#2563eb", icon: "#3b82f6" },
          violet: { bg: "#f5f3ff", fg: "#7c3aed", icon: "#8b5cf6" },
          amber: { bg: "#fffbeb", fg: "#d97706", icon: "#f59e0b" },
          rose: { bg: "#fff1f2", fg: "#e11d48", icon: "#f43f5e" },
        },
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px rgba(15, 23, 42, 0.04)",
        card: "0 1px 3px rgba(15, 23, 42, 0.03), 0 8px 24px rgba(15, 23, 42, 0.06)",
        lifted:
          "0 2px 4px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.08)",
        pill: "0 1px 2px rgba(15, 23, 42, 0.06)",
      },
      backgroundImage: {
        "brand-gradient":
          "linear-gradient(135deg, #2f6bff 0%, #10b981 100%)",
        "insight-gradient":
          "linear-gradient(135deg, #1f54e6 0%, #0ea5e9 50%, #10b981 100%)",
        "page-gradient":
          "linear-gradient(180deg, #f7f8fb 0%, #f1f3f8 100%)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
