import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';

// rem is relative to the HOST page's <html> font-size (some sites use 62.5%), so the shadow-root CSS must not
// contain any. A few lines replace @thedutchcoder/postcss-rem-to-px (docs/EXTENSION_SPEC.md §6.3).
const remToPx = {
  postcssPlugin: 'wp-rem-to-px',
  Declaration(decl) {
    if (decl.value.includes('rem')) {
      decl.value = decl.value.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${Number(n) * 16}px`);
    }
  },
};

export default { plugins: [tailwindcss(), remToPx, autoprefixer()] };
