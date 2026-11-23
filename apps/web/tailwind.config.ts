import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#07070a', 900: '#0c0c11', 700: '#22222c' },
        screen: { DEFAULT: '#f5c451' },
        signal: { live: '#3ddc84', warn: '#ffb020', err: '#ff5d5d' },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      letterSpacing: { display: '-0.025em', title: '-0.015em', caption: '0.01em' },
      boxShadow: {
        material: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 12px 40px -12px rgba(0,0,0,0.7)',
        glow: '0 0 0 1px rgba(245,196,81,0.35), 0 8px 30px -8px rgba(245,196,81,0.35)',
      },
    },
  },
  plugins: [],
} satisfies Config;
