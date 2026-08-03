import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#4f46e5", soft: "#eef2ff", dark: "#4338ca" },
        ink: "#0f172a",
        muted: "#64748b",
        line: "#e2e8f0",
        paper: "#f8fafc",
      },
      fontSize: { "2xs": ["0.6875rem", "1rem"] },
    },
  },
  plugins: [],
} satisfies Config;
