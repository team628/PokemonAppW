import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0B0E14', soft: '#121722', line: '#1E2634', mute: '#8A94A6' },
        need: '#FF8A3D',
        have: '#2DD4A7',
        gold: '#FFC93C',
      },
      fontFamily: {
        num: ['var(--font-num)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        pop: { '0%': { transform: 'scale(0.94)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
        slideUp: { '0%': { transform: 'translateY(12px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        pop: 'pop .18s ease-out',
        slideUp: 'slideUp .22s cubic-bezier(.2,.8,.2,1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
