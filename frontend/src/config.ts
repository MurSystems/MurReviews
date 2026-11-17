// Single source of truth for brand, product name, and theme colours.
export const config = {
  brand: 'Mur Systems',
  product: 'Reviews by Mur Systems',
  workerUrl: 'https://m.mursystems123.workers.dev',
  theme: {
    background: '#ffffff',
    surface: '#f4f4f5',
    text: '#111111',
    textMuted: '#56565a',
    border: '#d4d4d8',
    accent: '#1d4ed8',
    accentContrast: '#ffffff',
    danger: '#dc2626',
    success: '#16a34a',
  },
} as const;
