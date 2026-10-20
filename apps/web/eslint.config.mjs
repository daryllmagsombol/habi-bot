import base from '@habi/config/eslint/base.mjs';
import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
  ...base,
  ...nextVitals,
  { ignores: ['.next/**', 'next-env.d.ts'] },
];

export default config;
