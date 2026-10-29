import plugin from 'tailwindcss/plugin.js';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {},
  },
  plugins: [
    plugin(function({ addUtilities, theme }) {
      addUtilities({
        '.scrollbar-thin-custom': {
          '&::-webkit-scrollbar': {
            width: '8px',
            height: '8px',
          },
          '&::-webkit-scrollbar-track': {
            background: '#f1f1f1',
          },
          '&::-webkit-scrollbar-thumb': {
            background: '#888',
            borderRadius: '10px',
          },
          '&::-webkit-scrollbar-thumb:hover': {
            background: '#555',
          },
        },

        /* Hide scrollbar on mobile */
        '@media (max-width: 768px)': {
          '.scrollbar-thin-custom::-webkit-scrollbar': {
            display: 'none',
          },
        },
      })
    })
  ],
}
