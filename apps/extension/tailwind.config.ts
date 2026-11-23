import type { Config } from 'tailwindcss';

// `important: '#wp-root'` scopes every utility under the mount point (shadow root in pages, a div in the popup),
// so utilities beat preflight resets and never match host-page nodes.
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  important: '#wp-root',
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      transitionTimingFunction: { sheet: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    },
  },
} satisfies Config;
