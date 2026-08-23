import type { Config } from 'tailwindcss';

/**
 * SetValue's design tokens.
 *
 * The palette stays dark and restrained on purpose: card art supplies almost
 * all of the colour in this product, and a loud interface competes with it.
 * Accents are reserved for meaning — `need` is the money still to spend,
 * `have` is the money already on the shelf, `gold` marks a moment worth
 * remembering. Nothing decorative uses them.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#0A0D13',
          // Three surface levels, so nesting reads without extra borders.
          soft: '#11151F',
          raise: '#171C28',
          line: '#222A3A',
          edge: '#2E3850',
          mute: '#8A94A6',
          dim: '#5C6679',
        },
        need: { DEFAULT: '#FF8A3D', soft: '#FFB27A', deep: '#C25E1E' },
        have: { DEFAULT: '#2DD4A7', soft: '#7DE9CB', deep: '#159A78' },
        gold: { DEFAULT: '#FFC93C', soft: '#FFE08A' },
      },
      fontFamily: {
        num: ['var(--font-num)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: { xl2: '1.125rem', '4xl': '1.75rem' },
      boxShadow: {
        // Cards sit on the surface rather than floating: a tight ambient
        // shadow plus a hairline highlight, never a drop shadow.
        tile: '0 1px 0 0 rgba(255,255,255,.04) inset, 0 8px 24px -12px rgba(0,0,0,.9)',
        lift: '0 2px 0 0 rgba(255,255,255,.05) inset, 0 18px 40px -18px rgba(0,0,0,.95)',
        slot: '0 2px 10px -4px rgba(0,0,0,.8)',
      },
      keyframes: {
        pop: { '0%': { transform: 'scale(.94)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
        slideUp: { '0%': { transform: 'translateY(12px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // The moment a card lands in a slot.
        seat: {
          '0%': { transform: 'scale(.86)', opacity: '.4' },
          '60%': { transform: 'scale(1.04)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        glow: {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(45,212,167,0)' },
          '50%': { boxShadow: '0 0 0 6px rgba(45,212,167,.18)' },
        },
      },
      animation: {
        pop: 'pop .18s ease-out',
        slideUp: 'slideUp .22s cubic-bezier(.2,.8,.2,1)',
        seat: 'seat .34s cubic-bezier(.2,.9,.25,1)',
        glow: 'glow .9s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
