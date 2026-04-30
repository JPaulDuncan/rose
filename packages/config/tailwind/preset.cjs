/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        rose: {
          50: '#fff1f5',
          100: '#ffe0ea',
          200: '#ffc1d6',
          300: '#ff94b8',
          400: '#ff5c91',
          500: '#f8336d',
          600: '#e21858',
          700: '#bd0e48',
          800: '#9a0f3f',
          900: '#7d113a',
          950: '#46021a',
        },
        ink: {
          50: '#f7f7f8',
          100: '#eeeef1',
          200: '#d9dade',
          300: '#b6b8c0',
          400: '#888b96',
          500: '#6b6e7a',
          600: '#555863',
          700: '#444651',
          800: '#2c2e36',
          900: '#1a1b21',
          950: '#0f1014',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15,16,20,0.06), 0 4px 12px rgba(15,16,20,0.06)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'slide-up': {
          from: { opacity: 0, transform: 'translateY(8px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
