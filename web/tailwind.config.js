/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hive: {
          50: '#fff8ed',
          100: '#ffefd4',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
        },
        ink: {
          800: '#1a1d24',
          900: '#12141a',
          950: '#0b0d11',
        },
      },
      fontFamily: {
        // Tabular figures matter here: a column of amounts that doesn't line up
        // is a column people misread.
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
